/**
 * The live team view: a token-protected localhost HTTP server that serves a
 * Sims-style page and JSON snapshots of who is working, coordinating,
 * waiting, or idle, plus the team's event feed and task board.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team/view
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ROOT_AGENT_NAME } from '@deepseek-ai/dsh-subagent'
import { describeTool, type AgentActivity, type AgentState, type TeamEvent } from './activity.ts'
import type { BoardTask, ClaudeTeam } from './team.ts'
import { TEAM_VIEW_PAGE } from './view-page.ts'

/** One agent as the view draws it. */
export interface ViewAgent {
  readonly name: string
  readonly kind: 'lead' | 'dsh' | 'claude'
  readonly parent?: string | undefined
  readonly state: AgentState
  readonly detail: string
  readonly since: number
}

/** Everything the view needs to draw one team. */
export interface ViewSnapshot {
  readonly root: string
  readonly now: number
  readonly agents: readonly ViewAgent[]
  readonly events: readonly TeamEvent[]
  readonly tasks?: readonly BoardTask[] | undefined
  readonly viewUrl?: string | undefined
}

/** How long a coordination activity shows before a busy agent reads as working again. */
const COORDINATION_SHOWN_MS = 8_000
/** How many feed events one snapshot carries. */
const SNAPSHOT_EVENTS = 60
/** How many successive ports to try when the configured one is taken. */
const PORT_ATTEMPTS = 20

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || !(key in input)) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? ROOT_AGENT_NAME : path.slice(0, slash)
}

/**
 * Settle a running agent's displayed activity: recent coordination stays,
 * older coordination and idle reads become working.
 */
function whileRunning(tracked: AgentActivity | undefined, now: number): Pick<ViewAgent, 'state' | 'detail' | 'since'> {
  if (tracked === undefined || tracked.state === 'idle' || tracked.state === 'error') {
    return { state: 'working', detail: 'Thinking', since: tracked?.since ?? now }
  }
  if (tracked.state === 'coordinating' && now - tracked.since > COORDINATION_SHOWN_MS) {
    return { state: 'working', detail: 'Thinking', since: tracked.since }
  }
  return tracked
}

/** Builds snapshots and records Harness agents' tool activity. */
export class TeamView {
  constructor(
    private readonly ctx: Context,
    private readonly team: ClaudeTeam,
  ) {}

  /**
   * Record what a Harness agent's tool call says about its activity.
   * @param agent - the calling Agent.
   * @param name - tool name.
   * @param args - tool arguments.
   * @returns the agent's root and name, or undefined outside a subagent tree.
   */
  observeTool(agent: Agent, name: string, args: unknown): { rootId: SessionId; self: string } | undefined {
    let rootId: SessionId
    let self: string
    try {
      rootId = this.ctx.subagents.rootOf(agent).id
      self = this.ctx.subagents.namesOf(agent).self
    } catch {
      return undefined
    }
    const { state, detail } = describeTool(name, args)
    this.team.activity.set(rootId, self, state, detail)
    // The team's own tools record their events where they act.
    if (name === 'send_message') {
      this.team.activity.record(rootId, { kind: 'message', from: self, to: field(args, 'agent'), text: field(args, 'message') ?? '' })
    } else if (name === 'subagent' || name === 'subagent_fork') {
      this.team.activity.record(rootId, { kind: 'spawn', from: self, to: field(args, 'name'), text: field(args, 'description') ?? '' })
    }
    return { rootId, self }
  }

  /**
   * List teams that recorded events, most recent first.
   * @returns root ids with agent counts.
   */
  teams(): { root: string; agents: number }[] {
    return this.team.activity.roots().map(root => ({ root, agents: this.team.membersOf(root).length }))
  }

  /**
   * Snapshot one team.
   * @param rootId - the team's root Session id.
   * @param signal - cancellation for catalog reads.
   * @returns agents, recent events, and the task board when it is on.
   */
  async snapshot(rootId: SessionId, signal: AbortSignal): Promise<ViewSnapshot> {
    const now = Date.now()
    const activity = this.team.activity
    const root = this.ctx.agents.get(rootId)
    const members = this.team.membersOf(rootId)
    const memberNames = new Set(members.map(member => member.name))
    const leadTracked = activity.get(rootId, ROOT_AGENT_NAME)
    const agents: ViewAgent[] = [{
      name: ROOT_AGENT_NAME,
      kind: 'lead',
      ...root?.status === 'running'
        ? whileRunning(leadTracked, now)
        : leadTracked?.state === 'waiting' || leadTracked?.state === 'coordinating'
          ? leadTracked
          : { state: 'idle' as const, detail: 'Talking with you', since: leadTracked?.since ?? now },
    }]
    for (const entry of await this.ctx.subagents.listDescendants(rootId, signal)) {
      if (entry.kind !== 'child') continue
      const name = entry.path ?? entry.id
      if (memberNames.has(name.split('/').at(-1) ?? name)) continue
      const tracked = activity.get(rootId, name)
      const running = entry.activity === 'running'
      agents.push({
        name,
        kind: 'dsh',
        parent: parentOf(name),
        ...running
          ? whileRunning(tracked, now)
          : { state: 'idle' as const, detail: 'Taking a break', since: tracked?.since ?? now },
      })
    }
    for (const member of members) {
      const tracked = activity.get(rootId, member.name)
      const requester = member.requester.kind === 'member'
        ? member.requester.member.name
        : this.ctx.subagents.namesOf(member.requester.agent).self
      agents.push({
        name: member.name,
        kind: 'claude',
        parent: requester,
        ...member.busy
          ? whileRunning(tracked, now)
          : tracked?.state === 'error'
            ? tracked
            : { state: 'idle' as const, detail: 'Taking a break', since: tracked?.since ?? now },
      })
    }
    let tasks: BoardTask[] | undefined
    if (root !== undefined) {
      try {
        tasks = this.team.boardTasks(root)
      } catch {
        tasks = undefined
      }
    }
    return {
      root: rootId,
      now,
      agents,
      events: activity.eventsOf(rootId).slice(-SNAPSHOT_EVENTS),
      tasks,
      viewUrl: this.team.viewUrl,
    }
  }
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}

function tokenMatches(expected: Buffer, supplied: string | null): boolean {
  if (supplied === null) return false
  const candidate = Buffer.from(supplied)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

/**
 * Serve the view on 127.0.0.1, trying successive ports when one is taken.
 * @param view - snapshot builder.
 * @param port - first port to try.
 * @param log - receives non-fatal request failures.
 * @returns the listening server and its tokenized URL.
 */
export async function serveTeamView(
  view: TeamView,
  port: number,
  log: (error: unknown) => void,
): Promise<{ server: Server; url: string }> {
  const token = randomBytes(18).toString('base64url')
  const expected = Buffer.from(token)
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET') {
      send(response, 405, 'text/plain', 'method not allowed')
    } else if (!tokenMatches(expected, url.searchParams.get('token'))) {
      send(response, 403, 'text/plain', 'forbidden')
    } else if (url.pathname === '/') {
      send(response, 200, 'text/html; charset=utf-8', TEAM_VIEW_PAGE)
    } else if (url.pathname === '/api/teams') {
      send(response, 200, 'application/json', JSON.stringify(view.teams()))
    } else if (url.pathname === '/api/team') {
      const root = url.searchParams.get('root')
      if (root === null) {
        send(response, 400, 'text/plain', 'root is required')
      } else {
        const snapshot = await view.snapshot(brandString<SessionId>(root), AbortSignal.timeout(5_000))
        send(response, 200, 'application/json', JSON.stringify(snapshot))
      }
    } else {
      send(response, 404, 'text/plain', 'not found')
    }
  }
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const server = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        log(error)
        if (!response.headersSent) send(response, 500, 'text/plain', 'snapshot failed')
      })
    })
    const listening = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve(false)
        else reject(error)
      })
      server.listen(port + attempt, '127.0.0.1', () => { resolve(true) })
    })
    if (listening) {
      return { server, url: `http://127.0.0.1:${port + attempt}/?token=${token}` }
    }
  }
  throw new Error(`no free port for the team view in ${port}-${port + PORT_ATTEMPTS - 1}`)
}
