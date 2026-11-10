import { externalTestParent } from '../../subagent/tests/external-activation-helpers.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  startMessagesFixture,
  type MessagesBehavior,
  type MessagesFixture,
} from '../../subagent-claude-code/tests/messages-fixture.ts'
import * as team from '../src/index.ts'

const roots: string[] = []
const fixtures: MessagesFixture[] = []
const contexts: Context[] = []

const ambientAnthropicModel = process.env.ANTHROPIC_MODEL
beforeAll(() => { delete process.env.ANTHROPIC_MODEL })
afterAll(() => {
  if (ambientAnthropicModel !== undefined) process.env.ANTHROPIC_MODEL = ambientAnthropicModel
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

interface Harness {
  readonly ctx: Context
  readonly lead: Agent
  readonly fixture: MessagesFixture
}

/** Real SDK and CLI against a local Messages fixture; only the parent Agent's model is absent. */
async function harness(behavior: MessagesBehavior): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-claude-team-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const claudeConfig = join(root, 'claude-config')
  mkdirSync(workspace)
  mkdirSync(claudeConfig)
  writeFileSync(join(claudeConfig, 'settings.json'), `${JSON.stringify({ model: 'dsh-team-fixture-model' })}\n`)
  const fixture = await startMessagesFixture(behavior)
  fixtures.push(fixture)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const lead = await externalTestParent(ctx, workspace)
  await ctx.plugin(team, {
    env: {
      ANTHROPIC_API_KEY: 'dsh-fake-anthropic-key',
      ANTHROPIC_BASE_URL: fixture.baseUrl,
      CLAUDE_CONFIG_DIR: claudeConfig,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'xdg'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '127.0.0.1,localhost',
    },
    specialties: {
      reviewer: { description: 'Reviews changes.', instructions: 'REVIEWER_INSTRUCTIONS', backend: 'claude' },
    },
  })
  return { ctx, lead, fixture }
}

function inboxTexts(agent: Agent): string[] {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
}

async function until(condition: () => boolean, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not reached in time')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function requestText(fixture: MessagesFixture): string {
  return fixture.requests.map(request => JSON.stringify(request.body)).join('\n')
}

describe('Claude Code team members over the real Agent SDK and CLI', { timeout: 90_000 }, () => {
  it('starts a specialty member that messages lead through its team tools', async () => {
    const { ctx, lead, fixture } = await harness({
      kind: 'tool-use',
      toolName: 'mcp__dsh_team__send_message',
      input: { agent: 'lead', message: 'MEMBER_PING' },
      finalText: 'MEMBER_DONE',
    })
    const spawned = await executeToolFixture(ctx, {
      name: 'spawn_agent',
      callId: ToolCallId('spawn'),
      arguments: { task: 'Say hello to lead.', description: 'greet lead', specialty: 'reviewer' },
      agent: lead,
      signal: new AbortController().signal,
    })
    expect(spawned).toMatchObject({ isError: false, value: { name: 'claude-1', backend: 'claude' } })

    await until(() => inboxTexts(lead).some(text => text.includes('MEMBER_PING')))
    expect(inboxTexts(lead)).toContain('Agent claude-1 sent a message: MEMBER_PING')
    const sent = requestText(fixture)
    expect(sent).toContain('REVIEWER_INSTRUCTIONS')
    expect(sent).toContain('You are Claude agent \\"claude-1\\"')
    expect(sent).toContain('mcp__dsh_team__spawn_agent')
  })

  it('resumes an idle member with a follow-up and forwards its answer to the sender', async () => {
    const { ctx, lead, fixture } = await harness({ kind: 'complete', text: 'MEMBER_ANSWER' })
    await executeToolFixture(ctx, {
      name: 'spawn_agent',
      callId: ToolCallId('spawn'),
      arguments: { task: 'FIRST_TASK', description: 'first task', backend: 'claude', name: 'helper' },
      agent: lead,
      signal: new AbortController().signal,
    })
    // The first answer reaches lead as the runtime's completion notice.
    await until(() => inboxTexts(lead).some(text => text.includes('MEMBER_ANSWER')))
    const firstRequests = fixture.requests.length
    // Whether the member is still settling (queued) or idle (resumed), the follow-up wakes it.
    const delivery = await executeToolFixture(ctx, {
      name: 'message_claude_agent',
      callId: ToolCallId('message'),
      arguments: { agent: 'helper', message: 'FOLLOW_UP' },
      agent: lead,
      signal: new AbortController().signal,
    })
    expect(delivery).toMatchObject({ isError: false })
    await until(() => inboxTexts(lead).some(text => text.startsWith('Agent "helper" finished:')))
    expect(fixture.requests.length).toBeGreaterThan(firstRequests)
    const resumed = fixture.requests.at(-1)
    expect(JSON.stringify(resumed?.body)).toContain('FIRST_TASK')
    expect(JSON.stringify(resumed?.body)).toContain('FOLLOW_UP')
    expect(inboxTexts(lead)).toContain('Agent "helper" finished:\nMEMBER_ANSWER')
  })
})
