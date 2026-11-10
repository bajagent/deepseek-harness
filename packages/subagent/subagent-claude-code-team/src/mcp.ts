/**
 * Claude-side team tools: an in-process MCP server bound to one Claude
 * member, through which it spawns agents, messages teammates, lists the team,
 * and reads its inbox.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team/mcp
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TEAM_MCP_SERVER } from './run.ts'
import { resultText, type ClaudeMember, type ClaudeTeam } from './team.ts'

interface ToolText {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function text(value: string): ToolText {
  return { content: [{ type: 'text', text: value }] }
}

async function guarded(body: () => Promise<string>): Promise<ToolText> {
  try {
    return text(await body())
  } catch (error: unknown) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true }
  }
}

/**
 * Build the team MCP server for one member run.
 * @param team - the owning team.
 * @param member - the Claude member these tools act for.
 * @returns an SDK server config that runs every handler in this process.
 */
export function createTeamServer(team: ClaudeTeam, member: ClaudeMember): McpSdkServerConfigWithInstance {
  const specialties = Object.keys(team.settings.specialties)
  const spawnAgent = tool(
    'spawn_agent',
    'Start another agent on a self-contained task. It does not see your conversation, so give it everything it needs. '
    + 'With wait=false (the default) this returns at once and the agent\'s final answer arrives in your inbox; '
    + 'with wait=true this call returns the final answer.',
    {
      task: z.string().min(1).describe('Complete task for the new agent.'),
      description: z.string().min(1).describe('Short label for the task, 3-6 words.'),
      name: z.string().optional().describe('Optional name: 1-32 lower-case letters, digits, or hyphens starting with a letter.'),
      ...specialties.length === 0
        ? {}
        : { specialty: z.enum(specialties as [string, ...string[]]).optional().describe('Specialty from the system prompt list.') },
      backend: z.enum(['dsh', 'claude']).optional().describe('dsh for a DeepSeek Harness agent, claude for another Claude Code agent.'),
      provider: z.string().optional().describe('Harness model provider for a dsh agent; requires model.'),
      model: z.string().optional().describe('Model id: a Harness model for a dsh agent, or a Claude model for a Claude agent.'),
      wait: z.boolean().optional().describe('Wait for the final answer instead of receiving it in your inbox.'),
    },
    (args, _extra) => guarded(async () => {
      const controller = new AbortController()
      const spawned = await team.spawn(member.host, member, {
        task: args.task,
        description: args.description,
        name: args.name,
        specialty: 'specialty' in args ? args.specialty : undefined,
        backend: args.backend,
        provider: args.provider,
        model: args.model,
        signal: controller.signal,
      })
      if (args.wait !== true) {
        return `started ${spawned.backend} agent ${spawned.name}; its final answer will arrive in your inbox`
      }
      return `Agent "${spawned.name}" finished:\n${resultText(await spawned.activation.result)}`
    }),
  )
  const sendMessage = tool(
    'send_message',
    'Send a message to another agent of the team by name, including "lead". Returns delivery confirmation, not a reply; replies arrive in your inbox.',
    {
      agent: z.string().min(1).describe('Agent name from list_agents.'),
      message: z.string().min(1).describe('Message to deliver.'),
    },
    args => guarded(async () => {
      const target = team.memberOf(member.host, args.agent)
      if (target === member) throw new Error('you cannot message yourself')
      if (target !== undefined) {
        await team.messageMember(target, member.name, args.message, { kind: 'member', member })
        return `message delivered to agent ${args.agent}`
      }
      await team.messageAgent(member, args.agent, args.message, new AbortController().signal)
      return `message delivered to agent ${args.agent}`
    }),
  )
  const listAgents = tool(
    'list_agents',
    'List the agents of your team with their names and status.',
    {},
    () => guarded(() => team.describeAgents(member.host, new AbortController().signal)),
  )
  const checkInbox = tool(
    'check_inbox',
    'Read and remove messages other agents sent you since your last check.',
    {},
    () => guarded(() => {
      const entries = member.inbox.splice(0)
      return Promise.resolve(entries.length === 0
        ? 'no new messages'
        : entries.map(entry => entry.text).join('\n\n'))
    }),
  )
  const taskList = tool(
    'team_task_list',
    'List the shared task board: each task\'s id, status, owner, readiness, and blockers.',
    {},
    () => guarded(() => Promise.resolve(team.describeBoard(member.host))),
  )
  const taskCreate = tool(
    'team_task_create',
    'Add an unowned pending task to the shared task board.',
    {
      subject: z.string().min(1).describe('Concise task title.'),
      description: z.string().min(1).describe('Complete task details and acceptance criteria.'),
      blocked_by: z.array(z.string()).optional().describe('Task ids that must complete first.'),
    },
    args => guarded(() => team.createTask(member.host, member.name, args.subject, args.description, args.blocked_by ?? [])),
  )
  const taskTransition = (action: 'claim' | 'release' | 'complete', description: string) => tool(
    `team_task_${action}`,
    description,
    { task_id: z.string().min(1).describe('Task id from team_task_list.') },
    args => guarded(() => team.updateTask(member.host, member, args.task_id, action)),
  )
  return createSdkMcpServer({
    name: TEAM_MCP_SERVER,
    tools: [
      spawnAgent,
      sendMessage,
      listAgents,
      checkInbox,
      taskList,
      taskCreate,
      taskTransition('claim', 'Claim a ready, unowned task before you work on it.'),
      taskTransition('complete', 'Mark a task you claimed as completed.'),
      taskTransition('release', 'Give up a task you claimed so someone else can take it.'),
    ],
  })
}
