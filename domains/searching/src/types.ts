export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string | undefined;
}

// A result as seen by ranking: engine name -> 1-based position in that engine's list.
export interface RankCandidate extends SearchResult {
  engineRanks: Record<string, number>;
}

export interface FusedResult extends RankCandidate {
  rrfScore: number;
}

export interface RankedResult extends SearchResult {
  // Normalized to 0..1, highest first.
  score: number;
  // true for backfilled results that failed the quality checks.
  lowConfidence?: boolean | undefined;
}

export interface FailedEngine {
  engine: string;
  reason: string;
}

export interface SearchResponseItem {
  title: string;
  url: string;
  content: string;
  score: number;
  lowConfidence?: boolean | undefined;
}

// Tavily-like /search response.
export interface SearchResponse {
  query: string;
  results: SearchResponseItem[];
  // Seconds, as a float.
  response_time: number;
  partial: boolean;
  failedEngines: FailedEngine[];
  // false when every result failed the quality checks and the unfiltered
  // results are returned ranked by engine score only.
  filtered: boolean;
  // Engines that contributed at least one raw result.
  enginesUsed: string[];
  cached: boolean;
}

export type TimeRange = "day" | "week" | "month" | "year";
export type SearchTopic = "general" | "news";

// Settings are passed in by the caller; the domain never reads process.env.
export interface SearchOptions {
  searxngUrl?: string | undefined;
  language?: string | undefined;
  // Engines enabled in SearXNG; when all of them are unresponsive and nothing
  // came back, webSearch throws a 503 instead of returning an empty 200.
  expectedEngines?: readonly string[] | undefined;
  includeDomains?: readonly string[] | undefined;
  excludeDomains?: readonly string[] | undefined;
  timeRange?: TimeRange | undefined;
  topic?: SearchTopic | undefined;
}

// Shape of a single result item as returned by SearXNG's JSON API.
// SearXNG returns more fields than this; we only type what we use.
export interface SearxngRawResult {
  title: string;
  url: string;
  content?: string | undefined;
  engine?: string | undefined;
  // All engines that returned this URL (SearXNG merges duplicates).
  engines?: string[] | undefined;
}

export interface SearxngRawResponse {
  query: string;
  results: SearxngRawResult[];
  // Each entry is [engineName, reason], e.g. ["google", "timeout"].
  unresponsive_engines?: unknown;
}
