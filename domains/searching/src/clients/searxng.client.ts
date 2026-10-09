import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import type { SearxngRawResponse } from "../types/search.types.js";

export interface SearxngClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class SearxngClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: SearxngClientOptions = {}) {
    const rawUrl = options.baseUrl ?? process.env.SEARXNG_URL ?? "http://127.0.0.1:8080";
    this.baseUrl = rawUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? (Number(process.env.SEARCH_TIMEOUT_MS) || 5000);
  }

  async search(query: string): Promise<SearxngRawResponse> {
    const targetUrl = new URL("/search", `${this.baseUrl}/`);
    targetUrl.searchParams.set("q", query);
    targetUrl.searchParams.set("format", "json");
    targetUrl.searchParams.set("engines", "google");

    let response: Response;
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      response = await fetch(targetUrl.toString(), {
        signal,
        headers: {
          Accept: "application/json",
        },
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        logger.error("SearXNG request failed: timeout", { timeoutMs: this.timeoutMs });
        throw new AppError("Search provider request timed out", {
          code: "SEARCH_TIMEOUT",
          statusCode: 504,
          cause: err,
        });
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("SearXNG request failed", { error: errorMessage });
      throw new AppError("Search provider is unavailable", {
        code: "SEARCH_PROVIDER_UNAVAILABLE",
        statusCode: 503,
        cause: err,
      });
    }

    if (!response.ok) {
      logger.error("SearXNG request failed with non-2xx status", {
        statusCode: response.status,
        statusText: response.statusText,
      });
      throw new AppError(
        `Search provider returned error: ${response.status} ${response.statusText}`,
        {
          code: "SEARCH_PROVIDER_UNAVAILABLE",
          statusCode: 503,
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

    return data as SearxngRawResponse;
  }
}
