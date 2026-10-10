import { logger } from "@tavily/logger";

export interface SearchClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class SearchServiceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: SearchClientOptions = {}) {
    const rawUrl = options.baseUrl ?? process.env.SEARCH_SERVICE_URL ?? "http://127.0.0.1:3000";
    this.baseUrl = rawUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /**
   * Queries the Search API service to retrieve top organic URLs for a search query.
   */
  public async searchUrls(query: string): Promise<string[]> {
    const endpoint = `${this.baseUrl}/search`;
    logger.info("Resolving URLs from upstream Search service", { query, endpoint });

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        logger.warn("Search service returned non-200 status", {
          status: response.status,
          statusText: response.statusText,
        });
        return [];
      }

      const data = (await response.json()) as {
        success?: boolean;
        data?: { results?: Array<{ url: string }> };
      };

      if (data?.success && Array.isArray(data.data?.results)) {
        return data.data.results
          .map((r) => r.url)
          .filter((u): u is string => typeof u === "string" && Boolean(u.trim()));
      }

      return [];
    } catch (err: unknown) {
      logger.warn("Failed to reach Search service for query", {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
