import axios from "axios";
import http from "node:http";
import https from "node:https";
import { z } from "zod";
import { AppError } from "@tavily/errors";
import type { FailedEngine, SearchTopic, SearxngRawResponse, TimeRange } from "../types.js";

export const DEFAULT_SEARXNG_URL = "http://localhost:8080";

// Engine time budget sent to SearXNG as timeout_limit (capped by its
// max_request_timeout). When it runs out SearXNG answers with whatever the
// engines delivered instead of waiting for the slowest one. Healthy engines
// answer page 1 in well under 1s; a stalled one used to hold every search to 3s.
export const ENGINE_TIMEOUT_MS = 1500;
// Pages after the first are optional, so their engines get less time.
export const OPTIONAL_ENGINE_TIMEOUT_MS = 1000;
// Our deadline must outlast SearXNG's engine timeout. With equal values (the
// old 3s/3.0s) a slow engine made SearXNG answer at ~3.02s and we aborted the
// very response that carried the engines that did answer.
export const RESPONSE_MARGIN_MS = 750;
export const PAGE_DEADLINE_MS = ENGINE_TIMEOUT_MS + RESPONSE_MARGIN_MS;
export const OPTIONAL_PAGE_DEADLINE_MS = OPTIONAL_ENGINE_TIMEOUT_MS + RESPONSE_MARGIN_MS;

// The pinned SearXNG image serves requests with Granian: 1 worker with 4
// blocking threads, so at most 4 requests run at once. Extra requests queue
// inside SearXNG and spend our deadline waiting, so this process never sends
// more than that; the rest wait here, where the wait does not count.
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

// Reuse TCP connections to your local SearXNG instance instead of
// renegotiating a handshake on every single request.
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

/** Counting semaphore; waiters are served in FIFO order. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // The releasing caller hands its slot over, so active stays the same.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

let limiter = new Semaphore(DEFAULT_MAX_CONCURRENT_REQUESTS);

export interface SearxngClientConfig {
  // Requests to SearXNG in flight at once, across all searches.
  maxConcurrentRequests?: number | undefined;
}

/** Replaces the request limiter. The caller passes env-derived settings. */
export function configureSearxngClient(config: SearxngClientConfig = {}): void {
  limiter = new Semaphore(config.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS);
}

export interface SearxngParams {
  language: string;
  topic: SearchTopic;
  timeRange: TimeRange | undefined;
}

export type PageFailureReason =
  "timeout" | "canceled" | "http_4xx" | "http_5xx" | "invalid_response" | "network";

/** A failed page request, with a reason that is safe to log (no query). */
export class SearxngPageError extends Error {
  constructor(
    readonly reason: PageFailureReason,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SearxngPageError";
  }
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

function classifyFailure(err: unknown, signal: AbortSignal): PageFailureReason {
  if (signal.aborted && (signal.reason as Error | undefined)?.name === "TimeoutError") {
    return "timeout";
  }
  if (axios.isCancel(err)) return "canceled";
  if (err instanceof AppError) return "invalid_response";
  if (axios.isAxiosError(err) && err.response) {
    return err.response.status >= 500 ? "http_5xx" : "http_4xx";
  }
  return "network";
}

/**
 * Single attempt at fetching one result page from SearXNG. Waits for a free
 * request slot first; the deadline starts only once the request is sent.
 * Throws SearxngPageError.
 */
export async function fetchFromSearxng(
  query: string,
  searxngUrl: string,
  params: SearxngParams,
  pageno: number,
  engineTimeoutMs: number = ENGINE_TIMEOUT_MS,
): Promise<SearxngRawResponse> {
  const slots = limiter;
  await slots.acquire();
  // One signal per request: a timeout or cancellation never affects another page.
  const signal = AbortSignal.timeout(engineTimeoutMs + RESPONSE_MARGIN_MS);
  try {
    const response = await axios.get(`${searxngUrl}/search`, {
      params: {
        q: query,
        format: "json",
        language: params.language,
        categories: params.topic,
        pageno,
        timeout_limit: engineTimeoutMs / 1000,
        ...(params.timeRange ? { time_range: params.timeRange } : {}),
      },
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal,
      httpAgent,
      httpsAgent,
    });

    return validateSearxngResponse(response.data);
  } catch (err) {
    throw new SearxngPageError(classifyFailure(err, signal), err);
  } finally {
    slots.release();
  }
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
