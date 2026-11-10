/**
 * Harness-side team tools: `spawn_agent` for specialty- and model-selected
 * children on either backend, and `message_claude_agent` for Claude members.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ClaudeTeam } from './team.ts'

function caller(exec: { readonly agent?: import('@deepseek-ai/dsh-agent').Agent | undefined }, tool: string) {
  if (exec.agent === undefined) throw new Error(`${tool} requires a calling agent`)
  return exec.agent
}

/**
 * Define the spawn tool.
 * @param team - the owning team.
 * @returns the `spawn_agent` definition.
 */
export function spawnAgentTool(team: ClaudeTeam): ToolDefinition {
  const ids = Object.keys(team.settings.specialties)
  const catalog = team.describeSpecialties()
  return defineTool({
    name: 'spawn_agent',
    description:
      'Start a background agent on a self-contained task and return its name. It does not see this conversation. '
      + 'Its final answer arrives later as a message. Choose backend "dsh" for a DeepSeek Harness agent (optionally with a provider and model), '
      + 'or "claude" for a Claude Code agent (optionally with a Claude model). Every agent can spawn and message other agents. '
      + 'Message dsh agents with send_message and Claude agents with message_claude_agent.'
      + (catalog.length > 0 ? `\n\nSpecialties:\n${catalog}` : ''),
    parameters: {
      task: { type: 'string', required: true, description: 'Complete task for the new agent.' },
      description: { type: 'string', required: true, description: 'Short label for the task, 3-6 words.' },
      name: { type: 'string', description: 'Optional name: 1-32 lower-case letters, digits, or hyphens starting with a letter, other than "lead".' },
      ...ids.length === 0 ? {} : { specialty: { type: 'string', enum: ids, description: 'Specialty from the list above.' } as const },
      backend: { type: 'string', enum: ['dsh', 'claude'], description: `Runtime for the agent; defaults to "${team.settings.defaultBackend}" unless the specialty fixes one.` },
      provider: { type: 'string', description: 'Harness model provider for a dsh agent; requires model.' },
      model: { type: 'string', description: 'Model id: a Harness model for a dsh agent, or a Claude model for a Claude agent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          backend: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started ${value.backend} agent ${value.name}` }],
    },
    async execute(args, exec) {
      const agent = caller(exec, 'spawn_agent')
      const spawned = await team.spawn(agent, undefined, {
        task: args.task,
        description: args.description,
        name: args.name,
        specialty: 'specialty' in args ? args.specialty as string | undefined : undefined,
        backend: args.backend,
        provider: args.provider,
        model: args.model,
        signal: exec.signal,
      })
      return { name: spawned.name, backend: spawned.backend }
    },
  })
}

/**
 * Define the Claude-member messaging tool.
 * @param team - the owning team.
 * @param ctx - context carrying the subagent runtime for sender names.
 * @returns the `message_claude_agent` definition.
 */
export function messageClaudeAgentTool(team: ClaudeTeam, ctx: Context): ToolDefinition {
  return defineTool({
    name: 'message_claude_agent',
    description:
      'Send a message to a Claude agent of your team. A working Claude agent reads it during its current task; '
      + 'an idle one resumes its conversation with it, and its answer arrives later as a message.',
    parameters: {
      agent: { type: 'string', required: true, description: 'Name of the Claude agent.' },
      message: { type: 'string', required: true, description: 'Message to deliver.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivery: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{ type: 'text', text: `message delivered to Claude agent ${args.agent}` }],
    },
    async execute(args, exec) {
      const agent = caller(exec, 'message_claude_agent')
      const member = team.memberOf(agent, args.agent)
      if (member === undefined) {
        const rootId = ctx.subagents.rootOf(agent).id
        const known = team.membersOf(rootId).map(entry => entry.name).join(', ')
        throw new Error(`no Claude agent named "${args.agent}"${known.length > 0 ? `; Claude agents: ${known}` : ''}`)
      }
      const from = ctx.subagents.namesOf(agent).self
      const delivery = await team.messageMember(member, from, args.message, { kind: 'agent', agent })
      return { delivery }
    },
  })
}
