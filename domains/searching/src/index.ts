export { webSearch } from "./search/search-service.js";
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
export {
  fetchFromSearxng,
  fetchPages,
  validateSearxngResponse,
  searxngRawResponseSchema,
  searxngRawResultSchema,
} from "./searxng/searxng-client.js";
export type {
  FailedEngine,
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
