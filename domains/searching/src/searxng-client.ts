import { logger } from "@tavily/logger";
import { AppError } from "@tavily/errors";
import type { SearXNGRawResponse, SearchOptions } from "./types.js";
import type { SearXNGEnv } from "./config.js";

// HTTP client for communicating with the SearXNG instance
export class SearXNGClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: SearXNGEnv) {
    this.baseUrl = config.SEARXNG_BASE_URL;
    this.timeoutMs = config.SEARXNG_TIMEOUT_MS;
    this.maxRetries = config.SEARXNG_MAX_RETRIES;
  }

  // Executes query against SearXNG with retry support
  async search(query: string, options: SearchOptions = {}): Promise<SearXNGRawResponse> {
    const url = this.buildSearchUrl(query, options);
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          logger.warn("Retrying SearXNG request", {
            attempt,
            maxRetries: this.maxRetries,
            delayMs,
          });
          await this.delay(delayMs);
        }

        return await this.executeRequest(url);
      } catch (error) {
        lastError = error;

        if (error instanceof AppError && !this.isRetryable(error)) {
          throw error;
        }

        logger.error("SearXNG request failed", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw new AppError("SearXNG search failed after all retries", {
      code: "SEARXNG_REQUEST_FAILED",
      statusCode: 502,
      cause: lastError,
      details: { query, retriesAttempted: this.maxRetries },
    });
  }

  // Constructs SearXNG search URL with query parameters
  private buildSearchUrl(query: string, options: SearchOptions): string {
    const url = new URL("/search", this.baseUrl);
    const params = url.searchParams;

    params.set("q", query);
    params.set("format", "json");

    if (options.categories?.length) {
      params.set("categories", options.categories.join(","));
    }

    if (options.engines?.length) {
      params.set("engines", options.engines.join(","));
    }

    if (options.language !== undefined) {
      params.set("language", options.language);
    }

    if (options.timeRange !== undefined) {
      params.set("time_range", options.timeRange);
    }

    if (options.safeSearch !== undefined) {
      params.set("safesearch", String(options.safeSearch));
    }

    if (options.pageno !== undefined) {
      params.set("pageno", String(options.pageno));
    }

    return url.toString();
  }

  // Sends HTTP GET request with abort timeout
  private async executeRequest(url: string): Promise<SearXNGRawResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      logger.debug("Sending request to SearXNG", { url });

      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AppError(`SearXNG returned HTTP ${String(response.status)}`, {
          code: "SEARXNG_HTTP_ERROR",
          statusCode: response.status,
          details: {
            url,
            status: response.status,
            statusText: response.statusText,
          },
        });
      }

      const data: unknown = await response.json();
      return data as SearXNGRawResponse;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new AppError("SearXNG request timed out", {
          code: "SEARXNG_TIMEOUT",
          statusCode: 504,
          details: { url, timeoutMs: this.timeoutMs },
        });
      }

      throw new AppError("Failed to connect to SearXNG", {
        code: "SEARXNG_CONNECTION_ERROR",
        statusCode: 502,
        cause: error,
        details: { url },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private isRetryable(error: AppError): boolean {
    return error.statusCode >= 500 || error.code === "SEARXNG_TIMEOUT";
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
