// Public API for the searching domain

export { search, resetClient } from "./search.js";
export { refineQuery } from "./query-refiner.js";
export { loadSearXNGConfig } from "./config.js";
export type { SearXNGEnv } from "./config.js";
export type {
  SearchOptions,
  SearchResult,
  SearchResponse,
  SearchResponseMetadata,
  SearchCategory,
  SearchTimeRange,
  SearchLanguage,
} from "./types.js";
