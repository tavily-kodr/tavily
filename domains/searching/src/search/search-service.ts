import { z } from "zod";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import type {
  FailedEngine,
  FailedPage,
  RankCandidate,
  RankedResult,
  SearchOptions,
  SearchTopic,
  SearxngRawResponse,
  SearxngRawResult,
} from "../types.js";
import { TtlCache } from "../cache/cache.js";
import { filterBlockedDomains, filterIncludeDomains } from "../filters/filters.js";
import { fuseResults, rankResults, type RankOutcome } from "../rank/rank.js";
import {
  DEFAULT_SEARXNG_URL,
  fetchFromSearxng,
  OPTIONAL_ENGINE_TIMEOUT_MS,
  OPTIONAL_PAGE_DEADLINE_MS,
  PAGE_DEADLINE_MS,
  parseFailedEngines,
  SearxngPageError,
  type SearxngParams,
} from "../searxng/searxng-client.js";

const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_TOPIC: SearchTopic = "general";
const DEFAULT_MAX_RESULTS = 20;
// Largest ranked pool kept per query; every request slices it to maxResults,
// so maxResults=5 and maxResults=20 share one cache entry.
export const MAX_POOL_SIZE = 20;

// Hard cap on SearXNG pages per search; each page is one fan-out to every
// engine, so pages beyond the first are fetched only when they are needed.
export const MAX_PAGES = 20;
// Optional pages fetched at once by one search: half of SearXNG's 4 request
// slots (see DEFAULT_MAX_CONCURRENT_REQUESTS), leaving room for other searches.
export const PAGE_CONCURRENCY = 2;
// About how many results one page brings. A target above it always needs more
// pages, so options.eagerPages of them can be sent together with page 1
// instead of after it: one round trip instead of three. Capped so page 1 plus
// these fit SearXNG's 4 request slots.
const RESULTS_PER_PAGE = 10;
export const MAX_EAGER_PAGES = 3;
// Suggested eagerPages for callers that want speed: page 1 plus 2 uses 3 slots.
export const DEFAULT_EAGER_PAGES = 2;
// Total time one search may spend on SearXNG. Fits page 1 plus its retry
// (2 x 2.25s); optional pages start only if they can finish inside it.
export const SEARCH_BUDGET_MS = 8000;
// Suggested pagingBudgetMs for callers that want speed: fits the eager batch
// but no further round after it, so sparse queries stop at ~1-2.5s instead
// of paging on for up to SEARCH_BUDGET_MS.
export const DEFAULT_PAGING_BUDGET_MS = 2500;

// Repeat/duplicate queries return instantly instead of re-triggering
// SearXNG's multi-engine fan-out, which also keeps engine traffic (and ban
// risk) down. Expired entries are served stale while a refresh runs.
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_CACHE_MAX_ENTRIES = 1000;
// Responses with an unresponsive engine or a failed page are cached briefly.
const PARTIAL_TTL_MS = 2 * 60 * 1000;

interface CachedSearch {
  // Ranked pool (up to MAX_POOL_SIZE): passing results first, then backfill.
  results: RankedResult[];
  // Results in the pool that passed the quality checks (not lowConfidence).
  strictCount: number;
  // true when fewer than target good results were found after trying every
  // useful page: refetching for the same target adds nothing.
  exhausted: boolean;
  // maxResults the pool was fetched for; reused by background refreshes.
  target: number;
  filtered: boolean;
  enginesUsed: string[];
  partial: boolean;
  failedEngines: FailedEngine[];
  failedPages: FailedPage[];
}

export interface SearchCacheConfig {
  ttlMs?: number | undefined;
  maxEntries?: number | undefined;
}

let cacheTtlMs = DEFAULT_CACHE_TTL_MS;
let resultCache = createCache(DEFAULT_CACHE_TTL_MS, DEFAULT_CACHE_MAX_ENTRIES);
const inflight = new Map<string, { promise: Promise<CachedSearch>; target: number }>();

function createCache(ttlMs: number, maxEntries: number): TtlCache<CachedSearch> {
  return new TtlCache<CachedSearch>(ttlMs, { maxEntries, staleMs: ttlMs });
}

/** Replaces (and empties) the result cache. The caller passes env-derived settings. */
export function configureSearchCache(config: SearchCacheConfig = {}): void {
  cacheTtlMs = config.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  resultCache = createCache(cacheTtlMs, config.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
  inflight.clear();
}

const maxResultsSchema = z.number().int().min(1).max(MAX_POOL_SIZE);

interface FetchContext {
  query: string;
  searxngUrl: string;
  params: SearxngParams;
  includeDomains: readonly string[];
  excludeDomains: readonly string[];
  expectedEngines: readonly string[];
  maxPages: number;
  eagerPages: number;
  pagingBudgetMs: number;
}

function normalizeDomainList(domains: readonly string[]): string[] {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))].sort();
}

// maxResults is deliberately not part of the key; see MAX_POOL_SIZE.
function cacheKey(ctx: FetchContext): string {
  return JSON.stringify([
    ctx.query.trim().toLowerCase().replace(/\s+/g, " "),
    ctx.params.language,
    ctx.params.topic,
    ctx.params.timeRange ?? "",
    normalizeDomainList(ctx.includeDomains),
    normalizeDomainList(ctx.excludeDomains),
  ]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Number of raw results each engine contributed (a result may count for several engines). */
function countRawPerEngine(rawResults: SearxngRawResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rawResults) {
    if (!r) continue;
    const engines = new Set<string>(
      Array.isArray(r.engines) ? r.engines.filter((e) => typeof e === "string" && e) : [],
    );
    if (typeof r.engine === "string" && r.engine.trim()) engines.add(r.engine.trim());
    for (const e of engines) counts[e] = (counts[e] ?? 0) + 1;
  }
  return counts;
}

/**
 * Converts raw SearXNG results into rank candidates. An engine's rank for a
 * result is its 1-based order among the results that engine contributed to.
 */
function toCandidates(rawResults: SearxngRawResult[]): RankCandidate[] {
  const engineCounters = new Map<string, number>();
  const candidates: RankCandidate[] = [];

  for (const r of rawResults) {
    if (!r || typeof r.url !== "string" || !r.url.trim()) {
      continue;
    }
    const engine = typeof r.engine === "string" && r.engine.trim() ? r.engine.trim() : undefined;
    const engines = new Set<string>(
      Array.isArray(r.engines) ? r.engines.filter((e) => typeof e === "string" && e) : [],
    );
    if (engine) engines.add(engine);
    if (engines.size === 0) engines.add("unknown");

    const engineRanks: Record<string, number> = {};
    for (const e of engines) {
      const rank = (engineCounters.get(e) ?? 0) + 1;
      engineCounters.set(e, rank);
      engineRanks[e] = rank;
    }

    candidates.push({
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : "Untitled",
      url: r.url.trim(),
      snippet: typeof r.content === "string" ? r.content : "",
      ...(engine ? { engine } : {}),
      engineRanks,
    });
  }

  return candidates;
}

interface RankedPages {
  rawCount: number;
  // Distinct normalized URLs across all pages, before domain filtering.
  uniqueCount: number;
  rawPerEngine: Record<string, number>;
  failedEngines: FailedEngine[];
  ranked: RankOutcome;
  strictCount: number;
}

/**
 * Fuses (and so dedupes by normalized URL) the raw results of all pages, then
 * filters and ranks them. Only excluded domains are dropped; quality checks
 * rank results down and flag them lowConfidence (backfill).
 */
function rankPages(ctx: FetchContext, pages: SearxngRawResponse[]): RankedPages {
  const failedEngines: FailedEngine[] = [];
  for (const page of pages) {
    for (const failed of parseFailedEngines(page?.unresponsive_engines)) {
      if (!failedEngines.some((f) => f.engine === failed.engine)) failedEngines.push(failed);
    }
  }

  const rawResults = pages.flatMap((page) => (Array.isArray(page?.results) ? page.results : []));

  const fused = fuseResults(toCandidates(rawResults));
  let candidates = filterBlockedDomains(fused, ctx.excludeDomains);
  candidates = filterIncludeDomains(candidates, ctx.includeDomains);

  const ranked = rankResults(ctx.query, candidates, {
    englishOnly: ctx.params.language.toLowerCase().startsWith("en"),
  });
  const firstWeak = ranked.results.findIndex((r) => r.lowConfidence);

  return {
    rawCount: rawResults.length,
    uniqueCount: fused.length,
    rawPerEngine: countRawPerEngine(rawResults),
    failedEngines,
    ranked,
    strictCount: firstWeak === -1 ? ranked.results.length : firstWeak,
  };
}

function failureReason(err: unknown): string {
  return err instanceof SearxngPageError ? err.reason : "unknown";
}

/**
 * Page 1 is required. It is retried once, unless SearXNG rejected the request
 * outright (4xx) or the retry could not finish inside the search budget.
 */
async function fetchFirstPage(ctx: FetchContext, startedAt: number): Promise<SearxngRawResponse> {
  let error: unknown;
  try {
    return await fetchFromSearxng(ctx.query, ctx.searxngUrl, ctx.params, 1);
  } catch (err) {
    error = err;
  }

  const reason = failureReason(error);
  const canRetry =
    reason !== "http_4xx" && Date.now() - startedAt + PAGE_DEADLINE_MS <= SEARCH_BUDGET_MS;
  logger.warn("[searchService] SearXNG page request failed", { pageno: 1, reason, canRetry });

  if (canRetry) {
    try {
      return await fetchFromSearxng(ctx.query, ctx.searxngUrl, ctx.params, 1);
    } catch (err) {
      error = err;
    }
  }
  throw new AppError(
    `SearXNG request failed${canRetry ? " after retry" : ""}: ${errorMessage(error)}`,
    { code: "SEARXNG_UNAVAILABLE", statusCode: 502, cause: error },
  );
}

function fetchOptionalPages(
  ctx: FetchContext,
  batch: number[],
): Promise<PromiseSettledResult<SearxngRawResponse>[]> {
  return Promise.allSettled(
    batch.map((p) =>
      fetchFromSearxng(ctx.query, ctx.searxngUrl, ctx.params, p, OPTIONAL_ENGINE_TIMEOUT_MS),
    ),
  );
}

/**
 * Fetches page 1, then further pages only while fewer than `target` results
 * pass the quality checks, up to maxPages. When the target is more than one
 * page can hold, pages 2..1+eagerPages are sent together with page 1.
 * Otherwise page 2 goes alone as a probe (often the engines have nothing
 * beyond page 1). Once a page brings new URLs, the rest go PAGE_CONCURRENCY
 * at a time.
 * Stops early when a batch brings no new URLs (the engines have nothing more),
 * when every page of a batch failed (don't pile onto a struggling SearXNG) or
 * when the paging budget cannot fit another batch. Optional pages are never
 * retried; their failures are recorded and make the response partial.
 */
async function fetchPool(ctx: FetchContext, target: number): Promise<CachedSearch> {
  const startedAt = Date.now();
  const eager: number[] = [];
  if (target > RESULTS_PER_PAGE) {
    for (let p = 2; p <= Math.min(ctx.maxPages, 1 + ctx.eagerPages); p++) eager.push(p);
  }
  // Page 1 is started first so it takes a request slot before the optional
  // pages. allSettled never rejects, so a failed page 1 leaves nothing unhandled.
  const firstPage = fetchFirstPage(ctx, startedAt);
  const eagerSettled = fetchOptionalPages(ctx, eager);

  const pages = new Map<number, SearxngRawResponse>([[1, await firstPage]]);
  const ordered = () => [...pages.entries()].sort(([a], [b]) => a - b).map(([, page]) => page);
  let pool = rankPages(ctx, ordered());

  if (pool.rawCount === 0 && pool.failedEngines.length > 0) {
    const failedNames = new Set(pool.failedEngines.map((f) => f.engine));
    if (ctx.expectedEngines.length > 0 && ctx.expectedEngines.every((e) => failedNames.has(e))) {
      throw new AppError("All search engines failed; no results available", {
        code: "ALL_ENGINES_FAILED",
        statusCode: 503,
        details: { failedEngines: pool.failedEngines },
      });
    }
  }

  const failedPages: FailedPage[] = [];
  // Stores successful pages and records failed ones; returns the success count.
  const record = (batch: number[], settled: PromiseSettledResult<SearxngRawResponse>[]) => {
    let succeeded = 0;
    settled.forEach((outcome, i) => {
      const page = batch[i] ?? 0;
      if (outcome.status === "fulfilled") {
        pages.set(page, outcome.value);
        succeeded++;
        return;
      }
      const reason = failureReason(outcome.reason);
      failedPages.push({ page, reason });
      logger.warn("[searchService] SearXNG page request failed", { pageno: page, reason });
    });
    return succeeded;
  };

  // An empty page 1 means later pages have nothing either.
  let moreAvailable = pool.rawCount > 0;
  let nextPage = 2;
  let batchSize = 1;
  if (eager.length > 0 && moreAvailable) {
    const before = pool.uniqueCount;
    const succeeded = record(eager, await eagerSettled);
    pool = rankPages(ctx, ordered());
    moreAvailable = succeeded > 0 && pool.uniqueCount > before;
    nextPage = 2 + eager.length;
    batchSize = PAGE_CONCURRENCY;
  }
  while (moreAvailable && pool.strictCount < target && nextPage <= ctx.maxPages) {
    if (Date.now() - startedAt + OPTIONAL_PAGE_DEADLINE_MS > ctx.pagingBudgetMs) break;

    const batch: number[] = [];
    for (; batch.length < batchSize && nextPage <= ctx.maxPages; nextPage++) {
      batch.push(nextPage);
    }
    const succeeded = record(batch, await fetchOptionalPages(ctx, batch));
    if (succeeded === 0) break;

    const before = pool.uniqueCount;
    pool = rankPages(ctx, ordered());
    moreAvailable = pool.uniqueCount > before;
    batchSize = PAGE_CONCURRENCY;
  }

  for (const { engine, reason } of pool.failedEngines) {
    logger.warn("[searchService] SearXNG engine unresponsive", { engine, reason });
  }
  logger.debug("[searchService] raw results per engine", {
    pages: pages.size,
    total: pool.rawCount,
    perEngine: pool.rawPerEngine,
  });

  return {
    results: pool.ranked.results.slice(0, MAX_POOL_SIZE),
    strictCount: Math.min(pool.strictCount, MAX_POOL_SIZE),
    // Fetching again for the same target would only repeat this attempt.
    exhausted: pool.strictCount < target,
    target,
    filtered: pool.ranked.filtered,
    enginesUsed: Object.keys(pool.rawPerEngine).sort(),
    partial: failedPages.length > 0 || pool.failedEngines.length > 0,
    failedEngines: pool.failedEngines,
    failedPages,
  };
}

function startFetch(key: string, ctx: FetchContext, target: number): Promise<CachedSearch> {
  const promise = fetchPool(ctx, target)
    .then((entry) => {
      // Never cache empty or failed responses; partial ones only briefly.
      if (entry.results.length > 0) {
        resultCache.set(
          key,
          entry,
          entry.partial ? Math.min(PARTIAL_TTL_MS, cacheTtlMs) : cacheTtlMs,
        );
      }
      return entry;
    })
    .finally(() => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
    });
  inflight.set(key, { promise, target });
  return promise;
}

function refreshInBackground(key: string, ctx: FetchContext, target: number): void {
  if (inflight.has(key)) return;
  startFetch(key, ctx, target).catch((err: unknown) => {
    logger.warn("[searchService] background refresh failed", { error: errorMessage(err) });
  });
}

function satisfies(entry: CachedSearch, maxResults: number): boolean {
  return entry.exhausted || entry.strictCount >= maxResults;
}

async function loadPool(
  key: string,
  ctx: FetchContext,
  maxResults: number,
): Promise<{ entry: CachedSearch; cached: boolean }> {
  const hit = resultCache.peek(key);
  if (hit && satisfies(hit.value, maxResults)) {
    // Stale-while-revalidate: answer from cache now, refresh in the background.
    if (!hit.fresh) refreshInBackground(key, ctx, hit.value.target);
    return { entry: hit.value, cached: true };
  }

  // Coalesce concurrent identical searches into one SearXNG round trip.
  const pending = inflight.get(key);
  if (pending && pending.target >= maxResults) {
    return { entry: await pending.promise, cached: false };
  }

  const target = Math.max(maxResults, hit?.value.target ?? 0);
  return { entry: await startFetch(key, ctx, target), cached: false };
}

/**
 * Queries the local SearXNG instance and returns a filtered, ranked list of
 * search results. This is the "web search" module of the Tavily pipeline:
 * query -> list of candidate URLs + snippets with relevance scores.
 *
 * Page 1 is retried once on failure; further pages are fetched in small
 * batches only while too few good results were found, and their failures are
 * non-fatal (partial: true).
 *
 * All settings (SearXNG URL, language, domain filters) come in
 * via `options`; this module never reads the environment.
 */
export async function webSearch(
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
  options: SearchOptions = {},
): Promise<{
  results: RankedResult[];
  cached: boolean;
  partial: boolean;
  failedEngines: FailedEngine[];
  failedPages: FailedPage[];
  filtered: boolean;
  enginesUsed: string[];
}> {
  if (!query || query.trim().length === 0) {
    throw new AppError("Query must not be empty", { code: "EMPTY_QUERY", statusCode: 400 });
  }

  const maxResultsValidation = maxResultsSchema.safeParse(maxResults);
  if (!maxResultsValidation.success) {
    throw new AppError(`maxResults must be an integer between 1 and ${MAX_POOL_SIZE}`, {
      code: "INVALID_NUM_RESULTS",
      statusCode: 400,
    });
  }

  const ctx: FetchContext = {
    query,
    searxngUrl: options.searxngUrl ?? DEFAULT_SEARXNG_URL,
    params: {
      language: options.language ?? DEFAULT_LANGUAGE,
      topic: options.topic ?? DEFAULT_TOPIC,
      timeRange: options.timeRange,
    },
    includeDomains: options.includeDomains ?? [],
    excludeDomains: options.excludeDomains ?? [],
    expectedEngines: options.expectedEngines ?? [],
    maxPages: Math.min(MAX_PAGES, Math.max(1, Math.trunc(options.maxPages ?? MAX_PAGES))),
    eagerPages: Math.min(MAX_EAGER_PAGES, Math.max(0, Math.trunc(options.eagerPages ?? 0))),
    pagingBudgetMs: Math.min(SEARCH_BUDGET_MS, options.pagingBudgetMs ?? SEARCH_BUDGET_MS),
  };

  const { entry, cached } = await loadPool(cacheKey(ctx), ctx, maxResults);

  return {
    // Slice only after dedupe, filtering and ranking.
    results: entry.results.slice(0, maxResults),
    cached,
    partial: entry.partial,
    failedEngines: entry.failedEngines,
    failedPages: entry.failedPages,
    filtered: entry.filtered,
    enginesUsed: entry.enginesUsed,
  };
}
