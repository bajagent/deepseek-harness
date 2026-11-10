/**
 * What each team member is doing right now, and a bounded feed of team
 * events, for the live team view.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team/activity
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Coarse state the team view draws for one agent. */
export type AgentState = 'working' | 'coordinating' | 'waiting' | 'idle' | 'error'

/** One agent's latest observed activity. */
export interface AgentActivity {
  readonly state: AgentState
  /** Short human-readable description, such as `Editing team.ts`. */
  readonly detail: string
  /** Epoch milliseconds when this activity began. */
  readonly since: number
}

/** One event in a team's feed. */
export interface TeamEvent {
  readonly id: number
  readonly time: number
  readonly kind: 'spawn' | 'message' | 'answer' | 'task'
  readonly from: string
  readonly to?: string | undefined
  readonly text: string
}

const PREVIEW_CHARS = 140

/**
 * Shorten free text for the feed.
 * @param text - any text.
 * @returns one line of at most {@link PREVIEW_CHARS} characters.
 */
export function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= PREVIEW_CHARS ? line : `${line.slice(0, PREVIEW_CHARS - 1)}…`
}

function base(path: string | undefined): string {
  return path === undefined ? 'a file' : path.split('/').at(-1) ?? path
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || !(key in input)) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Describe one tool call as a state and a short detail.
 * @param name - tool name as the model called it.
 * @param input - tool arguments.
 * @returns the state the call implies and its description.
 */
export function describeTool(name: string, input: unknown): Pick<AgentActivity, 'state' | 'detail'> {
  const tool = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name
  switch (tool) {
    case 'send_message':
    case 'message_claude_agent':
      return { state: 'coordinating', detail: `Messaging ${field(input, 'agent') ?? 'a teammate'}` }
    case 'spawn_agent':
    case 'subagent':
    case 'subagent_fork':
      return { state: 'coordinating', detail: `Hiring ${field(input, 'name') ?? field(input, 'specialty') ?? 'a teammate'}` }
    case 'list_agents':
      return { state: 'coordinating', detail: 'Checking on the team' }
    case 'check_inbox':
      return { state: 'coordinating', detail: 'Reading the inbox' }
    case 'wait_agent':
    case 'wait_for_messages':
      return { state: 'waiting', detail: 'Waiting for replies' }
    default:
      break
  }
  if (tool.startsWith('team_task')) return { state: 'coordinating', detail: 'Updating the task board' }
  const lower = tool.toLowerCase()
  if (lower === 'bash' || lower.includes('shell') || lower === 'pwsh') {
    return { state: 'working', detail: `Running ${preview(field(input, 'command') ?? 'a command').slice(0, 48)}` }
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('replace') || lower.includes('patch')) {
    return { state: 'working', detail: `Editing ${base(field(input, 'file_path') ?? field(input, 'path'))}` }
  }
  if (lower.includes('read')) return { state: 'working', detail: `Reading ${base(field(input, 'file_path') ?? field(input, 'path'))}` }
  if (lower.includes('grep') || lower.includes('glob') || lower.includes('search') || lower.includes('find')) {
    return { state: 'working', detail: 'Searching the code' }
  }
  if (lower.includes('web') || lower.includes('fetch')) return { state: 'working', detail: 'Browsing the web' }
  if (lower.includes('todo') || lower.includes('plan')) return { state: 'working', detail: 'Planning' }
  return { state: 'working', detail: `Using ${tool}` }
}

/** Owner of every team's activity table and event feed. */
export class ActivityLog {
  private readonly activities = new Map<string, AgentActivity>()
  private readonly feeds = new Map<SessionId, TeamEvent[]>()
  private nextId = 1

  constructor(private readonly feedLimit: number) {}

  /**
   * Record an agent's current activity.
   * @param rootId - the agent's tree root.
   * @param name - the agent's model-facing name.
   * @param state - its new state.
   * @param detail - what it is doing.
   */
  set(rootId: SessionId, name: string, state: AgentState, detail: string): void {
    const key = `${rootId}/${name}`
    const current = this.activities.get(key)
    if (current?.state === state && current.detail === detail) return
    this.activities.set(key, { state, detail, since: Date.now() })
  }

  /**
   * Read an agent's latest activity.
   * @param rootId - the agent's tree root.
   * @param name - the agent's model-facing name.
   * @returns the activity, or undefined before any was observed.
   */
  get(rootId: SessionId, name: string): AgentActivity | undefined {
    return this.activities.get(`${rootId}/${name}`)
  }

  /**
   * Append an event to a team's feed, dropping the oldest beyond the limit.
   * @param rootId - the team's root.
   * @param event - event fields.
   */
  record(rootId: SessionId, event: Omit<TeamEvent, 'id' | 'time'>): void {
    const feed = this.touch(rootId)
    feed.push({ ...event, text: preview(event.text), id: this.nextId++, time: Date.now() })
    if (feed.length > this.feedLimit) feed.splice(0, feed.length - this.feedLimit)
  }

  /**
   * Read a team's feed.
   * @param rootId - the team's root.
   * @returns events oldest first.
   */
  eventsOf(rootId: SessionId): readonly TeamEvent[] {
    return this.feeds.get(rootId) ?? []
  }

  /** Roots with any recorded event, most recently active first. */
  roots(): SessionId[] {
    return [...this.feeds.keys()].reverse()
  }

  /** Forget everything. */
  clear(): void {
    this.activities.clear()
    this.feeds.clear()
  }

  /** Mark a root as recently active and return its feed. */
  private touch(rootId: SessionId): TeamEvent[] {
    const feed = this.feeds.get(rootId) ?? []
    this.feeds.delete(rootId)
    this.feeds.set(rootId, feed)
    return feed
  }
}
