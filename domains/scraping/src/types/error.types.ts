import { AppError, type AppErrorOptions } from "@tavily/errors";

export interface CrawlErrorOptions extends AppErrorOptions {
  url?: string;
  retryable?: boolean;
}

export class CrawlError extends AppError {
  public readonly url?: string;
  public readonly retryable: boolean;

  constructor(message: string, options: CrawlErrorOptions = {}) {
    super(message, options);
    this.name = "CrawlError";
    if (options.url !== undefined) {
      this.url = options.url;
    }
    this.retryable = options.retryable ?? false;
  }
}

export class InvalidUrlError extends CrawlError {
  constructor(url: string, reason = "URL is malformed or invalid") {
    super(`Invalid URL '${url}': ${reason}`, {
      code: "INVALID_URL",
      statusCode: 400,
      url,
      retryable: false,
    });
    this.name = "InvalidUrlError";
  }
}

export class SsrfBlockedError extends CrawlError {
  constructor(url: string, reason = "Target resolves to private or restricted network") {
    super(`SSRF blocked for '${url}': ${reason}`, {
      code: "SSRF_BLOCKED",
      statusCode: 403,
      url,
      retryable: false,
    });
    this.name = "SsrfBlockedError";
  }
}

export class FetchTimeoutError extends CrawlError {
  constructor(url: string, timeoutMs: number) {
    super(`Request to '${url}' timed out after ${timeoutMs}ms`, {
      code: "FETCH_TIMEOUT",
      statusCode: 504,
      url,
      retryable: true,
    });
    this.name = "FetchTimeoutError";
  }
}

export class RobotsBlockedError extends CrawlError {
  constructor(url: string, userAgent = "*") {
    super(`URL '${url}' is blocked by robots.txt for user-agent '${userAgent}'`, {
      code: "ROBOTS_BLOCKED",
      statusCode: 403,
      url,
      retryable: false,
    });
    this.name = "RobotsBlockedError";
  }
}

export class ResponseTooLargeError extends CrawlError {
  constructor(url: string, currentBytes: number, maxBytes: number) {
    super(`Response body for '${url}' exceeded byte limit (${currentBytes} > ${maxBytes} bytes)`, {
      code: "RESPONSE_TOO_LARGE",
      statusCode: 413,
      url,
      retryable: false,
    });
    this.name = "ResponseTooLargeError";
  }
}

export class HttpError extends CrawlError {
  public readonly httpStatus: number;

  constructor(url: string, status: number, statusText: string, retryable = false) {
    super(`HTTP ${status} (${statusText}) for '${url}'`, {
      code: "HTTP_ERROR",
      statusCode: status >= 400 && status < 600 ? status : 500,
      url,
      retryable,
      details: { status, statusText },
    });
    this.name = "HttpError";
    this.httpStatus = status;
  }
}

export class RateLimitedError extends CrawlError {
  public readonly retryAfterSeconds?: number;

  constructor(url: string, retryAfterSeconds?: number) {
    super(
      `Rate limited on '${url}'${retryAfterSeconds ? `, retry after ${retryAfterSeconds}s` : ""}`,
      {
        code: "RATE_LIMITED",
        statusCode: 429,
        url,
        retryable: true,
        details: { retryAfterSeconds },
      },
    );
    this.name = "RateLimitedError";
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}
