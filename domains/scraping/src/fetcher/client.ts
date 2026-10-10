import { Agent, request } from "undici";
import zlib from "node:zlib";
import { logger } from "@tavily/logger";
import { validateSsrf } from "../url/ssrf.js";
import {
  FetchTimeoutError,
  ResponseTooLargeError,
  HttpError,
  RateLimitedError,
  InvalidUrlError,
  CrawlError,
} from "../types/error.types.js";
import { calculateBackoff, isRetryableStatus, parseRetryAfter, sleep } from "./retry.js";
import type { FetchOptions, FetchResponse } from "./types.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; TavilyBot/1.0; +https://tavily.com/bot)";
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export class HttpFetcher {
  private readonly agent: Agent;
  private readonly defaultMaxBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRedirects: number;

  constructor(
    options: {
      maxBytes?: number;
      timeoutMs?: number;
      maxRedirects?: number;
      connections?: number;
    } = {},
  ) {
    this.defaultMaxBytes = options.maxBytes ?? 10 * 1024 * 1024; // 10MB
    this.defaultTimeoutMs = options.timeoutMs ?? 15000; // 15s
    this.defaultMaxRedirects = options.maxRedirects ?? 5;

    // Custom Undici Agent for connection pooling
    this.agent = new Agent({
      connections: options.connections ?? 64,
      pipelining: 1,
      keepAliveTimeout: 10000,
      keepAliveMaxTimeout: 30000,
    });
  }

  public async close(): Promise<void> {
    await this.agent.close();
  }

  /**
   * Performs an HTTP fetch with connection pooling, streaming byte limits,
   * SSRF defense on all redirect hops, and automatic exponential backoff.
   */
  public async fetch(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
    const maxRetries = options.maxRetries ?? 3;
    let attempt = 0;

    while (true) {
      try {
        return await this.executeFetchWithRedirects(url, options);
      } catch (err: unknown) {
        attempt++;

        // Never retry permanent client errors or SSRF blocks
        if (
          err instanceof InvalidUrlError ||
          (err instanceof CrawlError && err.code === "SSRF_BLOCKED") ||
          (err instanceof HttpError && !err.retryable) ||
          err instanceof ResponseTooLargeError
        ) {
          throw err;
        }

        if (attempt > maxRetries) {
          logger.warn("Fetch retries exhausted", {
            url,
            attempt,
            maxRetries,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        let delayMs = calculateBackoff(attempt, options.retryDelayMs ?? 1000);

        if (err instanceof RateLimitedError && err.retryAfterSeconds) {
          delayMs = Math.max(delayMs, err.retryAfterSeconds * 1000);
        }

        logger.info("Retrying transient fetch error", {
          url,
          attempt,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        });

        await sleep(delayMs);
      }
    }
  }

  /**
   * Follows redirects manually up to maxRedirects, enforcing SSRF validation on every step.
   */
  private async executeFetchWithRedirects(
    initialUrl: string,
    options: FetchOptions,
  ): Promise<FetchResponse> {
    const startTime = performance.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxBytes = options.maxBytes ?? this.defaultMaxBytes;
    const maxRedirects = options.maxRedirects ?? this.defaultMaxRedirects;
    const allowLocal = options.allowLocalNetwork ?? false;

    let currentUrl = initialUrl;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      // 1. SSRF check on initial URL and on EVERY redirect hop location
      await validateSsrf(currentUrl, allowLocal);

      const requestHeaders: Record<string, string> = {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        ...(options.headers ?? {}),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      const requestSignal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

      try {
        const response = await request(currentUrl, {
          dispatcher: this.agent,
          method: "GET",
          headers: requestHeaders,
          signal: requestSignal,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });

        const statusCode = response.statusCode;
        const headers: Record<string, string> = {};
        for (const [key, val] of Object.entries(response.headers)) {
          if (val !== undefined) {
            headers[key.toLowerCase()] = Array.isArray(val) ? val.join(", ") : String(val);
          }
        }

        // 2. Handle 3xx Redirects
        if (REDIRECT_STATUS_CODES.has(statusCode)) {
          clearTimeout(timer);
          const locationHeader = headers["location"];
          if (!locationHeader) {
            throw new HttpError(currentUrl, statusCode, "Redirect missing Location header");
          }

          const nextUrl = new URL(locationHeader, currentUrl).toString();
          redirectCount++;

          if (redirectCount > maxRedirects) {
            throw new HttpError(
              currentUrl,
              statusCode,
              `Exceeded maximum redirect limit of ${maxRedirects}`,
            );
          }

          logger.debug("Following redirect hop", {
            from: currentUrl,
            to: nextUrl,
            redirectCount,
            statusCode,
          });

          // Discard current stream
          await response.body.dump();
          currentUrl = nextUrl;
          continue; // Loop and validate SSRF on nextUrl!
        }

        // 3. Handle Rate Limiting (429)
        if (statusCode === 429) {
          clearTimeout(timer);
          const retryAfterMs = parseRetryAfter(headers["retry-after"]);
          const retryAfterSec = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : undefined;
          await response.body.dump();
          throw new RateLimitedError(currentUrl, retryAfterSec);
        }

        // 4. Handle other error statuses
        if (statusCode >= 400) {
          clearTimeout(timer);
          await response.body.dump();
          const retryable = isRetryableStatus(statusCode);
          throw new HttpError(currentUrl, statusCode, `HTTP ${statusCode}`, retryable);
        }

        // 5. Stream response with strict byte limits
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        for await (const chunk of response.body) {
          const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bufferChunk.length;

          if (totalBytes > maxBytes) {
            clearTimeout(timer);
            await response.body.destroy();
            throw new ResponseTooLargeError(currentUrl, totalBytes, maxBytes);
          }

          chunks.push(bufferChunk);
        }

        clearTimeout(timer);

        let bodyBuffer = Buffer.concat(chunks);
        const contentEncoding = headers["content-encoding"]?.toLowerCase().trim();

        try {
          if (contentEncoding === "gzip") {
            bodyBuffer = zlib.gunzipSync(bodyBuffer);
          } else if (contentEncoding === "deflate") {
            bodyBuffer = zlib.inflateSync(bodyBuffer);
          } else if (contentEncoding === "br") {
            bodyBuffer = zlib.brotliDecompressSync(bodyBuffer);
          }
        } catch (decompErr: unknown) {
          logger.warn("Decompression failed, falling back to raw buffer", {
            url: currentUrl,
            encoding: contentEncoding,
            error: decompErr instanceof Error ? decompErr.message : String(decompErr),
          });
        }

        const bodyText = bodyBuffer.toString("utf-8");
        const contentType = headers["content-type"] ?? "text/html";
        const tookMs = Math.max(0, Math.round(performance.now() - startTime));

        return {
          url: currentUrl,
          statusCode,
          statusText: "OK",
          headers,
          body: bodyText,
          byteLength: totalBytes,
          contentType,
          tookMs,
        };
      } catch (err: unknown) {
        clearTimeout(timer);

        if (controller.signal.aborted) {
          throw new FetchTimeoutError(currentUrl, timeoutMs);
        }
        throw err;
      }
    }

    throw new HttpError(currentUrl, 310, `Exceeded maximum redirect limit of ${maxRedirects}`);
  }
}
