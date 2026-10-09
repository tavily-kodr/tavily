export interface FrontierItem {
  url: string;
  normalizedUrl: string;
  depth: number;
}

export interface FrontierOptions {
  maxDepth?: number;
  maxBreadth?: number;
  maxCapacity?: number;
}

export class InMemoryFrontier {
  private readonly queue: FrontierItem[] = [];
  private readonly breadthCountPerDepth = new Map<number, number>();
  private readonly maxDepth: number;
  private readonly maxBreadth: number;
  private readonly maxCapacity: number;

  constructor(options: FrontierOptions = {}) {
    this.maxDepth = options.maxDepth ?? 2;
    this.maxBreadth = options.maxBreadth ?? 50;
    this.maxCapacity = options.maxCapacity ?? 50000;
  }

  /**
   * Enqueues an item if depth and breadth limits are respected and frontier has capacity.
   * Returns true if enqueued, false if skipped due to limits.
   */
  public enqueue(item: FrontierItem): boolean {
    // 1. Depth check
    if (item.depth > this.maxDepth) {
      return false;
    }

    // 2. Breadth check for this depth level
    const currentBreadth = this.breadthCountPerDepth.get(item.depth) ?? 0;
    if (currentBreadth >= this.maxBreadth) {
      return false;
    }

    // 3. Backpressure capacity check
    if (this.queue.length >= this.maxCapacity) {
      return false;
    }

    this.queue.push(item);
    this.breadthCountPerDepth.set(item.depth, currentBreadth + 1);
    return true;
  }

  public dequeue(): FrontierItem | undefined {
    return this.queue.shift();
  }

  public size(): number {
    return this.queue.length;
  }

  public isEmpty(): boolean {
    return this.queue.length === 0;
  }

  public clear(): void {
    this.queue.length = 0;
    this.breadthCountPerDepth.clear();
  }
}
