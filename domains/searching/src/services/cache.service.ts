/**
 * Deterministic In-Memory Cache Service with TTL
 */

import { SearchOptions, SearchResponse } from '../models/search.types';
import { normalizeQuery } from '../utils/text.utils';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class CacheService {
  private readonly store = new Map<string, CacheEntry<SearchResponse>>();
  private readonly defaultTtlMs: number;
  private readonly enabled: boolean;

  constructor() {
    this.enabled = process.env.CACHE_ENABLED !== 'false';
    const ttlSeconds = parseInt(process.env.CACHE_TTL_SECONDS || '600', 10);
    this.defaultTtlMs = ttlSeconds * 1000;
  }

  /**
   * Generates a deterministic cache key from search parameters
   */
  createKey(options: SearchOptions): string {
    const normQuery = normalizeQuery(options.query).toLowerCase();
    const depth = options.search_depth || 'basic';
    const maxResults = options.max_results || 10;
    const timeRange = options.time_range || 'all';
    const includeAns = !!options.include_answer;
    const includeRaw = !!options.include_raw_content;

    const incDomains = (options.include_domains || []).slice().sort().join(',');
    const excDomains = (options.exclude_domains || []).slice().sort().join(',');

    return `search:${normQuery}|${depth}|${maxResults}|${timeRange}|${includeAns}|${includeRaw}|inc:${incDomains}|exc:${excDomains}`;
  }

  /**
   * Retrieves a cached response if valid and not expired
   */
  get(key: string): SearchResponse | null {
    if (!this.enabled) return null;

    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Caches a search response with TTL
   */
  set(key: string, value: SearchResponse, ttlMs?: number): void {
    if (!this.enabled) return;

    const expiresAt = Date.now() + (ttlMs || this.defaultTtlMs);
    this.store.set(key, { value, expiresAt });

    // Periodic cleanup of expired items if store grows large
    if (this.store.size > 200) {
      this.cleanExpired();
    }
  }

  /**
   * Cleans expired entries
   */
  private cleanExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt <= now) {
        this.store.delete(k);
      }
    }
  }

  /**
   * Clears the cache
   */
  clear(): void {
    this.store.clear();
  }
}
