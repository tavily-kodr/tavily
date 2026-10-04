// ─── Error Utilities ──────────────────────────────────────────────────

/** Coerces any thrown value into a proper `Error` instance. */
export function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  if (reason === undefined || reason === null) return new Error('Unknown error');
  try {
    return new Error(JSON.stringify(reason));
  } catch {
    return new Error('Unknown error');
  }
}

/** Throws the abort reason (as an `Error`) if the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw toError(signal.reason);
  }
}

// ─── Cancellable Sleep ────────────────────────────────────────────────

/**
 * Returns a promise that resolves after `ms` milliseconds.
 * The timer is cancelled early if the optional `signal` fires.
 */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toError(signal.reason));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toError(signal?.reason));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Bounded Async Queue ──────────────────────────────────────────────

interface PendingConsumer<T> {
  resolve: (value: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * A bounded, back-pressure-aware async queue that bridges a producer
 * (push) and a consumer (next / async iteration).
 *
 * - Producers block on `push()` once the buffer reaches `highWaterMark`.
 * - Consumers block on `next()` when the buffer is empty.
 * - Calling `close()` signals normal end-of-stream.
 * - Calling `fail(err)` signals an error to waiting consumers.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waitingConsumers: PendingConsumer<T>[] = [];
  private readonly waitingProducers: Array<() => void> = [];
  private closed = false;
  private failure: Error | null = null;

  constructor(private readonly highWaterMark = 256) {
    if (!Number.isInteger(highWaterMark) || highWaterMark < 1) {
      throw new RangeError('highWaterMark must be >= 1');
    }
  }

  // ── Producer API ──────────────────────────────────────────────────

  /** Enqueues a value, blocking if the buffer is at capacity. */
  async push(value: T): Promise<void> {
    // Wait until there is space in the buffer.
    while (this.buffer.length >= this.highWaterMark) {
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error('Queue closed');
      await new Promise<void>((resolve) => this.waitingProducers.push(resolve));
    }

    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('Queue closed');

    // If a consumer is already waiting, hand the value directly.
    const consumer = this.waitingConsumers.shift();
    if (consumer) {
      consumer.resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  /** Signals that no more items will be produced (normal completion). */
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.drain();
    }
  }

  /** Signals an error – all waiting consumers will be rejected. */
  fail(error: unknown): void {
    if (!this.closed) {
      this.failure = toError(error);
      this.closed = true;
      this.drain();
    }
  }

  // ── Consumer API ──────────────────────────────────────────────────

  /** Returns the next item, or `{ done: true }` when the queue is closed. */
  next(): Promise<IteratorResult<T>> {
    // Fast path: item already buffered.
    if (this.buffer.length > 0) {
      const value = this.buffer.shift() as T;
      // Wake one blocked producer now that there is buffer space.
      this.waitingProducers.shift()?.();
      return Promise.resolve({ value, done: false });
    }

    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });

    // Slow path: wait for the next push() or close/fail.
    return new Promise((resolve, reject) => {
      this.waitingConsumers.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  // ── Internal ──────────────────────────────────────────────────────

  /** Drains all pending consumers and unblocks all pending producers. */
  private drain(): void {
    while (this.waitingConsumers.length > 0) {
      const consumer = this.waitingConsumers.shift()!;
      if (this.buffer.length > 0) {
        consumer.resolve({ value: this.buffer.shift() as T, done: false });
        this.waitingProducers.shift()?.();
      } else if (this.failure) {
        consumer.reject(this.failure);
      } else {
        consumer.resolve({ value: undefined as never, done: true });
      }
    }

    // Unblock any producers still waiting – they will see the closed/failure
    // state on re-entry and throw accordingly.
    while (this.waitingProducers.length > 0) {
      this.waitingProducers.shift()!();
    }
  }
}
