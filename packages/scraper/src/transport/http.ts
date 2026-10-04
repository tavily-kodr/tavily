import pLimit, { type LimitFunction } from 'p-limit';
import type { ZodType } from 'zod';
import { sleep, throwIfAborted, toError } from '../util/async.js';

// ─── URL Redaction ────────────────────────────────────────────────────

/**
 * Query parameter names (case-insensitive) whose values are hidden in error
 * messages. Substring matches are also redacted for the most common secret
 * words so `x-api-key`, `refresh_token` or `client_secret` are covered.
 */
const SENSITIVE_PARAMS = new Set([
  'key', 'api_key', 'apikey', 'api-key', 'token', 'access_token', 'auth',
  'authorization', 'secret', 'password', 'passwd', 'pwd', 'signature', 'sig',
  'client_secret', 'session', 'sessionid', 'sid',
]);
const SENSITIVE_SUBSTRINGS = ['token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'api-key', 'signature'];
/** Alphanumeric so it survives URL serialisation without percent-encoding. */
const REDACTED = 'REDACTED';

/**
 * Returns `url` with credentials and sensitive query values replaced by
 * `REDACTED`. Used for every error message so API keys passed in query
 * strings or userinfo do not end up in logs. Unparseable input is returned
 * unchanged.
 */
export function redactUrl(url: string, extraParams: readonly string[] = []): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.password) parsed.password = REDACTED;

  const extra = new Set(extraParams.map((name) => name.toLowerCase()));
  for (const name of [...parsed.searchParams.keys()]) {
    const lower = name.toLowerCase();
    const sensitive = SENSITIVE_PARAMS.has(lower)
      || extra.has(lower)
      || SENSITIVE_SUBSTRINGS.some((word) => lower.includes(word));
    if (sensitive) parsed.searchParams.set(name, REDACTED);
  }

  return parsed.toString();
}

// ─── Error Classes ────────────────────────────────────────────────────

/**
 * Thrown when the server returns a non-OK, non-retryable status code.
 * `url` is already redacted (see `redactUrl`).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    /** Optional explanation of why the request was not retried. */
    readonly detail?: string,
  ) {
    const reason = detail ? ` (${detail})` : '';
    const preview = body ? `: ${body.slice(0, 300)}` : '';
    super(`HTTP ${status} for ${url}${reason}${preview}`);
    this.name = 'HttpError';
  }
}

/** Thrown when a response body exceeds `HttpClientOptions.maxResponseBytes`. */
export class ResponseTooLargeError extends Error {
  constructor(
    readonly url: string,
    readonly limitBytes: number,
    /** Bytes declared by Content-Length, or bytes read before giving up. */
    readonly receivedBytes: number,
  ) {
    super(`Response from ${url} exceeds maxResponseBytes=${limitBytes} (received at least ${receivedBytes} bytes)`);
    this.name = 'ResponseTooLargeError';
  }
}

/** Thrown when a request exceeds `HttpClientOptions.timeoutMs` on every attempt. */
export class RequestTimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Thrown when the request could not complete at the transport level
 * (DNS, connection refused, reset, TLS). The underlying error is kept as
 * `cause`; its code (e.g. `ECONNREFUSED`) is surfaced in the message so a
 * failure record is actionable without digging into nested objects.
 */
export class NetworkError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(`Request to ${url} failed: ${describeCause(cause)}`, { cause });
    this.name = 'NetworkError';
  }
}

/** Thrown when a response body cannot be parsed as expected. */
export class ResponseParseError extends Error {
  constructor(readonly url: string, message: string) {
    super(`Failed to parse ${url}: ${message}`);
    this.name = 'ResponseParseError';
  }
}

// ─── Configuration ────────────────────────────────────────────────────

export interface PerHostOptions {
  /** Max in-flight requests to a single host (default: unlimited). */
  concurrency?: number;

  /**
   * Minimum spacing between request starts to the same host, in ms
   * (default: 0). `minIntervalMs: 200` means at most five requests per
   * second per host, regardless of concurrency.
   */
  minIntervalMs?: number;
}

export interface HttpClientOptions {
  /** Base URL for resolving relative paths (e.g. "https://api.example.com"). */
  baseUrl?: string;

  /** Max concurrent in-flight HTTP requests across all hosts (default: 16). */
  concurrency?: number;

  /**
   * Per-host limits applied in addition to the global `concurrency`, so one
   * busy host cannot be hammered while others stay idle. State is kept per
   * distinct host for the lifetime of the client.
   */
  perHost?: PerHostOptions;

  /** Per-request timeout in milliseconds (default: 15 000). */
  timeoutMs?: number;

  /** Max retry attempts for retryable failures (default: 3). */
  retries?: number;

  /** Initial back-off delay in ms for exponential retry (default: 250). */
  baseDelayMs?: number;

  /** Maximum back-off delay cap in ms (default: 8 000). */
  maxDelayMs?: number;

  /**
   * Longest `Retry-After` wait the client will honour, in ms (default: 30 000).
   * When a server asks for a longer pause the request fails immediately with
   * an `HttpError` instead of sleeping; the caller decides whether to come back.
   */
  maxRetryAfterMs?: number;

  /**
   * Maximum response body size in bytes (default: 10 MiB). Bodies larger
   * than this throw `ResponseTooLargeError` instead of being buffered.
   * Checked against Content-Length first, then enforced while streaming.
   */
  maxResponseBytes?: number;

  /**
   * Additional query parameter names (case-insensitive) to redact from
   * error messages, on top of the built-in list (key, token, secret, …).
   */
  sensitiveParams?: readonly string[];

  /** Default headers merged into every request. */
  headers?: Record<string, string>;

  /** Swap in a custom `fetch` implementation (useful for testing). */
  fetchImpl?: typeof fetch;

  /**
   * Opt-in conditional GET cache. Responses that carry an `ETag` are kept in
   * memory (bounded, oldest evicted first) and later requests for the same
   * URL send `If-None-Match`. A `304 Not Modified` is answered from memory,
   * saving the body transfer and the server's rendering work. Entries live
   * only as long as the client; nothing is persisted.
   */
  revalidate?: RevalidateOptions;

  /**
   * Opt-in request hedging for GET and HEAD. When an attempt has not produced
   * a response after `afterMs`, a second identical request is started and
   * whichever responds first is used; the other is aborted. This trims tail
   * latency at the cost of extra load on slow requests only. Both copies go
   * through the same concurrency and per-host limits. Leave it off for
   * servers that may treat duplicate requests as abuse.
   */
  hedge?: HedgeOptions;

  /**
   * Called after every attempt (success, retryable failure, or final error)
   * with a redacted URL. Intended for metrics and logging; exceptions are
   * swallowed so a logging bug cannot fail a request.
   */
  onRequest?: (event: RequestEvent) => void;
}

export interface HedgeOptions {
  /**
   * Delay before the duplicate request is sent, in ms. Set it near the
   * endpoint's p90 latency so only the slowest ~10% of requests are hedged.
   */
  afterMs: number;
}

export interface RevalidateOptions {
  /** Maximum number of cached responses (default: 100). */
  maxEntries?: number;
}

/** One HTTP attempt as reported to `HttpClientOptions.onRequest`. */
export interface RequestEvent {
  /** Redacted request URL. */
  url: string;
  method: string;
  /** 0 for the first attempt, incremented per retry. */
  attempt: number;
  /** Response status, or undefined when the attempt failed before a response. */
  status?: number;
  /** Error message when the attempt failed before a response. */
  error?: string;
  durationMs: number;
  /** True when the client will retry after this attempt. */
  willRetry: boolean;
  /** True when a hedged duplicate was started during this attempt. */
  hedged: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────

/** HTTP status codes that are safe to retry automatically. */
const RETRYABLE_STATUSES = new Set([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const DEFAULT_HEADERS: Record<string, string> = {
  'accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  'user-agent': 'universal-scraper/1.0',
};

// ─── Client ───────────────────────────────────────────────────────────

export class HttpClient {
  private readonly limiter: LimitFunction;
  private readonly perHostConcurrency: number | undefined;
  private readonly perHostIntervalMs: number;
  private readonly hosts = new Map<string, HostState>();
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxResponseBytes: number;
  private readonly sensitiveParams: readonly string[];
  private readonly onRequest: ((event: RequestEvent) => void) | undefined;
  private readonly revalidation: Map<string, CachedBody> | null;
  private readonly revalidationMaxEntries: number;
  private readonly hedgeAfterMs: number | undefined;

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.limiter = pLimit(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY));
    this.perHostConcurrency = options.perHost?.concurrency === undefined
      ? undefined
      : Math.max(1, options.perHost.concurrency);
    this.perHostIntervalMs = Math.max(0, options.perHost?.minIntervalMs ?? 0);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.headers = { ...DEFAULT_HEADERS, ...options.headers };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.sensitiveParams = options.sensitiveParams ?? [];
    this.onRequest = options.onRequest;
    this.revalidation = options.revalidate ? new Map() : null;
    this.revalidationMaxEntries = Math.max(1, options.revalidate?.maxEntries ?? 100);
    this.hedgeAfterMs = options.hedge ? Math.max(0, options.hedge.afterMs) : undefined;
  }

  /**
   * Opens a connection to `url`'s origin ahead of time so the first real
   * request skips DNS and TLS setup. Failures (including HTTP errors, which
   * still prove the connection works) are swallowed. Returns the elapsed ms.
   */
  async warmup(url: string, signal?: AbortSignal): Promise<number> {
    const started = performance.now();
    try {
      await this.request(url, { method: 'HEAD', signal });
    } catch {
      // Warm-up is best effort.
    }
    return performance.now() - started;
  }

  /** Redacts credentials and sensitive query values for safe logging. */
  redact(url: string): string {
    return redactUrl(url, this.sensitiveParams);
  }

  /** Resolves a (possibly relative) URL against the configured `baseUrl`. */
  resolve(url: string): string {
    try {
      return this.baseUrl
        ? new URL(url, this.baseUrl).toString()
        : new URL(url).toString();
    } catch {
      const hint = this.baseUrl ? '' : ' (relative URLs require HttpClientOptions.baseUrl)';
      throw new Error(`Invalid URL "${url}"${hint}`);
    }
  }

  /**
   * Sends a GET/POST/etc. request with automatic retries and back-off.
   *
   * Retryable status codes (429, 5xx, etc.) are retried up to `retries` times.
   * Non-retryable errors (e.g. 404) throw immediately.
   */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const target = this.resolve(url);
    const host = new URL(target).host;
    const requestHeaders = new Headers(this.headers);
    new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));

    const method = (init.method ?? 'GET').toUpperCase();
    const cached = method === 'GET' ? this.revalidation?.get(target) : undefined;
    if (cached) {
      requestHeaders.set('if-none-match', cached.etag);
      // Node's fetch adds `Cache-Control: no-cache` to conditional requests when
      // none is set, and many servers then skip the 304 shortcut. `max-age=0`
      // asks for validation without that side effect.
      if (!requestHeaders.has('cache-control')) requestHeaders.set('cache-control', 'max-age=0');
    }
    const canHedge = this.hedgeAfterMs !== undefined && (method === 'GET' || method === 'HEAD');
    const send = (signal: AbortSignal | null | undefined): Promise<Response> =>
      this.withHostLimits(host, signal, () =>
        this.limiter(() => this.sendWithTimeout(target, { ...init, headers: requestHeaders, signal })),
      );
    let attempt = 0;

    for (;;) {
      throwIfAborted(init.signal);
      const attemptStarted = performance.now();
      let hedged = false;
      const report = (event: Pick<RequestEvent, 'status' | 'error' | 'willRetry'>): void => {
        if (!this.onRequest) return;
        try {
          this.onRequest({ url: this.redact(target), method, attempt, durationMs: performance.now() - attemptStarted, hedged, ...event });
        } catch {
          // Observability must never break the request path.
        }
      };

      try {
        const response = canHedge
          ? await sendHedged(send, init.signal, this.hedgeAfterMs ?? 0, () => { hedged = true; })
          : await send(init.signal);

        if (response.status === 304 && cached) {
          report({ status: 304, willRetry: false });
          await response.body?.cancel().catch(() => undefined);
          return new Response(cached.text, { status: 200, headers: { 'content-type': cached.contentType, 'x-revalidated': '1' } });
        }

        if (response.ok) {
          report({ status: response.status, willRetry: false });
          return response;
        }

        if (!RETRYABLE_STATUSES.has(response.status) || attempt >= this.retries) {
          report({ status: response.status, willRetry: false });
          const body = await this.safePreview(response);
          throw new HttpError(response.status, this.redact(target), body);
        }
        report({ status: response.status, willRetry: true });

        // Respect the server's Retry-After header when present, but never
        // sleep longer than the caller allows: surface the status instead.
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (retryAfter !== null && retryAfter > this.maxRetryAfterMs) {
          const body = await this.safePreview(response);
          throw new HttpError(
            response.status,
            this.redact(target),
            body,
            `Retry-After of ${Math.ceil(retryAfter / 1000)}s exceeds maxRetryAfterMs=${this.maxRetryAfterMs}`,
          );
        }
        await response.body?.cancel().catch(() => undefined);
        await sleep(
          retryAfter ?? backoff(attempt, this.baseDelayMs, this.maxDelayMs),
          init.signal,
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // A caller cancellation is final: never retry it as a network failure.
        if (init.signal?.aborted) throw toError(init.signal.reason);
        const willRetry = attempt < this.retries;
        report({ error: toError(error).message, willRetry });
        if (!willRetry) throw toRequestError(error, this.redact(target), this.timeoutMs);

        await sleep(backoff(attempt, this.baseDelayMs, this.maxDelayMs), init.signal);
      }

      attempt += 1;
    }
  }

  /**
   * Reads a response body as text while enforcing `maxResponseBytes`.
   * Decodes using the charset from Content-Type when present (UTF-8 otherwise).
   * Pass `url` for error messages when `response.url` is empty (e.g. mocks).
   */
  async readBody(response: Response, url: string = response.url): Promise<string> {
    const limit = this.maxResponseBytes;
    const safeUrl = this.redact(url);

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(safeUrl, limit, declared);
    }

    if (!response.body) return response.text();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(safeUrl, limit, received);
      }
      chunks.push(value);
    }

    const text = decodeChunks(chunks, received, response.headers.get('content-type'));
    this.remember(url, response, text);
    return text;
  }

  /** Stores an ETag-bearing body for later conditional requests. */
  private remember(url: string, response: Response, text: string): void {
    const etag = response.headers.get('etag');
    if (!this.revalidation || !etag || !response.ok) return;

    let key: string;
    try {
      key = this.resolve(url);
    } catch {
      return;
    }

    // The cached text is already decoded; serve it back as UTF-8.
    const contentType = (response.headers.get('content-type') ?? 'text/plain').replace(/;\s*charset=[^;]*/i, '') + '; charset=utf-8';
    this.revalidation.delete(key);
    this.revalidation.set(key, { etag, text, contentType });
    if (this.revalidation.size > this.revalidationMaxEntries) {
      const oldest = this.revalidation.keys().next().value;
      if (oldest !== undefined) this.revalidation.delete(oldest);
    }
  }

  /** Convenience: fetches a URL and returns the body as a string. */
  async text(url: string, init: RequestInit = {}): Promise<string> {
    const resolved = this.resolve(url);
    const response = await this.request(resolved, init);
    return this.readBody(response, resolved);
  }

  /** Convenience: fetches a URL and parses the body as JSON. */
  async json<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const resolved = this.resolve(url);
    const response = await this.request(resolved, init);
    const text = await this.readBody(response, resolved);

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ResponseParseError(this.redact(resolved), 'response was not valid JSON');
    }
  }

  /** Convenience: fetches JSON and validates it against a Zod schema. */
  async jsonAs<T>(url: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const raw = await this.json(url, init);
    const parsed = schema.safeParse(raw);

    if (!parsed.success) {
      throw new ResponseParseError(this.redact(this.resolve(url)), 'JSON did not match the expected schema');
    }

    return parsed.data;
  }

  /**
   * Applies per-host limits around `send`. The host slot is taken first and
   * the global slot second, so a host at its limit never holds a global slot
   * that another host could use.
   */
  private withHostLimits<T>(host: string, signal: AbortSignal | null | undefined, send: () => Promise<T>): Promise<T> {
    if (this.perHostConcurrency === undefined && this.perHostIntervalMs === 0) return send();

    const state = this.hostState(host);
    const run = async (): Promise<T> => {
      await this.waitForHostSlot(state, signal);
      return send();
    };
    return state.limiter ? state.limiter(run) : run();
  }

  private hostState(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = {
        limiter: this.perHostConcurrency === undefined ? null : pLimit(this.perHostConcurrency),
        nextStartAt: 0,
      };
      this.hosts.set(host, state);
    }
    return state;
  }

  /**
   * Reserves the next start time for this host synchronously (so concurrent
   * callers cannot claim the same slot), then sleeps until it arrives.
   */
  private async waitForHostSlot(state: HostState, signal: AbortSignal | null | undefined): Promise<void> {
    if (this.perHostIntervalMs === 0) return;
    const now = Date.now();
    const startAt = Math.max(now, state.nextStartAt);
    state.nextStartAt = startAt + this.perHostIntervalMs;
    if (startAt > now) await sleep(startAt - now, signal);
  }

  /** Reads a bounded preview of an error body for messages; '' on failure. */
  private async safePreview(response: Response): Promise<string> {
    try {
      return await this.readBody(response);
    } catch {
      return '';
    }
  }

  /** Wraps `fetch` with a per-request timeout signal. */
  private async sendWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;

    return this.fetchImpl(url, { ...init, signal: combined });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Starts `send`; if it has not produced a response after `afterMs`, starts a
 * second copy. Resolves with the first response, aborting and draining the
 * other copy. Rejects only when every started copy failed (with the first
 * error), or immediately if the first copy fails before the hedge started,
 * so normal retry handling still applies.
 */
function sendHedged(
  send: (signal: AbortSignal) => Promise<Response>,
  outer: AbortSignal | null | undefined,
  afterMs: number,
  onHedge: () => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const legs: AbortController[] = [];
    let settled = false;
    let failures = 0;
    let firstError: unknown;

    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
    };

    const launch = (): void => {
      const leg = new AbortController();
      legs.push(leg);
      const signal = outer ? AbortSignal.any([outer, leg.signal]) : leg.signal;

      send(signal).then(
        (response) => {
          if (settled) {
            void response.body?.cancel().catch(() => undefined);
            return;
          }
          finish();
          for (const other of legs) if (other !== leg) other.abort(new Error('Hedged request lost the race'));
          resolve(response);
        },
        (error: unknown) => {
          if (settled) return;
          failures += 1;
          if (failures === 1) firstError = error;
          if (failures === legs.length) {
            finish();
            reject(toError(firstError));
          }
        },
      );
    };

    // `finish` reads `timer`; it only runs from async callbacks, after this line.
    const timer = setTimeout(() => {
      if (settled || outer?.aborted) return;
      onHedge();
      launch();
    }, afterMs);
    launch();
  });
}

interface CachedBody {
  etag: string;
  text: string;
  contentType: string;
}

interface HostState {
  limiter: LimitFunction | null;
  /** Epoch ms before which no new request to this host may start. */
  nextStartAt: number;
}

/** Jittered exponential back-off: `base * 2^attempt` capped at `max`. */
function backoff(attempt: number, base: number, max: number): number {
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * Parses the `Retry-After` header.
 * Supports both delay-in-seconds and HTTP-date formats.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
}

/** Converts a failed `fetch` into a typed, URL-bearing error. */
function toRequestError(error: unknown, url: string, timeoutMs: number): Error {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new RequestTimeoutError(url, timeoutMs);
  }
  return new NetworkError(url, error);
}

/** Summarises a fetch failure, preferring the nested cause's code/message (undici wraps them). */
function describeCause(cause: unknown): string {
  const error = toError(cause);
  const inner: unknown = (error as { cause?: unknown }).cause;
  if (inner && typeof inner === 'object') {
    const code = (inner as { code?: unknown }).code;
    const message = (inner as { message?: unknown }).message;
    // Connection attempts that fail on every address (AggregateError) carry a
    // code but an empty message; show just the code rather than "CODE ()".
    const detail = typeof message === 'string' && message !== '' && message !== code ? message : undefined;
    if (typeof code === 'string') return detail ? `${code} (${detail})` : code;
    if (detail) return detail;
  }
  return error.message;
}

/** Concatenates body chunks and decodes them with the response charset (UTF-8 fallback). */
function decodeChunks(chunks: Uint8Array[], total: number, contentType: string | null): string {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const charset = /charset=["']?([\w.-]+)/i.exec(contentType ?? '')?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(merged);
}
