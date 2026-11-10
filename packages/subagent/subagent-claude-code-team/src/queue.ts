/**
 * Push-driven async iterable that feeds streaming input to one SDK query.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team/queue
 */

/** Single-consumer queue: pushes resolve a waiting reader or buffer; close ends iteration. */
export class InputQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private readonly waiters: ((result: IteratorResult<T, undefined>) => void)[] = []
  private closedValue = false

  /** Whether {@link close} ended the queue. */
  get closed(): boolean {
    return this.closedValue
  }

  /**
   * Deliver one item to the reader.
   * @param item - the next value, ignored after close.
   * @returns whether the queue accepted the item.
   */
  push(item: T): boolean {
    if (this.closedValue) return false
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.items.push(item)
    else waiter({ value: item, done: false })
    return true
  }

  /** End iteration after buffered items drain. Idempotent. */
  close(): void {
    this.closedValue = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false })
        }
        if (this.closedValue) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => { this.waiters.push(resolve) })
      },
    }
  }
}
