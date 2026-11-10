/**
 * One Claude Code team-member run: a streaming-input Agent SDK query that
 * keeps taking turns while the member's inbox holds messages, then ends and
 * leaves a persisted Claude session that a later run resumes.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team/run
 */

import { randomUUID } from 'node:crypto'
import {
  query as officialQuery,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { claudeSpawnSpec, ManagedClaudeCodeProcess } from './process.ts'
import { InputQueue } from './queue.ts'

/** Claude Code permission modes that cannot wait for a human response. */
export const CLAUDE_CODE_PERMISSION_MODES = [
  'dontAsk',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
] as const satisfies readonly NonNullable<Options['permissionMode']>[]

/** Profile-selectable non-interactive Claude Code permission mode. */
export type ClaudeCodePermissionMode = typeof CLAUDE_CODE_PERMISSION_MODES[number]

/** MCP server name under which team tools reach Claude (`mcp__dsh_team__*`). */
export const TEAM_MCP_SERVER = 'dsh_team'

/** Fully resolved inputs for one member run. */
export interface TeamRunSpec {
  /** Absolute working directory for the CLI. */
  readonly cwd: string
  /** Native model; omitted to keep Claude settings. */
  readonly model?: string | undefined
  /** Claude session to continue; omitted for the member's first run. */
  readonly resume?: string | undefined
  readonly permissionMode: ClaudeCodePermissionMode
  /** Explicit environment layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Upper bound for one team-tool call, passed to the CLI as `MCP_TOOL_TIMEOUT`. */
  readonly toolTimeoutMs: number
  readonly disposeGraceMs: number
  /** Member identity and specialty appended to the Claude Code system prompt. */
  readonly systemPromptAppend: string
  /** In-process team tools bound to this member. */
  readonly teamServer: McpSdkServerConfigWithInstance
  /** Remove and return messages that arrived for the member; called at each turn end. */
  readonly takeInbox: () => readonly string[]
  /** Record the Claude session id once the CLI reports it. */
  readonly onSession: (sessionId: string) => void
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Build the SDK options for one member run.
 * @param spec - resolved member run inputs.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the managed CLI process synchronously.
 * @returns options that keep the session resumable and deny human prompts.
 */
export function teamQueryOptions(
  spec: TeamRunSpec,
  controller: AbortController,
  capture: (child: SubprocessHandle) => void,
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    ...spec.model === undefined ? {} : { model: spec.model },
    ...spec.resume === undefined ? {} : { resume: spec.resume },
    env: {
      ...scrubbedParentEnv(),
      MCP_TOOL_TIMEOUT: String(spec.toolTimeoutMs),
      ...spec.env,
    },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemPromptAppend },
    mcpServers: { [TEAM_MCP_SERVER]: spec.teamServer },
    allowedTools: [`mcp__${TEAM_MCP_SERVER}`],
    disallowedTools: spec.permissionMode === 'plan'
      ? ['AskUserQuestion', 'ExitPlanMode']
      : ['AskUserQuestion'],
    permissionMode: spec.permissionMode,
    ...spec.permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {
        canUseTool: () => Promise.resolve({
          behavior: 'deny' as const,
          message: 'This unattended Claude Code team member cannot request human approval.',
        }),
      },
    onElicitation: () => Promise.resolve({ action: 'decline' }),
    onUserDialog: () => Promise.resolve({ behavior: 'cancelled' as const }),
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      capture(child)
      return new ManagedClaudeCodeProcess(child)
    },
  }
}

/**
 * Consume the query, answering each turn end with queued inbox messages or
 * closing input when none remain.
 * @param messages - the published SDK message stream.
 * @param input - the query's streaming input.
 * @param spec - inbox and session callbacks.
 * @returns the final turn's answer as a completed result.
 */
export async function consumeTeamQuery(
  messages: AsyncIterable<SDKMessage>,
  input: InputQueue<SDKUserMessage>,
  spec: Pick<TeamRunSpec, 'takeInbox' | 'onSession'>,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const message of messages) {
    if (message.type === 'system' && message.subtype === 'init') {
      spec.onSession(message.session_id)
      continue
    }
    if (message.type !== 'result') continue
    if (message.subtype !== 'success' || message.is_error) {
      input.close()
      throw new Error(`subagent-claude-code-team: Claude Code turn ended with ${message.subtype}`)
    }
    answer = message.result
    const pending = spec.takeInbox()
    if (pending.length > 0) input.push(userMessage(pending.join('\n\n')))
    else input.close()
  }
  if (answer === undefined || answer.trim().length === 0) {
    throw new Error('subagent-claude-code-team: Claude Code finished without an answer')
  }
  return { output: [{ type: 'text', text: answer }], stopReason: 'completed' }
}

async function teardown(query: Query, child: SubprocessHandle | undefined): Promise<void> {
  try {
    query.close()
  } finally {
    if (child !== undefined) {
      child.terminate()
      await child.waitForExit()
      await child.done.catch(() => {})
    }
  }
}

/**
 * Start one member run and publish its handle.
 * @param prompt - the first user message of this run.
 * @param signal - the shared request's cancellation signal.
 * @param spec - resolved member run inputs.
 * @returns the published run; its result settles after the last turn.
 */
export function startTeamRun(prompt: string, signal: AbortSignal, spec: TeamRunSpec): SubagentRun {
  if (signal.aborted) {
    throw new Error('subagent-claude-code-team: request was aborted before SDK startup')
  }
  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code-team: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  signal.addEventListener('abort', onAbort, { once: true })
  const input = new InputQueue<SDKUserMessage>()
  input.push(userMessage(prompt))
  let child: SubprocessHandle | undefined
  let query: Query
  try {
    query = officialQuery({
      prompt: input,
      options: teamQueryOptions(spec, controller, (captured) => { child = captured }),
    })
  } catch (error: unknown) {
    signal.removeEventListener('abort', onAbort)
    requestCancel()
    input.close()
    throw new Error('subagent-claude-code-team: Claude Code failed to start', { cause: thrown(error) })
  }
  const published = query
  const result = settleRunResult({
    attempt: () => consumeTeamQuery(published, input, spec),
    collectOutput: () => [],
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal,
    onAbort,
  })
  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal,
    onAbort,
    requestCancel: () => {
      input.close()
      requestCancel()
    },
    teardown: () => teardown(published, child),
  })
}
