import { z } from "zod";

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
export const searxngRawResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  engines: z.array(z.string()),
  score: z.number(),
  category: z.string(),
  parsed_url: z.tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string()]).optional(),
  thumbnail: z.string().optional(),
  publishedDate: z.string().optional(),
});

export const searxngInfoboxSchema = z.object({
  infobox: z.string(),
  id: z.string(),
  content: z.string(),
  urls: z.array(z.object({ title: z.string(), url: z.string() })),
  engine: z.string(),
});

export const searxngRawResponseSchema = z.object({
  query: z.string(),
  number_of_results: z.number(),
  results: z.array(searxngRawResultSchema),
  answers: z.array(z.string()),
  corrections: z.array(z.string()),
  infoboxes: z.array(searxngInfoboxSchema),
  suggestions: z.array(z.string()),
  unresponsive_engines: z.array(z.tuple([z.string(), z.string()])),
});

export type SearXNGRawResponse = z.infer<typeof searxngRawResponseSchema>;
export type SearXNGRawResult = z.infer<typeof searxngRawResultSchema>;
export type SearXNGInfobox = z.infer<typeof searxngInfoboxSchema>;

