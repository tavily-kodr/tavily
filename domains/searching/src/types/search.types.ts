export interface NormalizedSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  rawContent?: string | undefined;
  snippet?: string | undefined;
  canonicalUrl?: string | undefined;
  sourceUrl?: string | undefined;
}

export interface SearchQueryOptions {
  crawl?: boolean | undefined;
  crawlDepth?: number | undefined;
  maxResults?: number | undefined;
  includeRawContent?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface SearchResponseData {
  query: string;
  results: NormalizedSearchResult[];
  took_ms: number;
}

export interface SearchSuccessResponse {
  success: true;
  data: SearchResponseData;
}

export interface SearchErrorDetail {
  code: string;
  message: string;
}

export interface SearchErrorResponse {
  success: false;
  error: SearchErrorDetail;
}

export type SearchApiResponse = SearchSuccessResponse | SearchErrorResponse;

export interface SearxngRawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  engine?: unknown;
  engines?: unknown;
  positions?: unknown;
  category?: unknown;
  [key: string]: unknown;
}

export interface SearxngRawResponse {
  query?: string;
  number_of_results?: number;
  results: SearxngRawResult[];
  unresponsive_engines?: unknown;
  [key: string]: unknown;
}

export interface SearchConfig {
  searxngUrl: string;
  timeoutMs: number;
  maxResults: number;
  port: number;
  nodeEnv: string;
  crawlCandidates: boolean;
  maxCrawlResults: number;
  crawlConcurrency: number;
  crawlTimeoutMs: number;
  respectRobotsTxt: boolean;
}
