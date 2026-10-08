import { z } from "zod";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import type {
  FailedEngine,
  RankCandidate,
  RankedResult,
  SearchOptions,
  SearchTopic,
  SearxngRawResult,
} from "../types.js";
import { TtlCache } from "../cache/cache.js";
import { filterBlockedDomains, filterIncludeDomains } from "../filters/filters.js";
import { fuseResults, rankResults } from "../rank/rank.js";
import {
  DEFAULT_SEARXNG_URL,
  fetchPages,
  parseFailedEngines,
  type SearxngParams,
} from "../searxng/searxng-client.js";

const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_TOPIC: SearchTopic = "general";
const DEFAULT_MAX_RESULTS = 10;

// Cache identical queries for 5 minutes. This is the single biggest
// speed win available: repeat/duplicate queries return instantly
// instead of re-triggering SearXNG's multi-engine fan-out.
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedSearch {
  results: RankedResult[];
  filtered: boolean;
  enginesUsed: string[];
}

const resultCache = new TtlCache<CachedSearch>(CACHE_TTL_MS);

const maxResultsSchema = z.number().int().positive();

function cacheKey(
  query: string,
  maxResults: number,
  params: SearxngParams,
  includeDomains: readonly string[],
  excludeDomains: readonly string[],
): string {
  return JSON.stringify([
    query.trim().toLowerCase(),
    maxResults,
    params.language,
    params.topic,
    params.timeRange ?? "",
    [...includeDomains].sort(),
    [...excludeDomains].sort(),
  ]);
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

/**
 * Queries the local SearXNG instance and returns a filtered, ranked list of
 * search results. This is the "web search" module of the Tavily pipeline:
 * query -> list of candidate URLs + snippets with relevance scores.
 *
 * Retries once on failure (timeout, connection reset, 5xx) before giving
 * up, since a single slow/dropped request shouldn't fail the whole call
 * when a quick retry often succeeds.
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
  filtered: boolean;
  enginesUsed: string[];
}> {
  if (!query || query.trim().length === 0) {
    throw new AppError("Query must not be empty", { code: "EMPTY_QUERY", statusCode: 400 });
  }

  const maxResultsValidation = maxResultsSchema.safeParse(maxResults);
  if (!maxResultsValidation.success) {
    throw new AppError("maxResults must be a positive integer", {
      code: "INVALID_NUM_RESULTS",
      statusCode: 400,
    });
  }

  const searxngUrl = options.searxngUrl ?? DEFAULT_SEARXNG_URL;
  const params: SearxngParams = {
    language: options.language ?? DEFAULT_LANGUAGE,
    topic: options.topic ?? DEFAULT_TOPIC,
    timeRange: options.timeRange,
  };
  const includeDomains = options.includeDomains ?? [];
  const excludeDomains = options.excludeDomains ?? [];

  const key = cacheKey(query, maxResults, params, includeDomains, excludeDomains);
  const cached = resultCache.get(key);
  if (cached) {
    return { ...cached, cached: true, partial: false, failedEngines: [] };
  }

  let fetched = await fetchPages(query, searxngUrl, params);
  if (fetched.pages.length === 0) {
    logger.warn("[searchService] All page requests failed, retrying once...");
    fetched = await fetchPages(query, searxngUrl, params);
    if (fetched.pages.length === 0) {
      const { lastError } = fetched;
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      throw new AppError(`SearXNG request failed after retry: ${message}`, {
        code: "SEARXNG_UNAVAILABLE",
        statusCode: 502,
        cause: lastError,
      });
    }
  }
  const { pages, hasFailedPages } = fetched;

  const failedEngines: FailedEngine[] = [];
  for (const page of pages) {
    for (const failed of parseFailedEngines(page?.unresponsive_engines)) {
      if (!failedEngines.some((f) => f.engine === failed.engine)) failedEngines.push(failed);
    }
  }
  for (const { engine, reason } of failedEngines) {
    logger.warn("[searchService] SearXNG engine unresponsive", { engine, reason });
  }

  const rawResults = pages.flatMap((page) => (Array.isArray(page?.results) ? page.results : []));

  const rawPerEngine = countRawPerEngine(rawResults);
  logger.debug("[searchService] raw results per engine", {
    total: rawResults.length,
    perEngine: rawPerEngine,
  });
  const enginesUsed = Object.keys(rawPerEngine).sort();

  if (rawResults.length === 0 && failedEngines.length > 0) {
    const failedNames = new Set(failedEngines.map((f) => f.engine));
    const expected = options.expectedEngines ?? [];
    if (expected.length > 0 && expected.every((e) => failedNames.has(e))) {
      throw new AppError("All search engines failed; no results available", {
        code: "ALL_ENGINES_FAILED",
        statusCode: 503,
        details: { failedEngines },
      });
    }
  }

  // Fusion also dedupes by normalized URL across both pages. Only excluded
  // results are dropped; quality checks rank results down
  // and backfill (lowConfidence) when too few good results remain.
  let candidates = fuseResults(toCandidates(rawResults));
  candidates = filterBlockedDomains(candidates, excludeDomains);
  candidates = filterIncludeDomains(candidates, includeDomains);

  const ranked = rankResults(query, candidates, {
    englishOnly: params.language.toLowerCase().startsWith("en"),
  });
  // Slice only after dedupe, filtering and ranking.
  const results = ranked.results.slice(0, maxResults);
  const { filtered } = ranked;
  const partial = hasFailedPages || failedEngines.length > 0;

  // Only cache complete, non-empty responses; empty or degraded ones may be
  // transient and a retry can succeed.
  if (results.length > 0 && !partial) {
    resultCache.set(key, { results, filtered, enginesUsed });
  }

  return { results, cached: false, partial, failedEngines, filtered, enginesUsed };
}
