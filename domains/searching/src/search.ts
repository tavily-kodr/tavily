import { logger } from "@tavily/logger";
import { AppError } from "@tavily/errors";
import { SearXNGClient } from "./searxng-client.js";
import { loadSearXNGConfig } from "./config.js";
import { refineQuery } from "./query-refiner.js";
import type { SearchOptions, SearchResponse, SearchResult, SearXNGRawResult } from "./types.js";

// Lazily initialized singleton client
let clientInstance: SearXNGClient | null = null;

function getClient(): SearXNGClient {
  if (clientInstance === null) {
    const config = loadSearXNGConfig();
    clientInstance = new SearXNGClient(config);
    logger.info("SearXNG client initialized", { baseUrl: config.SEARXNG_BASE_URL });
  }
  return clientInstance;
}

// Maps raw SearXNG output to normalized domain format
function mapResult(raw: SearXNGRawResult): SearchResult {
  const result: SearchResult = {
    title: raw.title,
    url: raw.url,
    content: raw.content,
    engines: raw.engines,
    score: raw.score,
    category: raw.category,
  };

  if (raw.parsed_url !== undefined) {
    result.parsedUrl = raw.parsed_url;
  }
  if (raw.thumbnail !== undefined) {
    result.thumbnail = raw.thumbnail;
  }
  if (raw.publishedDate !== undefined) {
    result.publishedDate = raw.publishedDate;
  }

  return result;
}

// Main search function: refines query, queries SearXNG, formats and returns results
export async function search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  if (query.trim().length === 0) {
    throw new AppError("Search query must not be empty", {
      code: "SEARCH_EMPTY_QUERY",
      statusCode: 400,
    });
  }

  const startTime = performance.now();
  const refinedQuery = refineQuery(query);

  logger.info("Executing search", {
    originalQuery: query,
    refinedQuery,
    options,
  });

  const client = getClient();
  const rawResponse = await client.search(refinedQuery, options);

  const maxResults = options.maxResults ?? 10;
  const mappedResults = rawResponse.results.slice(0, maxResults).map(mapResult);
  const searchTimeMs = Math.round(performance.now() - startTime);

  const response: SearchResponse = {
    results: mappedResults,
    metadata: {
      totalResults: rawResponse.results.length,
      searchTimeMs,
      refinedQuery,
      categories: [...new Set(mappedResults.map((r) => r.category))],
    },
  };

  logger.info("Search completed", {
    query: refinedQuery,
    resultCount: mappedResults.length,
    totalAvailable: rawResponse.results.length,
    searchTimeMs,
  });

  return response;
}

// Resets singleton client (useful in tests)
export function resetClient(): void {
  clientInstance = null;
  logger.debug("SearXNG client instance reset");
}
