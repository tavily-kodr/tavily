export {
  configureSearchCache,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_EAGER_PAGES,
  DEFAULT_PAGING_BUDGET_MS,
  MAX_EAGER_PAGES,
  MAX_PAGES,
  MAX_POOL_SIZE,
  webSearch,
} from "./search/search-service.js";
export type { SearchCacheConfig } from "./search/search-service.js";
export { deduplicateResults, normalizeUrl } from "./dedupe/dedupe.js";
export { filterBlockedDomains, filterIncludeDomains } from "./filters/filters.js";
export {
  fuseResults,
  isAuthoritativeUrl,
  isDefinitionalQuery,
  keywordOverlap,
  meaningfulTerms,
  normalizeScores,
  rankResults,
  reciprocalRankFusion,
  tokenize,
} from "./rank/rank.js";
export type { RankOptions, RankOutcome } from "./rank/rank.js";
export { TtlCache } from "./cache/cache.js";
export type { TtlCacheOptions } from "./cache/cache.js";
export {
  configureSearxngClient,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  fetchFromSearxng,
  SearxngPageError,
  validateSearxngResponse,
  searxngRawResponseSchema,
  searxngRawResultSchema,
} from "./searxng/searxng-client.js";
export type { PageFailureReason, SearxngClientConfig } from "./searxng/searxng-client.js";
export type {
  FailedEngine,
  FailedPage,
  FusedResult,
  RankCandidate,
  RankedResult,
  SearchOptions,
  SearchResponse,
  SearchResponseItem,
  SearchResult,
  SearchTopic,
  SearxngRawResult,
  SearxngRawResponse,
  TimeRange,
} from "./types.js";
