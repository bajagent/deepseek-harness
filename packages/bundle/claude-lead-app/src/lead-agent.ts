/**
 * The root Agent that stands in for an external Claude Code session. It owns
 * a real Session so the subagent runtime can catalog its children, but it
 * never drives a model: input addressed to it waits in its inbox until the
 * Claude lead reads it through the MCP tools.
 *
 * @module @deepseek-ai/dsh-claude-lead-app/lead-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, Inbox, InboxTarget, Model } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/** Inbox whose arrivals wake waiting readers. */
export class LeadInbox implements Inbox {
  private readonly pending: Record<InboxTarget, UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  private readonly waiters = new Set<() => void>()

  get nextTurn(): readonly UserMessage[] { return this.pending['next-turn'] }
  get nextStep(): readonly UserMessage[] { return this.pending['next-step'] }

  clear(): void {
    this.pending['next-turn'].splice(0)
    this.pending['next-step'].splice(0)
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.pending[target].push(message)
    this.wake()
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.pending[target].unshift(message)
    this.wake()
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    for (const queue of Object.values(this.pending)) {
      const index = queue.findIndex(message => message.id === messageId)
      if (index >= 0) {
        queue.splice(index, 1, newMessage)
        return true
      }
    }
    return false
  }

  remove(messageId: MessageId): boolean {
    for (const queue of Object.values(this.pending)) {
      const index = queue.findIndex(message => message.id === messageId)
      if (index >= 0) {
        queue.splice(index, 1)
        return true
      }
    }
    return false
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    const removed = this.pending[target].splice(start, deleteCount, ...inserted)
    if (inserted.length > 0) this.wake()
    return removed
  }

  /**
   * Remove every pending message in arrival order across both boundaries.
   * @returns the drained messages.
   */
  drain(): UserMessage[] {
    return [...this.pending['next-step'].splice(0), ...this.pending['next-turn'].splice(0)]
  }

  /**
   * Wait until a message is pending.
   * @param timeoutMs - how long to wait.
   * @param signal - cancellation.
   * @returns whether a message is pending.
   */
  async waitForMessage(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (this.nextStep.length + this.nextTurn.length > 0) return true
    return new Promise((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        this.waiters.delete(onMessage)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onMessage = (): void => { finish(true) }
      const onAbort = (): void => { finish(false) }
      const timer = setTimeout(() => { finish(false) }, timeoutMs)
      this.waiters.add(onMessage)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}

function modelless(): Model {
  return {
    current: () => undefined,
    select: () => {
      throw new Error('the Claude lead has no Harness model; it is driven by Claude Code')
    },
  }
}

/**
 * Build the lead Agent over a fresh root Session.
 * @param ctx - context that owns the Agent registration.
 * @param session - the lead's root Session.
 * @param inbox - inbox the MCP tools read.
 * @returns a registered-ready Agent that never drives a model.
 */
export function createLeadAgent(ctx: Context, session: Session, inbox: LeadInbox): Agent {
  return {
    id: session.id,
    session,
    ctx,
    options: {},
    status: 'idle',
    model: modelless(),
    inbox,
    send: (message, target) => { inbox.append(target, message) },
    followup: (message) => { inbox.append('next-turn', message) },
    steer: (message) => { inbox.append('next-step', message) },
    inject: (message) => { inbox.append('next-step', message) },
    cancel: (_cause, options) => { if (options?.keepInbox !== true) inbox.clear() },
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
}
