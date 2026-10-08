/**
 * Core Search Models and Interfaces
 */

export type SearchDepth = "basic" | "advanced";
export type TimeRange = "day" | "week" | "month" | "year";
export type SearchTopic = "general" | "news" | "finance";

export interface SearchOptions {
  query: string;
  search_depth?: SearchDepth;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  include_answer?: boolean;
  include_raw_content?: boolean;
  time_range?: TimeRange;
  topic?: SearchTopic;
  skip_cache?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  domain: string;
  score: number;
  published_date: string | null;
  source: string;
  raw_content?: string;
  author?: string;
}

export interface FailedSource {
  url: string;
  reason: string;
}

export interface SearchAnswerSource {
  title: string;
  url: string;
}

export interface SearchResponse {
  query: string;
  answer?: string;
  results: SearchResult[];
  response_time: number;
  status: "success" | "partial_success" | "error";
  failed_sources?: FailedSource[];
  search_depth: SearchDepth;
  total_found: number;
  cached?: boolean;
}

export interface SearchProviderResult {
  title: string;
  url: string;
  snippet: string;
  published_date?: string | null;
  source?: string;
  content?: string;
}
