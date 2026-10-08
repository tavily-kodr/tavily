/**
 * Minimal in-memory cache with time-based expiry (TTL), an optional stale
 * window (for stale-while-revalidate) and a max entry count with LRU eviction,
 * so memory stays bounded. No external dependency needed.
 * Note: this cache lives only in server memory — it resets on restart
 * and won't be shared across multiple server instances.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  // After expiresAt the entry is stale but still served by peek() until this.
  staleUntil: number;
}

export interface TtlCacheOptions {
  // Oldest-used entries are evicted beyond this many. Default: unbounded.
  maxEntries?: number | undefined;
  // How long after expiry peek() still returns the entry as stale. Default: 0.
  staleMs?: number | undefined;
}

export class TtlCache<T> {
  // Map iteration order is insertion order; re-inserting on access keeps the
  // least recently used entry first.
  private store = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly staleMs: number;

  constructor(
    private ttlMs: number,
    options: TtlCacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? Infinity;
    this.staleMs = options.staleMs ?? 0;
  }

  get size(): number {
    return this.store.size;
  }

  /** Returns the value only while it is fresh. */
  get(key: string): T | undefined {
    const hit = this.peek(key);
    return hit?.fresh ? hit.value : undefined;
  }

  /** Returns a fresh or stale value; entries past their stale window are removed. */
  peek(key: string): { value: T; fresh: boolean } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    if (now > entry.staleUntil) {
      this.store.delete(key);
      return undefined;
    }

    this.store.delete(key);
    this.store.set(key, entry);
    return { value: entry.value, fresh: now <= entry.expiresAt };
  }

  set(key: string, value: T, ttlMs: number = this.ttlMs): void {
    const expiresAt = Date.now() + ttlMs;
    this.store.delete(key);
    this.store.set(key, { value, expiresAt, staleUntil: expiresAt + this.staleMs });

    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }
}
