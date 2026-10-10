import http from "node:http";
import https from "node:https";
import net from "node:net";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import type {
  FetchedHttpResponse,
  HttpFetchOptions,
  HttpRequestContext,
  HttpTransportFn,
} from "../types/scraping.types.js";
import { validateUrlForScraping, revalidateRedirectUrl } from "../utils/url-validator.js";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB (accommodates rich encyclopedia & documentation pages)
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 (compatible; TavilyScraper/1.0)";

/**
 * Extracts the primary MIME type (e.g., 'text/html' from 'text/html; charset=utf-8').
 */
function extractMimeType(contentTypeHeader: string | undefined): string {
  if (!contentTypeHeader) return "";
  const parts = contentTypeHeader.split(";");
  return (parts[0] ?? "").trim().toLowerCase();
}

export type PinnedLookupFn = {
  (
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void;
  (
    hostname: string,
    options: { all: true } | (Record<string, unknown> & { all: true }),
    callback: (
      err: NodeJS.ErrnoException | null,
      addresses: Array<{ address: string; family: number }>,
    ) => void,
  ): void;
  (
    hostname: string,
    options: unknown,
    callback?: (
      err: NodeJS.ErrnoException | null,
      addressOrAddresses: unknown,
      family?: number,
    ) => void,
  ): void;
};

/**
 * Creates a custom DNS lookup function that returns the pre-validated numeric IP address,
 * preventing DNS rebinding / TOCTOU attacks while preserving the original Host header and TLS SNI.
 */
export function createPinnedLookup(pinnedIp: string): PinnedLookupFn {
  const isIpv6 = net.isIP(pinnedIp) === 6;
  const family = isIpv6 ? 6 : 4;

  const lookupFn: PinnedLookupFn = (_lookupHost: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as (
      err: NodeJS.ErrnoException | null,
      addressOrAddresses: unknown,
      family?: number,
    ) => void;
    const isAll =
      typeof opts === "object" && opts !== null && Boolean((opts as { all?: boolean }).all);

    if (isAll) {
      callback(null, [{ address: pinnedIp, family }]);
    } else {
      callback(null, pinnedIp, family);
    }
  };

  return lookupFn;
}

/**
 * Executes a single, connection-pinned HTTP or HTTPS request with streaming size enforcement.
 */
async function defaultHttpTransport(
  context: HttpRequestContext,
  allowedContentTypes: string[],
): Promise<{
  statusCode: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    if (context.signal?.aborted) {
      reject(
        new AppError("Request was aborted", {
          code: "SCRAPE_ABORTED",
          statusCode: 499,
          details: { url: context.url },
        }),
      );
      return;
    }

    const pinnedIp = context.pinnedIp;
    if (net.isIP(pinnedIp) === 0) {
      reject(
        new AppError(`Cannot pin connection to invalid numeric IP address '${pinnedIp}'`, {
          code: "DNS_RESOLUTION_FAILED",
          statusCode: 400,
          details: { pinnedIp, url: context.url },
        }),
      );
      return;
    }

    const isHttps = context.parsedUrl.protocol === "https:";
    const transportModule = isHttps ? https : http;
    const customLookup = createPinnedLookup(pinnedIp);

    const port = context.parsedUrl.port ? Number(context.parsedUrl.port) : isHttps ? 443 : 80;

    const requestHeaders: Record<string, string> = {
      Host: context.parsedUrl.host,
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "identity", // Disable compression bombs by default
      Connection: "close",
      ...context.headers,
    };

    const requestOptions: http.RequestOptions & https.RequestOptions = {
      protocol: context.parsedUrl.protocol,
      hostname: context.parsedUrl.hostname,
      port,
      path: context.parsedUrl.pathname + context.parsedUrl.search,
      method: "GET",
      headers: requestHeaders,
      lookup: customLookup as unknown as http.RequestOptions["lookup"],
      // For HTTPS: Ensure TLS SNI and server certificate validation match the domain
      ...(isHttps ? { servername: context.parsedUrl.hostname } : {}),
    };

    let isFinished = false;
    let activeRes: http.IncomingMessage | null = null;

    const onAbort = () => {
      cleanupAndReject(
        new AppError("Request was aborted", {
          code: "SCRAPE_ABORTED",
          statusCode: 499,
          details: { url: context.url },
        }),
      );
    };

    const cleanupAndReject = (err: unknown) => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timer);
      if (context.signal) {
        context.signal.removeEventListener("abort", onAbort);
      }
      req.destroy();
      if (activeRes && !activeRes.destroyed) {
        activeRes.destroy();
      }
      reject(err);
    };

    if (context.signal) {
      context.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      cleanupAndReject(
        new AppError(`Request timed out after ${context.timeoutMs}ms`, {
          code: "SCRAPE_TIMEOUT",
          statusCode: 504,
          details: { timeoutMs: context.timeoutMs, url: context.url },
        }),
      );
    }, context.timeoutMs);

    const req = transportModule.request(requestOptions, (res) => {
      activeRes = res;
      const statusCode = res.statusCode ?? 500;
      const headersRecord: Record<string, string> = {};

      for (const [key, val] of Object.entries(res.headers)) {
        if (typeof val === "string") {
          headersRecord[key.toLowerCase()] = val;
        } else if (Array.isArray(val) && val.length > 0) {
          headersRecord[key.toLowerCase()] = val.join(", ");
        }
      }

      // Check Content-Length upfront before buffering
      const contentLengthHeader = headersRecord["content-length"];
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (!Number.isNaN(contentLength) && contentLength > context.maxSizeBytes) {
          cleanupAndReject(
            new AppError(
              `Response Content-Length (${contentLength} bytes) exceeds limit of ${context.maxSizeBytes} bytes`,
              {
                code: "RESPONSE_TOO_LARGE",
                statusCode: 413,
                details: { maxSizeBytes: context.maxSizeBytes, contentLength, url: context.url },
              },
            ),
          );
          return;
        }
      }

      // If redirect, we do not need to stream the body
      const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);
      if (isRedirect) {
        isFinished = true;
        clearTimeout(timer);
        req.destroy();
        if (res && !res.destroyed) {
          res.destroy();
        }
        resolve({
          statusCode,
          contentType: headersRecord["content-type"] ?? "",
          headers: headersRecord,
          body: "",
        });
        return;
      }

      // Validate Content-Type
      const rawContentType = headersRecord["content-type"];
      const mimeType = extractMimeType(rawContentType);
      if (!mimeType || !allowedContentTypes.includes(mimeType)) {
        cleanupAndReject(
          new AppError(
            `Unsupported content type '${rawContentType ?? "unknown"}'. Permitted types: ${allowedContentTypes.join(", ")}`,
            {
              code: "UNSUPPORTED_CONTENT_TYPE",
              statusCode: 415,
              details: {
                contentType: rawContentType ?? "unknown",
                allowedContentTypes,
                url: context.url,
              },
            },
          ),
        );
        return;
      }

      let receivedBytes = 0;
      const chunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => {
        if (isFinished) return;

        receivedBytes += chunk.length;
        if (receivedBytes > context.maxSizeBytes) {
          cleanupAndReject(
            new AppError(
              `Response size exceeded maximum limit of ${context.maxSizeBytes} bytes while streaming`,
              {
                code: "RESPONSE_TOO_LARGE",
                statusCode: 413,
                details: { maxSizeBytes: context.maxSizeBytes, receivedBytes, url: context.url },
              },
            ),
          );
        } else {
          chunks.push(chunk);
        }
      });

      res.on("end", () => {
        if (isFinished) return;
        isFinished = true;
        clearTimeout(timer);
        if (context.signal) {
          context.signal.removeEventListener("abort", onAbort);
        }
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve({
          statusCode,
          contentType: rawContentType ?? "",
          headers: headersRecord,
          body,
        });
      });

      res.on("error", (err) => {
        cleanupAndReject(
          new AppError(`Stream error during response: ${err.message}`, {
            code: "NETWORK_ERROR",
            statusCode: 502,
            cause: err,
          }),
        );
      });
    });

    req.on("error", (err) => {
      cleanupAndReject(
        new AppError(`Network request failed: ${err.message}`, {
          code: "NETWORK_ERROR",
          statusCode: 502,
          cause: err,
        }),
      );
    });

    req.end();
  });
}

/**
 * Secure HTTP Client with connection-level DNS pinning, streaming size limits,
 * redirect revalidation, and SSRF guard integration.
 */
export class HttpFetcher {
  private readonly defaultTransport?: HttpTransportFn | undefined;

  constructor(defaultTransport?: HttpTransportFn) {
    this.defaultTransport = defaultTransport;
  }

  /**
   * Fetches an HTTP/HTTPS webpage securely.
   *
   * 1. Validates destination URL and resolves DNS.
   * 2. Enforces SSRF protection (rejecting private IPs, link-local, loopback, cloud metadata).
   * 3. Pins the connection to the verified IP (preventing DNS rebinding / TOCTOU).
   * 4. Enforces timeouts and streaming response size bounds.
   * 5. Revalidates every redirect destination before following.
   * 6. Strips sensitive credentials on cross-origin redirects.
   */
  async fetch(url: string, options: HttpFetchOptions = {}): Promise<FetchedHttpResponse> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;

    let currentUrl = url;
    let redirectCount = 0;
    const visitedUrls = new Set<string>();
    let effectiveHeaders: Record<string, string> = { ...(options.headers ?? {}) };

    // 1. Initial destination validation and DNS resolution
    let validated = await validateUrlForScraping(currentUrl, {
      dnsLookup: options.dnsLookup,
      allowPrivateNetworks: options.allowPrivateNetworks,
    });

    while (true) {
      if (options.signal?.aborted) {
        throw new AppError("Request was aborted", {
          code: "SCRAPE_ABORTED",
          statusCode: 499,
          details: { url: currentUrl },
        });
      }

      // 2. Select pinned numeric IP address
      const pinnedIp = validated.resolvedIps[0];
      if (!pinnedIp || net.isIP(pinnedIp) === 0) {
        throw new AppError(
          `No valid numeric IP address available for host '${validated.parsedUrl.hostname}'`,
          {
            code: "DNS_RESOLUTION_FAILED",
            statusCode: 400,
            details: { hostname: validated.parsedUrl.hostname },
          },
        );
      }

      // 3. Detect redirect loop
      if (visitedUrls.has(validated.canonicalUrl)) {
        throw new AppError(`Redirect loop detected for URL '${validated.canonicalUrl}'`, {
          code: "REDIRECT_LOOP",
          statusCode: 400,
          details: { url: validated.canonicalUrl, visitedUrls: Array.from(visitedUrls) },
        });
      }
      visitedUrls.add(validated.canonicalUrl);

      // 4. Prepare request context
      const context: HttpRequestContext = {
        url: currentUrl,
        parsedUrl: validated.parsedUrl,
        pinnedIp,
        timeoutMs,
        maxSizeBytes,
        headers: effectiveHeaders,
        signal: options.signal,
      };

      // 5. Execute request
      let response: {
        statusCode: number;
        contentType: string;
        headers: Record<string, string>;
        body: string;
      };

      const transportToUse = options.transport ?? this.defaultTransport;
      if (transportToUse) {
        const customRes = await transportToUse(context);
        response = {
          statusCode: customRes.statusCode,
          contentType: customRes.contentType,
          headers: customRes.headers,
          body: customRes.body,
        };
      } else {
        response = await defaultHttpTransport(context, allowedContentTypes);
      }

      // 6. Handle redirects
      const isRedirect = [301, 302, 303, 307, 308].includes(response.statusCode);
      if (isRedirect) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new AppError(`Maximum redirect limit of ${maxRedirects} exceeded`, {
            code: "TOO_MANY_REDIRECTS",
            statusCode: 400,
            details: { maxRedirects, redirectCount, lastUrl: currentUrl },
          });
        }

        const locationHeader = response.headers["location"];
        if (!locationHeader || !locationHeader.trim()) {
          throw new AppError(`Redirect response (${response.statusCode}) missing Location header`, {
            code: "INVALID_REDIRECT",
            statusCode: 400,
            details: { url: currentUrl, statusCode: response.statusCode },
          });
        }

        // Revalidate the redirect destination with SSRF protection BEFORE making next request
        const revalidated = await revalidateRedirectUrl(locationHeader, currentUrl, {
          dnsLookup: options.dnsLookup,
          allowPrivateNetworks: options.allowPrivateNetworks,
        });

        // Strip sensitive authentication headers on cross-origin redirects
        const previousOrigin = validated.parsedUrl.origin;
        const nextOrigin = revalidated.parsedUrl.origin;

        if (previousOrigin !== nextOrigin) {
          const sensitiveHeaderNames = new Set(["authorization", "cookie", "proxy-authorization"]);
          const strippedHeaders: Record<string, string> = {};
          for (const [key, val] of Object.entries(effectiveHeaders)) {
            if (!sensitiveHeaderNames.has(key.toLowerCase())) {
              strippedHeaders[key] = val;
            }
          }
          effectiveHeaders = strippedHeaders;
        }

        logger.debug("Following verified redirect", {
          from: currentUrl,
          to: revalidated.parsedUrl.toString(),
          redirectCount,
        });

        currentUrl = revalidated.parsedUrl.toString();
        // Reuse revalidated result directly to avoid duplicate DNS resolution (SEC-04)
        validated = revalidated;
        continue;
      }

      // 7. Check final HTTP status code
      if (response.statusCode >= 400) {
        throw new AppError(`HTTP request failed with status ${response.statusCode}`, {
          code: "HTTP_ERROR",
          statusCode: response.statusCode,
          details: { statusCode: response.statusCode, url: currentUrl },
        });
      }

      return {
        requestedUrl: url,
        finalUrl: currentUrl,
        statusCode: response.statusCode,
        contentType: response.contentType,
        body: response.body,
        resolvedIp: pinnedIp,
        headers: response.headers,
      };
    }
  }
}
