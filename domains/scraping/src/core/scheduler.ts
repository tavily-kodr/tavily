import pLimit, { type LimitFunction } from "p-limit";

export interface SchedulerOptions {
  globalConcurrency?: number;
  perDomainConcurrency?: number;
}

export class CrawlScheduler {
  private readonly globalLimit: LimitFunction;
  private readonly domainLimiters = new Map<string, LimitFunction>();
  private readonly perDomainConcurrency: number;

  constructor(options: SchedulerOptions = {}) {
    const globalConcurrency = options.globalConcurrency ?? 8;
    this.perDomainConcurrency = options.perDomainConcurrency ?? 2;
    this.globalLimit = pLimit(globalConcurrency);
  }

  /**
   * Schedules a task ensuring both global concurrency and per-hostname concurrency bounds are enforced.
   */
  public async schedule<T>(url: string, task: () => Promise<T>): Promise<T> {
    const hostname = this.extractHostname(url);
    const domainLimit = this.getDomainLimiter(hostname);

    return this.globalLimit(() => domainLimit(task));
  }

  private getDomainLimiter(hostname: string): LimitFunction {
    let limiter = this.domainLimiters.get(hostname);
    if (!limiter) {
      limiter = pLimit(this.perDomainConcurrency);
      this.domainLimiters.set(hostname, limiter);
    }
    return limiter;
  }

  private extractHostname(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "default";
    }
  }

  public clear(): void {
    this.domainLimiters.clear();
  }
}
