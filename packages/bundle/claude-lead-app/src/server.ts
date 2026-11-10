/**
 * MCP tools that let an external Claude Code session lead the team: spawn
 * agents, message them, list them, and read or wait for their messages.
 *
 * @module @deepseek-ai/dsh-claude-lead-app/server
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-subagent-claude-code-team'
import type { LeadInbox } from './lead-agent.ts'

/** Instructions the MCP client shows the lead model. */
export const LEAD_INSTRUCTIONS = [
  'You lead a team of agents. You are "lead".',
  'Use spawn_agent to start agents on self-contained tasks; they do not see your conversation.',
  'Their final answers and their messages to you arrive in your inbox: call wait_for_messages to block until something arrives, or check_inbox to read without waiting.',
  'Use send_message to message any agent by name, and list_agents to see names and status.',
  'Claude agents keep their conversation: send_message to a finished Claude agent resumes it, even when its completion notice says it cannot receive follow-up messages.',
].join(' ')

interface ToolText {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

async function guarded(body: () => Promise<string>): Promise<ToolText> {
  try {
    return { content: [{ type: 'text', text: await body() }] }
  } catch (error: unknown) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
  }
}

function drainText(inbox: LeadInbox): string {
  const messages = inbox.drain()
  if (messages.length === 0) return 'no new messages'
  return messages
    .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    .join('\n\n---\n\n')
}

/** Bounds for `wait_for_messages`, in seconds. */
export interface WaitBounds {
  readonly defaultSeconds: number
  readonly maxSeconds: number
}

/**
 * Build the lead's MCP server.
 * @param ctx - context carrying the team and subagent services.
 * @param lead - the lead's root Agent.
 * @param inbox - the lead Agent's inbox.
 * @param wait - default and maximum wait time.
 * @returns a server ready to connect to a transport.
 */
export function createLeadServer(ctx: Context, lead: Agent, inbox: LeadInbox, wait: WaitBounds): McpServer {
  const team = ctx.claudeTeam
  const server = new McpServer(
    { name: 'dsh-team', version: '0.2.2-rc.1' },
    { instructions: LEAD_INSTRUCTIONS },
  )
  const specialties = Object.keys(team.settings.specialties)
  const catalog = team.describeSpecialties()
  server.registerTool('spawn_agent', {
    description:
      'Start a background agent on a self-contained task and return its name. Its final answer arrives in your inbox. '
      + `Backend "claude" runs Claude Code; "dsh" runs a DeepSeek Harness agent and needs a configured Harness model. Default: ${team.settings.defaultBackend}.`
      + (catalog.length > 0 ? `\n\nSpecialties:\n${catalog}` : ''),
    inputSchema: {
      task: z.string().min(1).describe('Complete task for the new agent.'),
      description: z.string().min(1).describe('Short label for the task, 3-6 words.'),
      name: z.string().optional().describe('Optional name: 1-32 lower-case letters, digits, or hyphens starting with a letter, other than "lead".'),
      ...specialties.length === 0
        ? {}
        : { specialty: z.enum(specialties as [string, ...string[]]).optional().describe('Specialty from the list above.') },
      backend: z.enum(['dsh', 'claude']).optional().describe('Runtime for the agent.'),
      provider: z.string().optional().describe('Harness model provider for a dsh agent; requires model.'),
      model: z.string().optional().describe('Model id: a Claude model for a Claude agent, or a Harness model for a dsh agent.'),
    },
  }, (args, extra) => guarded(async () => {
    const spawned = await team.spawn(lead, undefined, {
      task: args.task,
      description: args.description,
      name: args.name,
      specialty: 'specialty' in args ? args.specialty : undefined,
      backend: args.backend,
      provider: args.provider,
      model: args.model,
      signal: extra.signal,
    })
    return `started ${spawned.backend} agent ${spawned.name}; its final answer will arrive in your inbox`
  }))
  server.registerTool('send_message', {
    description: 'Send a message to an agent by name. Returns delivery confirmation; replies arrive in your inbox.',
    inputSchema: {
      agent: z.string().min(1).describe('Agent name from list_agents.'),
      message: z.string().min(1).describe('Message to deliver.'),
    },
  }, (args, extra) => guarded(async () => {
    const member = team.memberOf(lead, args.agent)
    if (member !== undefined) {
      const delivery = await team.messageMember(member, 'lead', args.message, { kind: 'agent', agent: lead })
      return delivery === 'queued'
        ? `message delivered to agent ${args.agent}; it will read it while it works`
        : `message delivered to agent ${args.agent}; it resumed and its answer will arrive in your inbox`
    }
    const targetId = await ctx.subagents.resolveName(lead, args.agent, extra.signal)
    await ctx.subagents.sendMessage(lead, targetId, [{ type: 'text', text: args.message }], { signal: extra.signal })
    return `message delivered to agent ${args.agent}`
  }))
  server.registerTool('list_agents', {
    description: 'List the agents of your team with their names and status.',
  }, extra => guarded(() => team.describeAgents(lead, extra.signal)))
  server.registerTool('check_inbox', {
    description: 'Read and remove the messages and final answers that arrived since your last check, without waiting.',
  }, () => guarded(() => Promise.resolve(drainText(inbox))))
  server.registerTool('wait_for_messages', {
    description: 'Wait until a message or final answer arrives, then read and remove everything pending. Use this instead of polling check_inbox.',
    inputSchema: {
      timeout_seconds: z.number().int().min(1).max(wait.maxSeconds).optional()
        .describe(`How long to wait; defaults to ${wait.defaultSeconds}.`),
    },
  }, (args, extra) => guarded(async () => {
    const arrived = await inbox.waitForMessage((args.timeout_seconds ?? wait.defaultSeconds) * 1000, extra.signal)
    return arrived ? drainText(inbox) : 'no messages arrived before the timeout'
  }))
  return server
}
