# Searching Domain API Reference

## Public Interfaces

### `SearchOptions`

```typescript
export interface SearchOptions {
  query: string;
  search_depth?: "basic" | "advanced"; // Default: 'basic'
  max_results?: number;                 // Default: 10, max: 20
  include_domains?: string[];           // Target domains to restrict search to
  exclude_domains?: string[];           // Domains to filter out
  include_answer?: boolean;             // Whether to generate grounded answer
  include_raw_content?: boolean;        // Include raw snippet/content
  time_range?: "day" | "week" | "month" | "year";
  topic?: "general" | "news" | "finance";
  skip_cache?: boolean;
}
```

### `SearchResult`

```typescript
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  domain: string;
  score: number;                         // Normalized ranking score [0.05, 0.99]
  published_date: string | null;
  source: string;
  raw_content?: string;
  author?: string;
}
```

### `SearchResponse`

```typescript
export interface SearchResponse {
  query: string;
  answer?: string;
  results: SearchResult[];
  response_time: number;
  status: "success" | "partial_success" | "error";
  failed_sources?: FailedSource[];
  search_depth: "basic" | "advanced";
  total_found: number;
  cached?: boolean;
}
```
