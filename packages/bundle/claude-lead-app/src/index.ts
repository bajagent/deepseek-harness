/**
 * The Claude lead profile's app: serves team tools over MCP stdio so an
 * external Claude Code session leads a Claude Code team. The session is
 * represented in the subagent tree by a root Agent that never drives a model.
 *
 * @module @deepseek-ai/dsh-claude-lead-app
 */

import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createLeadAgent, LeadInbox } from './lead-agent.ts'
import { createLeadServer } from './server.ts'

/** Stable Cordis plugin name. */
export const name = 'claude-lead'

export const inject = ['cmdlineArgs', 'claudeTeam', 'agents', 'sessions', 'subagents']

/** Wait bounds for the lead's `wait_for_messages` tool. */
export interface Config {
  /** Seconds `wait_for_messages` waits when the call gives no timeout (default 600). */
  waitDefaultSeconds?: number
  /** Longest wait a call may request, in seconds (default 3600). */
  waitMaxSeconds?: number
  /** Turn on the shared task board for each new lead (default true). */
  taskBoard?: boolean
}

export const Config: z<Config> = z.object({
  waitDefaultSeconds: z.natural().min(1).default(600),
  waitMaxSeconds: z.natural().min(1).default(3600),
  taskBoard: z.boolean().default(true),
})

function leadCommand(): Command {
  return new Command()
    .name('dsh --profile claude-lead')
    .description('Serve Claude Code team tools to a Claude Code session over MCP stdio.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  claude mcp add dsh-team -- dsh --profile claude-lead
`)
}

/**
 * Accept the invocation, register the lead Agent, and serve MCP on stdio
 * until the client disconnects.
 * @param ctx - context carrying the launcher, team, Agent, Session, and subagent services.
 * @param config - wait bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const wait = {
    defaultSeconds: config.waitDefaultSeconds ?? 600,
    maxSeconds: config.waitMaxSeconds ?? 3600,
  }
  if (wait.defaultSeconds > wait.maxSeconds) {
    throw new Error(`${name}: waitDefaultSeconds must not exceed waitMaxSeconds`)
  }
  const program = leadCommand()
  program.action(() => { serve(ctx, wait, config.taskBoard !== false) })
  parseCmdline(ctx, program)
}

/** Register the lead Agent and serve MCP on stdio until the client disconnects. */
function serve(ctx: Context, wait: { readonly defaultSeconds: number; readonly maxSeconds: number }, taskBoard: boolean): void {
  exitOnStdinEnd(ctx, 'claude-lead.stdin')
  const inbox = new LeadInbox()
  const session = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd: process.cwd() } })
  const lead = createLeadAgent(ctx, session, inbox)
  ctx.agents.register(lead)
  ctx.claudeTeam.activity.record(lead.id, { kind: 'spawn', from: 'lead', text: 'moved in' })
  if (taskBoard) {
    // The board service may start after this app; turn it on once it is available.
    ctx.inject(['agentTeams'], (teamsCtx) => {
      teamsCtx.agentTeams.setEnabled(lead, true).catch((error: unknown) => {
        ctx.logger.warn('claude-lead: could not turn on the task board: %o', error)
      })
    })
  }
  const server = createLeadServer(ctx, lead, inbox, wait)
  ctx.effect(() => {
    server.connect(new StdioServerTransport()).catch((error: unknown) => {
      ctx.logger.warn('claude-lead: MCP transport failed: %o', error)
    })
    return async () => {
      await ctx.subagents.drainDescendants([lead])
      await server.close()
    }
  }, 'claude-lead.server')
}
