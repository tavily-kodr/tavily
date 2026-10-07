// Supported SearXNG categories
export type SearchCategory =
  | "general"
  | "images"
  | "videos"
  | "news"
  | "map"
  | "music"
  | "it"
  | "science"
  | "files"
  | "social media";

// Time range filter for results
export type SearchTimeRange = "day" | "week" | "month" | "year";

export type SearchLanguage = string;

// Search query options
export interface SearchOptions {
  maxResults?: number;
  categories?: SearchCategory[];
  engines?: string[];
  language?: SearchLanguage;
  timeRange?: SearchTimeRange;
  safeSearch?: 0 | 1 | 2;
  pageno?: number;
}

// Normalized search result
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engines: string[];
  score: number;
  category: string;
  parsedUrl?: [string, string, string, string, string, string];
  thumbnail?: string;
  publishedDate?: string;
}

// Search execution metadata
export interface SearchResponseMetadata {
  totalResults: number;
  searchTimeMs: number;
  refinedQuery: string;
  categories: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  metadata: SearchResponseMetadata;
}

// Raw response format returned by SearXNG JSON API
export interface SearXNGRawResponse {
  query: string;
  number_of_results: number;
  results: SearXNGRawResult[];
  answers: string[];
  corrections: string[];
  infoboxes: SearXNGInfobox[];
  suggestions: string[];
  unresponsive_engines: [string, string][];
}

export interface SearXNGRawResult {
  title: string;
  url: string;
  content: string;
  engines: string[];
  score: number;
  category: string;
  parsed_url?: [string, string, string, string, string, string];
  thumbnail?: string;
  publishedDate?: string;
}

export interface SearXNGInfobox {
  infobox: string;
  id: string;
  content: string;
  urls: { title: string; url: string }[];
  engine: string;
}
