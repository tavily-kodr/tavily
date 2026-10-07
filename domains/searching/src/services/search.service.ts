import { AppError } from "@tavily/errors";
import { SearxngClient } from "../clients/searxng.client.js";
import { isValidUrl, canonicalizeUrl } from "../utils/url-validator.js";
import type { NormalizedSearchResult } from "../types/search.types.js";
import { getSearchConfig } from "../config.js";

export interface SearchServiceOptions {
  client?: SearxngClient;
  maxResults?: number;
}

export interface SearchExecutionResult {
  query: string;
  results: NormalizedSearchResult[];
}

export class SearchService {
  private readonly client: SearxngClient;
  private readonly maxResults: number;

  constructor(options: SearchServiceOptions = {}) {
    this.client = options.client ?? new SearxngClient();
    this.maxResults = options.maxResults ?? getSearchConfig().maxResults;
  }

  async search(rawQuery: unknown): Promise<SearchExecutionResult> {
    if (typeof rawQuery !== "string" || !rawQuery.trim()) {
      throw new AppError("Search query is required", {
        code: "INVALID_QUERY",
        statusCode: 400,
      });
    }

    const query = rawQuery.trim();
    const rawData = await this.client.search(query);

    const normalizedResults: NormalizedSearchResult[] = [];
    const seenUrls = new Set<string>();

    for (const item of rawData.results) {
      if (!isValidUrl(item.url)) {
        continue;
      }

      const canonical = canonicalizeUrl(item.url);
      if (seenUrls.has(canonical)) {
        continue;
      }
      seenUrls.add(canonical);

      const title = typeof item.title === "string" ? item.title.trim() : "";
      const content = typeof item.content === "string" ? item.content.trim() : "";
      const score = typeof item.score === "number" && !Number.isNaN(item.score) ? item.score : 0;

      normalizedResults.push({
        title,
        url: item.url,
        content,
        score,
      });

      if (normalizedResults.length >= this.maxResults) {
        break;
      }
    }

    return {
      query,
      results: normalizedResults,
    };
  }
}
