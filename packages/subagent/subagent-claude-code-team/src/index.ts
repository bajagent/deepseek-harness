/**
 * Claude Code team members for a subagent tree. Registers a provider that runs
 * each Claude member as a resumable Claude Code session with in-process team
 * tools, plus the global `spawn_agent` and `message_claude_agent` tools.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertPositiveFinite } from '@deepseek-ai/dsh-subagent'
import { CLAUDE_CODE_PERMISSION_MODES, type ClaudeCodePermissionMode } from './run.ts'
import { ClaudeTeam, type Specialty, type TeamBackend, type TeamSettings } from './team.ts'
import { messageClaudeAgentTool, spawnAgentTool } from './tools.ts'

export type { ClaudeMember, Specialty, TeamBackend } from './team.ts'

export const name = 'subagent-claude-code-team'
export const inject = ['subagents', 'subprocess', 'tools', 'agents']

/** Deployment-owned team settings. */
export interface Config {
  /** Provider name on `ctx.subagents` for Claude members (default `claude-team`). */
  providerName?: string
  /** Provider that runs `dsh` children (default `spawn`). */
  dshProvider?: string
  /** Backend when neither the call nor its specialty chooses one (default `dsh`). */
  defaultBackend?: TeamBackend
  /** Claude model for members without a model choice; omitted keeps Claude settings. */
  model?: string
  /** Non-interactive Claude Code permission mode (default `dontAsk`). */
  permissionMode?: ClaudeCodePermissionMode
  /** Environment entries layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Upper bound in milliseconds for one Claude-side team-tool call, including `wait: true` spawns. */
  toolTimeoutMs?: number
  /** Grace in milliseconds between Claude Code termination tiers. */
  disposeGraceMs?: number
  /** Delegation-depth cap for `dsh` children; omitted reads the Host `subagent.maxDepth` setting. */
  maxDepth?: number
  /** How deep Claude members may nest under one another (default 2). */
  maxClaudeDepth?: number
  /** Named specialties offered to every spawning agent. */
  specialties?: Record<string, Specialty>
}

const BACKENDS = ['dsh', 'claude'] as const

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default('claude-team'),
  dshProvider: z.string().min(1).default('spawn'),
  defaultBackend: z.union([...BACKENDS]).default('dsh'),
  model: z.string().min(1),
  permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES]).default('dontAsk'),
  env: z.dict(z.string()).default({}),
  toolTimeoutMs: z.natural().min(1).default(3_600_000),
  disposeGraceMs: z.number().default(3_000),
  maxDepth: z.natural(),
  maxClaudeDepth: z.natural().min(1).default(2),
  specialties: z.dict(z.object({
    description: z.string().min(1).required(),
    instructions: z.string().min(1).required(),
    backend: z.union([...BACKENDS]),
    provider: z.string().min(1),
    model: z.string().min(1),
  })).default({}),
})

/**
 * Register the Claude member provider and the team tools.
 * @param ctx - context carrying subagent, subprocess, tool, and Agent services.
 * @param config - provider names, Claude defaults, depth limits, and specialties.
 */
export function apply(ctx: Context, config: Config): void {
  const settings: TeamSettings = {
    providerName: config.providerName ?? 'claude-team',
    dshProvider: config.dshProvider ?? 'spawn',
    defaultBackend: config.defaultBackend ?? 'dsh',
    model: config.model,
    permissionMode: config.permissionMode ?? 'dontAsk',
    env: config.env ?? {},
    toolTimeoutMs: config.toolTimeoutMs ?? 3_600_000,
    disposeGraceMs: config.disposeGraceMs ?? 3_000,
    maxDepth: config.maxDepth,
    maxClaudeDepth: config.maxClaudeDepth ?? 2,
    specialties: config.specialties ?? {},
  }
  assertPositiveFinite(name, 'disposeGraceMs', settings.disposeGraceMs)
  if (settings.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name}: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const [id, specialty] of Object.entries(settings.specialties)) {
    if ((specialty.provider === undefined) !== (specialty.model === undefined) && specialty.backend !== 'claude') {
      throw new Error(`${name}: specialty "${id}" must set provider and model together for dsh agents`)
    }
    if (specialty.backend === 'claude' && specialty.provider !== undefined) {
      throw new Error(`${name}: specialty "${id}" runs on Claude and cannot set a Harness provider`)
    }
  }
  const team = new ClaudeTeam(ctx, settings)
  ctx.effect(() => ctx.subagents.registerProvider(team.provider()), 'claude-team.provider')
  ctx.effect(() => ctx.tools.register(spawnAgentTool(team)), 'claude-team.spawn_agent')
  ctx.effect(() => ctx.tools.register(messageClaudeAgentTool(team, ctx)), 'claude-team.message_claude_agent')
  ctx.effect(() => () => { team.clear() }, 'claude-team.members')
}
