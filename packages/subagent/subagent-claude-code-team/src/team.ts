/**
 * The Claude Code team: registry of Claude members per subagent tree, the
 * resumable provider behind them, and the spawn and message operations that
 * both the Harness tools and the Claude-side team tools share.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team/team
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertUsableCwd,
  NO_START_CAPABILITIES,
  ROOT_AGENT_NAME,
  type ResolvedSubagentStartRequest,
  type SubagentActivation,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { createTeamServer } from './mcp.ts'
import { startTeamRun, type ClaudeCodePermissionMode } from './run.ts'

/** Which runtime executes a spawned agent. */
export type TeamBackend = 'dsh' | 'claude'

/** One configured specialty: instructions plus optional backend and model defaults. */
export interface Specialty {
  /** One line shown to models choosing a specialty. */
  description: string
  /** Instructions given to every agent spawned with this specialty. */
  instructions: string
  /** Runtime for this specialty; omitted lets the caller choose. */
  backend?: TeamBackend
  /** Harness model route provider for `dsh` agents; requires `model`. */
  provider?: string
  /** Model id: a Harness route model for `dsh` agents, a Claude model for `claude` agents. */
  model?: string
}

/** Resolved team settings shared by the provider and the tools. */
export interface TeamSettings {
  readonly providerName: string
  readonly dshProvider: string
  readonly defaultBackend: TeamBackend
  readonly model?: string | undefined
  readonly permissionMode: ClaudeCodePermissionMode
  readonly env: Record<string, string>
  readonly toolTimeoutMs: number
  readonly disposeGraceMs: number
  readonly maxDepth?: number | undefined
  readonly maxClaudeDepth: number
  readonly specialties: Readonly<Record<string, Specialty>>
}

/** Where a resumed member's answer goes. */
export type ReplyTarget =
  | { readonly kind: 'agent'; readonly agent: Agent }
  | { readonly kind: 'member'; readonly member: ClaudeMember }

/** One Claude Code member of a subagent tree. */
export interface ClaudeMember {
  readonly name: string
  readonly rootId: SessionId
  /** Harness Agent that owns this member's runs; children the member spawns are created under it. */
  readonly host: Agent
  /** Claude nesting depth: 1 when a Harness agent started the member. */
  readonly depth: number
  /** Who started the member; answers to turns no message asked for go here. */
  readonly requester: ReplyTarget
  readonly instructions?: string | undefined
  readonly model?: string | undefined
  /** Claude session id once the first run reported it. */
  claudeSessionId?: string
  /** Shared-runtime id of the current or latest run. */
  runId?: SessionId
  /** Whether a run is starting or working. */
  busy: boolean
  /** Messages waiting for the member's next turn. */
  readonly inbox: InboxEntry[]
}

interface InboxEntry {
  readonly text: string
  /** Where the answer to this message goes when it wakes an idle member. */
  readonly replyTo: ReplyTarget
}

/** Spawn request shared by both tool surfaces. */
export interface SpawnRequest {
  readonly task: string
  readonly description: string
  readonly name?: string | undefined
  readonly specialty?: string | undefined
  readonly backend?: TeamBackend | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly signal: AbortSignal
}

/** What a started spawn reports back. */
export interface Spawned {
  readonly name: string
  readonly backend: TeamBackend
  readonly activation: SubagentActivation
}

interface Launch {
  readonly member: ClaudeMember
}

const LAUNCH_MARKER = /^\[\[claude-team-launch:([0-9a-f-]{36})\]\]$/
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Join a result's text blocks for delivery to another agent.
 * @param result - a settled subagent result.
 * @returns the answer text, or the stop reason and diagnostic when there is none.
 */
export function resultText(result: SubagentResult): string {
  const text = result.output
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
    .trim()
  if (result.stopReason === 'completed' && text.length > 0) return text
  const detail = result.diagnostic === undefined ? '' : ` ${result.diagnostic}`
  return `${text.length > 0 ? `${text}\n\n` : ''}(stopped: ${result.stopReason}${detail})`
}

function promptText(prompt: readonly ContentBlock[]): string {
  return prompt.map((block) => {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code-team: Claude Code tasks must contain only text')
    }
    return block.text
  }).join('')
}

/** Owner of every Claude member in this composition. */
export class ClaudeTeam {
  private readonly members = new Map<string, ClaudeMember>()
  private readonly launches = new Map<string, Launch>()

  constructor(
    private readonly ctx: Context,
    readonly settings: TeamSettings,
  ) {}

  /** Forget every member and pending launch; runs stay owned by the subagent runtime. */
  clear(): void {
    this.members.clear()
    this.launches.clear()
  }

  /**
   * Find a member of the caller's tree by name or by a path ending in its name.
   * @param caller - live Agent whose tree is searched.
   * @param reference - member name, or a slash-separated path ending in it.
   * @returns the member, or undefined.
   */
  memberOf(caller: Agent, reference: string): ClaudeMember | undefined {
    const rootId = this.ctx.subagents.rootOf(caller).id
    const name = reference.split('/').at(-1) ?? reference
    return this.members.get(`${rootId}/${name}`)
  }

  /**
   * List the Claude members of a tree.
   * @param rootId - the tree root's Session id.
   * @returns members in creation order.
   */
  membersOf(rootId: SessionId): ClaudeMember[] {
    return [...this.members.values()].filter(member => member.rootId === rootId)
  }

  /** The shared-runtime provider that runs Claude members. */
  provider(): SubagentProvider {
    const capabilities: SubagentCapabilities = NO_START_CAPABILITIES
    return {
      name: this.settings.providerName,
      capabilities,
      inheritsParentContext: false,
      start: request => Promise.resolve(this.startRun(request)),
    }
  }

  /**
   * Spawn a Harness or Claude agent under a host Agent.
   * @param host - the Harness Agent that owns the child.
   * @param caller - `host` itself, or the Claude member asking on its behalf.
   * @param request - task, naming, specialty, and route choices.
   * @returns the started child's name, backend, and activation.
   */
  async spawn(host: Agent, caller: ClaudeMember | undefined, request: SpawnRequest): Promise<Spawned> {
    const specialty = this.specialty(request.specialty)
    const backend = specialty?.backend ?? request.backend ?? this.settings.defaultBackend
    if (specialty?.backend !== undefined && request.backend !== undefined && request.backend !== specialty.backend) {
      throw new Error(`specialty "${request.specialty}" always runs on the ${specialty.backend} backend`)
    }
    // A Harness caller receives the completion notice from the runtime; a
    // Claude caller receives it in its inbox.
    const delivery = caller === undefined ? 'parent' : 'caller'
    if (backend === 'dsh') {
      const provider = request.provider ?? specialty?.provider
      const model = request.model ?? specialty?.model
      if ((provider === undefined) !== (model === undefined)) {
        throw new Error('provider and model must be given together for a dsh agent')
      }
      const task = specialty === undefined
        ? request.task
        : `${specialty.instructions}\n\n## Task\n\n${request.task}`
      const maxDepth = this.ctx.subagents.resolveMaxDepth(this.settings.maxDepth)
      const activation = await this.ctx.subagents.startActivation({
        provider: this.settings.dshProvider,
        parent: host,
        label: request.description,
        ...request.name === undefined ? {} : { name: request.name },
        prompt: [{ type: 'text', text: task }],
        ...provider === undefined || model === undefined ? {} : { agentOptions: { provider, model } },
        ...maxDepth === undefined ? {} : { maxDepth },
        signal: request.signal,
        delivery,
      })
      if (caller !== undefined) this.forwardResult(activation, activation.name, { kind: 'member', member: caller })
      return { name: activation.name, backend, activation }
    }
    if (request.provider !== undefined) {
      throw new Error('provider applies only to dsh agents; Claude agents take a Claude model id')
    }
    const depth = (caller?.depth ?? 0) + 1
    if (depth > this.settings.maxClaudeDepth) {
      throw new Error(`Claude agents may nest at most ${this.settings.maxClaudeDepth} deep`)
    }
    const rootId = this.ctx.subagents.rootOf(host).id
    const name = request.name ?? this.nextName(rootId)
    if (!AGENT_NAME.test(name) || name === ROOT_AGENT_NAME) {
      throw new Error('agent names are 1-32 lower-case letters, digits, or hyphens starting with a letter, other than "lead"')
    }
    const key = `${rootId}/${name}`
    if (this.members.has(key)) throw new Error(`a Claude agent named "${name}" already exists in this team`)
    const member: ClaudeMember = {
      name,
      rootId,
      host,
      depth,
      requester: caller === undefined ? { kind: 'agent', agent: host } : { kind: 'member', member: caller },
      instructions: specialty?.instructions,
      model: request.model ?? specialty?.model ?? this.settings.model,
      busy: true,
      inbox: [],
    }
    this.members.set(key, member)
    try {
      const activation = await this.launch(member, request.description, request.task, delivery, request.signal)
      if (caller !== undefined) this.forwardResult(activation, name, { kind: 'member', member: caller })
      return { name, backend, activation }
    } catch (error: unknown) {
      this.members.delete(key)
      throw error
    }
  }

  /**
   * Deliver a message to a Claude member: queue it while the member works,
   * otherwise resume its Claude session with it.
   * @param member - the recipient.
   * @param from - the sender's model-facing name.
   * @param text - message body.
   * @param replyTo - where the answer goes if this message wakes the member.
   * @returns whether the message was queued for a working member or woke an idle one.
   */
  messageMember(member: ClaudeMember, from: string, text: string, replyTo: ReplyTarget): Promise<'queued' | 'resumed'> {
    return this.enqueue(member, {
      text: `Agent "${from}" sent a message (reply with send_message to "${from}" if a reply is needed):\n${text}`,
      replyTo,
    })
  }

  private async enqueue(member: ClaudeMember, entry: InboxEntry): Promise<'queued' | 'resumed'> {
    if (member.busy) {
      member.inbox.push(entry)
      return 'queued'
    }
    await this.resume(member, [entry])
    return 'resumed'
  }

  /**
   * Deliver a message from a Claude member to a Harness agent in its tree.
   * @param member - the sender.
   * @param reference - `lead`, a full agent name, or a Session id.
   * @param text - message body.
   * @param signal - cancellation before delivery.
   */
  async messageAgent(member: ClaudeMember, reference: string, text: string, signal: AbortSignal): Promise<void> {
    const root = this.ctx.subagents.rootOf(member.host)
    const targetId = await this.ctx.subagents.resolveName(member.host, reference, signal)
    if (targetId !== root.id) {
      const descendants = await this.ctx.subagents.listDescendants(root.id, signal)
      if (!descendants.some(entry => entry.kind === 'child' && entry.id === targetId)) {
        throw new Error(`agent "${reference}" is not a member of this team; use list_agents to see the names`)
      }
    }
    const content: ContentBlock[] = [{ type: 'text', text: `Agent ${member.name} sent a message: ${text}` }]
    const live = this.ctx.agents.get(targetId)
    if (live !== undefined) {
      live.steer(createUserMessage({ content, source: this.messageSource(member) }))
      return
    }
    if (targetId === member.host.id) throw new Error(`agent "${reference}" is not running`)
    await this.ctx.subagents.sendMessage(member.host, targetId, content, { signal })
  }

  /**
   * Render a tree's agents for a model.
   * @param host - any live Agent of the tree.
   * @param signal - cancellation for catalog reads.
   * @returns one line per agent.
   */
  async describeAgents(host: Agent, signal: AbortSignal): Promise<string> {
    const root = this.ctx.subagents.rootOf(host)
    const lines = [`- ${ROOT_AGENT_NAME} (root agent)`]
    const memberNames = new Set(this.membersOf(root.id).map(member => member.name))
    for (const entry of await this.ctx.subagents.listDescendants(root.id, signal)) {
      if (entry.kind !== 'child') continue
      const name = entry.path ?? entry.id
      if (memberNames.has(name.split('/').at(-1) ?? name)) continue
      const label = entry.label === undefined ? '' : ` — ${entry.label}`
      lines.push(`- ${name} (dsh agent, ${entry.activity})${label}`)
    }
    for (const member of this.membersOf(root.id)) {
      lines.push(`- ${member.name} (Claude agent, ${member.busy ? 'working' : 'idle'})`)
    }
    return lines.join('\n')
  }

  /**
   * Render the specialty catalog for tool descriptions.
   * @returns one line per specialty, or an empty string.
   */
  describeSpecialties(): string {
    return Object.entries(this.settings.specialties)
      .map(([id, specialty]) => {
        const backend = specialty.backend === undefined ? '' : ` (${specialty.backend})`
        return `- ${id}${backend}: ${specialty.description}`
      })
      .join('\n')
  }

  private specialty(id: string | undefined): Specialty | undefined {
    if (id === undefined) return undefined
    const specialty = this.settings.specialties[id]
    if (specialty === undefined) {
      const known = Object.keys(this.settings.specialties).join(', ')
      throw new Error(`unknown specialty "${id}"${known.length > 0 ? `; known specialties: ${known}` : ''}`)
    }
    return specialty
  }

  private nextName(rootId: SessionId): string {
    for (let index = 1; ; index++) {
      const name = `claude-${index}`
      if (!this.members.has(`${rootId}/${name}`)) return name
    }
  }

  private messageSource(member: ClaudeMember) {
    return {
      kind: 'agent-message' as const,
      form: 'relay' as const,
      senderSessionId: member.runId ?? member.host.id,
    }
  }

  /** Start one activation of a member, passing the launch through the prompt marker. */
  private launch(
    member: ClaudeMember,
    label: string,
    text: string,
    delivery: 'parent' | 'caller',
    signal: AbortSignal,
  ): Promise<SubagentActivation> {
    const token = randomUUID()
    this.launches.set(token, { member })
    const started = this.ctx.subagents.startActivation({
      provider: this.settings.providerName,
      parent: member.host,
      label,
      // Only parent-delivered external runs are cataloged under a name.
      ...delivery === 'parent' ? { name: member.name } : {},
      prompt: [
        { type: 'text', text: `[[claude-team-launch:${token}]]` },
        { type: 'text', text },
      ],
      signal,
      delivery,
    })
    void started.then((activation) => {
      void activation.result.then(
        () => { this.settle(member) },
        () => { this.settle(member) },
      )
    }, () => {
      this.launches.delete(token)
      member.busy = false
    })
    return started
  }

  /** Resume an idle member's Claude session with queued messages. */
  private async resume(member: ClaudeMember, entries: readonly InboxEntry[]): Promise<void> {
    member.busy = true
    // The first entry's recipient receives the answer; later senders were told to expect send_message replies.
    const replyTo = entries[0]?.replyTo ?? member.requester
    try {
      const activation = await this.launch(
        member,
        `message to ${member.name}`,
        entries.map(entry => entry.text).join('\n\n'),
        'caller',
        new AbortController().signal,
      )
      this.forwardResult(activation, member.name, replyTo)
    } catch (error: unknown) {
      member.busy = false
      throw error
    }
  }

  /** After a run settles, wake the member again for messages that arrived as it finished. */
  private settle(member: ClaudeMember): void {
    member.busy = false
    const pending = member.inbox.splice(0)
    if (pending.length === 0) return
    this.resume(member, pending).catch((error: unknown) => {
      this.ctx.logger.warn(`subagent-claude-code-team: could not resume "${member.name}": %o`, error)
    })
  }

  /** Deliver a caller-delivered activation's answer to its recipient. */
  private forwardResult(activation: SubagentActivation, name: string, target: ReplyTarget): void {
    activation.result.then((result) => {
      const text = `Agent "${name}" finished:\n${resultText(result)}`
      if (target.kind === 'member') {
        // A finished child wakes its requester, whose answer goes up the chain, never back to the child.
        void this.enqueue(target.member, { text, replyTo: target.member.requester }).catch((error: unknown) => {
          this.ctx.logger.warn(`subagent-claude-code-team: could not deliver to "${target.member.name}": %o`, error)
        })
        return
      }
      target.agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: activation.childId },
      }))
    }, (error: unknown) => {
      this.ctx.logger.warn(`subagent-claude-code-team: result of "${name}" was lost: %o`, error)
    })
  }

  private startRun(request: ResolvedSubagentStartRequest): SubagentRun {
    const [first, ...rest] = request.prompt
    const token = first?.type === 'text' ? LAUNCH_MARKER.exec(first.text)?.[1] : undefined
    const launch = token === undefined ? undefined : this.launches.get(token)
    if (token !== undefined) this.launches.delete(token)
    if (launch === undefined) {
      throw new Error(`subagent-claude-code-team: start Claude agents with spawn_agent, not the "${this.settings.providerName}" provider directly`)
    }
    const { member } = launch
    const cwd = assertUsableCwd('subagent-claude-code-team', 'child cwd', request.cwd)
    const run = startTeamRun(promptText(rest), request.signal, {
      cwd,
      model: member.model,
      resume: member.claudeSessionId,
      permissionMode: this.settings.permissionMode,
      env: this.settings.env,
      toolTimeoutMs: this.settings.toolTimeoutMs,
      disposeGraceMs: this.settings.disposeGraceMs,
      systemPromptAppend: this.identity(member),
      teamServer: createTeamServer(this, member),
      takeInbox: () => member.inbox.splice(0).map(entry => entry.text),
      onSession: (sessionId) => { member.claudeSessionId = sessionId },
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`subagent-claude-code-team "${member.name}": run failed (${stopReason}): %o`, error)
      },
    })
    member.runId = run.id
    return run
  }

  private identity(member: ClaudeMember): string {
    const hostName = this.ctx.subagents.namesOf(member.host).self
    const specialties = this.describeSpecialties()
    const sections = [
      `You are Claude agent "${member.name}", a member of a multi-agent team. The team's root agent is "${ROOT_AGENT_NAME}"; you were started on behalf of agent "${hostName}".`,
      'Your final answer is delivered automatically to whoever started you or sent you the message you are answering. Include the result and the evidence for it in that answer.',
      [
        'Team tools:',
        '- spawn_agent: start another agent, either a dsh agent or another Claude agent, with an optional specialty and model.',
        '- send_message: message any agent by name, including "lead".',
        '- list_agents: list the team\'s agents and their names.',
        '- check_inbox: read messages other agents sent you while you work. Unread messages are also delivered after you finish a turn.',
      ].join('\n'),
    ]
    if (specialties.length > 0) sections.push(`Available specialties:\n${specialties}`)
    if (member.instructions !== undefined) sections.push(`## Your specialty\n\n${member.instructions}`)
    return sections.join('\n\n')
  }
}
