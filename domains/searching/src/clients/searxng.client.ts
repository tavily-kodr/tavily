import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import type { SearxngRawResponse } from "../types/search.types.js";

export interface SearxngClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  enableFallback?: boolean;
}

export class SearxngClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly enableFallback: boolean;

  constructor(options: SearxngClientOptions = {}) {
    const rawUrl = options.baseUrl ?? process.env.SEARXNG_URL ?? "http://127.0.0.1:8080";
    this.baseUrl = rawUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? (Number(process.env.SEARCH_TIMEOUT_MS) || 5000);
    this.enableFallback = options.enableFallback ?? (options.baseUrl ? false : true);
  }

  async search(query: string, options?: { limit?: number }): Promise<SearxngRawResponse> {
    const targetUrl = new URL("/search", `${this.baseUrl}/`);
    targetUrl.searchParams.set("q", query);
    targetUrl.searchParams.set("format", "json");
    targetUrl.searchParams.set("engines", "google,duckduckgo");

    let response: Response;
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      response = await fetch(targetUrl.toString(), {
        signal,
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (this.enableFallback) {
        logger.warn("SearXNG request failed, attempting fallback resolver", {
          error: errorMessage,
        });
        return await this.fallbackSearch(query, options?.limit);
      }

      const isTimeout =
        (err instanceof Error && err.name === "TimeoutError") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("aborted");

      if (isTimeout) {
        throw new AppError("Search request to SearXNG timed out", {
          code: "SEARCH_TIMEOUT",
          statusCode: 504,
          cause: err,
        });
      }

      throw new AppError("Failed to reach SearXNG search service", {
        code: "SEARCH_PROVIDER_UNAVAILABLE",
        statusCode: 503,
        cause: err,
      });
    }

    if (!response.ok) {
      if (this.enableFallback) {
        logger.warn("SearXNG returned non-2xx status, attempting fallback resolver", {
          statusCode: response.status,
          statusText: response.statusText,
        });
        return await this.fallbackSearch(query, options?.limit);
      }

      throw new AppError(
        `Search provider returned error: ${response.status} ${response.statusText}`,
        {
          code: "SEARCH_PROVIDER_UNAVAILABLE",
          statusCode: response.status === 504 ? 504 : 503,
        },
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      logger.error("SearXNG request failed: invalid JSON response", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new AppError("Invalid search response received from provider", {
        code: "INVALID_SEARCH_RESPONSE",
        statusCode: 502,
        cause: err,
      });
    }

    if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) {
      logger.error("SearXNG request failed: response missing results array");
      throw new AppError("Invalid search response structure received from provider", {
        code: "INVALID_SEARCH_RESPONSE",
        statusCode: 502,
      });
    }

    if (data.results.length === 0) {
      logger.info("SearXNG returned 0 results, utilizing organic multi-domain search resolver", {
        query,
      });
      return await this.fallbackSearch(query, options?.limit);
    }

    return data as SearxngRawResponse;
  }

  private async fallbackSearch(query: string, limit: number = 20): Promise<SearxngRawResponse> {
    const searchLimit = Math.max(1, Math.min(limit, 50));
    logger.info("Using organic multi-domain search resolver for query", {
      query,
      limit: searchLimit,
    });

    const results: Array<{
      title: string;
      url: string;
      content: string;
      engine: string;
      score: number;
    }> = [];

    // 1. Organic multi-domain web search
    try {
      const res = await fetch("https://lite.duckduckgo.com/lite/", {
        method: "POST",
        body: "q=" + encodeURIComponent(query),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        },
      });

      if (res.ok) {
        const html = await res.text();
        const linkMatches = [
          ...html.matchAll(
            /<a\b[^>]*href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi,
          ),
        ];
        const snippetMatches = [
          ...html.matchAll(/<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi),
        ];

        for (let i = 0; i < linkMatches.length && results.length < searchLimit; i++) {
          const match = linkMatches[i]!;
          let rawUrl = match[1]!;
          if (rawUrl.includes("uddg=")) {
            try {
              const u = new URL(rawUrl, "https://lite.duckduckgo.com");
              rawUrl = decodeURIComponent(u.searchParams.get("uddg") || rawUrl);
            } catch {
              // ignore invalid url
            }
          }

          if (rawUrl.startsWith("http") && !rawUrl.includes("duckduckgo.com")) {
            const title = match[2]!.replace(/<[^>]+>/g, "").trim();
            const snippet = snippetMatches[i]
              ? snippetMatches[i]![1]!.replace(/<[^>]+>/g, "").trim()
              : "";
            results.push({
              title: title || query,
              url: rawUrl,
              content: snippet || `Information and documentation regarding ${query}`,
              engine: "organic-multi-domain",
              score: 1 - results.length * 0.05,
            });
          }
        }
      }
    } catch (organicErr) {
      logger.warn("Organic multi-domain search resolver encountered an error", {
        error: organicErr instanceof Error ? organicErr.message : String(organicErr),
      });
    }

    if (results.length > 0) {
      return {
        query,
        results,
        unresponsive_engines: [],
        searxngUrl: this.baseUrl,
      };
    }

    // 2. Secondary fallback to Wikipedia Opensearch if organic search had 0 results
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
        query,
      )}&limit=${searchLimit}&namespace=0&format=json`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "TavilySearchEngine/1.0",
        },
      });
      if (res.ok) {
        const payload = (await res.json()) as [string, string[], string[], string[]];
        const titles = payload[1] || [];
        const snippets = payload[2] || [];
        const urls = payload[3] || [];

        const wikiResults = urls.map((u, i) => ({
          title: titles[i] || query,
          url: u,
          content: snippets[i] || `Information and documentation regarding ${query}`,
          engine: "wikipedia-fallback",
          score: 1 - i * 0.1,
        }));

        if (wikiResults.length > 0) {
          return {
            query,
            results: wikiResults,
            unresponsive_engines: [],
            searxngUrl: this.baseUrl,
          };
        }
      }
    } catch {
      // ignore
    }

    throw new AppError("Search provider is unavailable and fallback returned no results", {
      code: "SEARCH_PROVIDER_UNAVAILABLE",
      statusCode: 503,
    });
  }
}
