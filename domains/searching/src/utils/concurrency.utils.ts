/**
 * Concurrency limiting pool for parallel asynchronous tasks
 */

export class ConcurrencyLimiter {
  private activeCount: number = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit <= 0) {
      throw new Error('Concurrency limit must be greater than 0');
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }

    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) next();
      }
    }
  }
}

/**
 * Runs an array of items through an async mapper with a fixed concurrency limit
 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limiter = new ConcurrencyLimiter(limit);
  return Promise.all(items.map((item, idx) => limiter.run(() => fn(item, idx))));
}
