import axios from "axios";
import http from "node:http";
import https from "node:https";
import { z } from "zod";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import type { FailedEngine, SearchTopic, SearxngRawResponse, TimeRange } from "../types.js";

export const DEFAULT_SEARXNG_URL = "http://localhost:8080";
export const PAGES_TO_FETCH = [1, 2] as const;
export const PAGE_TIMEOUT_MS = 3000;

// Reuse TCP connections to your local SearXNG instance instead of
// renegotiating a handshake on every single request.
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

export interface SearxngParams {
  language: string;
  topic: SearchTopic;
  timeRange: TimeRange | undefined;
}

export const searxngRawResultSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional(),
  engine: z.string().optional(),
  engines: z.array(z.string()).optional(),
});

export const searxngRawResponseSchema = z.object({
  query: z.string().optional(),
  results: z.array(searxngRawResultSchema),
  unresponsive_engines: z.unknown().optional(),
});

export function validateSearxngResponse(data: unknown): SearxngRawResponse {
  const result = searxngRawResponseSchema.safeParse(data);
  if (!result.success) {
    throw new AppError(`Invalid SearXNG response: ${result.error.message}`, {
      code: "SEARXNG_UNAVAILABLE",
      statusCode: 502,
      cause: result.error,
    });
  }
  return result.data;
}

/** Single attempt at fetching one result page from SearXNG. */
export async function fetchFromSearxng(
  query: string,
  searxngUrl: string,
  params: SearxngParams,
  pageno: number,
): Promise<SearxngRawResponse> {
  const response = await axios.get(`${searxngUrl}/search`, {
    params: {
      q: query,
      format: "json",
      language: params.language,
      categories: params.topic,
      pageno,
      ...(params.timeRange ? { time_range: params.timeRange } : {}),
    },
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    // Fail fast rather than let one slow page hang the request. Pair this
    // with a short engine timeout in SearXNG's own settings.yml.
    timeout: PAGE_TIMEOUT_MS,
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    httpAgent,
    httpsAgent,
  });

  return validateSearxngResponse(response.data);
}

export interface FetchPagesResult {
  pages: SearxngRawResponse[];
  hasFailedPages: boolean;
  lastError: unknown;
}

/**
 * Fetches every page in parallel. A failed page is skipped as long as at
 * least one page succeeded; the caller decides what to do if none did.
 */
export async function fetchPages(
  query: string,
  searxngUrl: string,
  params: SearxngParams,
): Promise<FetchPagesResult> {
  const settled = await Promise.allSettled(
    PAGES_TO_FETCH.map((pageno) => fetchFromSearxng(query, searxngUrl, params, pageno)),
  );

  const pages: SearxngRawResponse[] = [];
  const failedPages: number[] = [];
  let lastError: unknown;

  settled.forEach((outcome, i) => {
    const pageno = PAGES_TO_FETCH[i] ?? i + 1;
    if (outcome.status === "fulfilled") {
      pages.push(outcome.value);
      return;
    }
    failedPages.push(pageno);
    lastError = outcome.reason;
    logger.warn("[searchService] SearXNG page request failed", {
      pageno,
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    });
  });

  return {
    pages,
    hasFailedPages: failedPages.length > 0,
    lastError,
  };
}

export function parseFailedEngines(raw: unknown): FailedEngine[] {
  if (!Array.isArray(raw)) return [];
  const failed: FailedEngine[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      failed.push({
        engine: entry[0],
        reason: typeof entry[1] === "string" ? entry[1] : "unknown",
      });
    }
  }
  return failed;
}
