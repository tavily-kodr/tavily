import type { ZodType, ZodTypeDef } from 'zod';

// ─── Mode & Pagination ────────────────────────────────────────────────

export type ScrapeMode = 'auto' | 'json' | 'html';
export type PaginationMode = 'none' | 'next-link' | 'page' | 'cursor' | 'offset';

// ─── Extraction ───────────────────────────────────────────────────────

/** Rules that tell the extractor how to pull items out of a page. */
export interface ExtractionRule {
  /**
   * Which parser the rule is written for. When `ScrapeTarget.mode` is unset
   * or `'auto'`, this also selects how the page is parsed, so a JSON rule
   * applied to an HTML response fails loudly instead of yielding page blobs.
   */
  type: 'json' | 'html';

  /** JSON dot-path to the items array, e.g. "products" or "data.items". */
  path?: string;

  /** CSS selector for HTML extraction. */
  selector?: string;

  /** Per-field rules applied to each matched HTML element. */
  fields?: Record<string, HtmlFieldRule>;
}

/** Describes how to extract a single field from an HTML element. */
export interface HtmlFieldRule {
  /** Optional sub-selector scoped to the matched element. */
  selector?: string;

  /** If set, reads this attribute instead of the text content. */
  attribute?: string;

  /** When true, reads `.textContent` (default behaviour when no attribute). */
  text?: boolean;
}

// ─── Pagination ───────────────────────────────────────────────────────

export interface PaginationConfig {
  mode: PaginationMode;

  /** Maximum number of pages to fetch per target (default: unlimited). */
  maxPages?: number;

  /** Query-string parameter carrying the page number (default: "page"). */
  pageParam?: string;

  /**
   * Page number requested first when the target URL has no `pageParam`
   * (default: 1). The first request is made with this value set explicitly.
   */
  startPage?: number;

  /** Query-string parameter carrying the page size, e.g. "limit". */
  pageSizeParam?: string;

  /**
   * Page size sent with every request when `pageSizeParam` is set. In
   * `offset` mode it also advances the offset and ends pagination early when
   * a page returns fewer items than this.
   */
  pageSize?: number;

  /** `offset` mode: query parameter carrying the item offset (default: "offset"). */
  offsetParam?: string;

  /** `offset` mode: first offset requested when the URL has no `offsetParam` (default: 0). */
  startOffset?: number;

  /**
   * `page` mode only: how many page-number URLs to fetch concurrently per
   * target (default: 1, sequential). Safe only when pages are independent
   * and stable, which is why it is opt-in. Items are still emitted in page
   * order. Up to `pageConcurrency - 1` pages past the last non-empty page
   * may be fetched and discarded; they count towards `stats.pages` and
   * `maxPages`. Ignored for cursor and next-link modes, whose next page
   * depends on the previous response.
   */
  pageConcurrency?: number;

  /** Stop paginating when a page yields zero items (default: true). */
  stopWhenEmpty?: boolean;

  /** JSON path to the "next" link in API responses. */
  nextPath?: string;

  /** Query-string parameter name for the cursor value. */
  cursorParam?: string;

  /** JSON path to the next-cursor value in API responses. */
  nextCursorPath?: string;
}

// ─── Targets & Options ────────────────────────────────────────────────

/**
 * A single URL (or URL pattern) to scrape.
 *
 * `T` is the item type produced after `schema` validation. It is inferred
 * from the Zod schema, so `scrape([{ url, schema: productSchema }])` yields
 * `ScrapeItem<Product>[]`. Targets without a schema produce `unknown`.
 */
export interface ScrapeTarget<T = unknown> {
  url: string;

  /**
   * Parse mode. `'json'`/`'html'` force a parser. When unset or `'auto'`, the
   * `extraction.type` is used if present, otherwise the response is sniffed.
   */
  mode?: ScrapeMode;
  extraction?: ExtractionRule;
  pagination?: PaginationConfig;
  schema?: ZodType<T, ZodTypeDef, unknown>;
  render?: 'never' | 'on-error' | 'always';
  headers?: Record<string, string>;
}

/** Options that control how a scrape run behaves. */
export interface ScrapeOptions {
  /**
   * Maximum number of targets processed in parallel (default: 8). Pages
   * within one target are fetched sequentially because each page may depend
   * on the previous response (cursor, next-link). Requests across all targets
   * are additionally bounded by `HttpClientOptions.concurrency`.
   */
  concurrency?: number;

  /** Stop after emitting this many items in total, across all targets and pages. */
  maxItems?: number;

  /**
   * Wall-clock budget for the whole run in milliseconds. When it expires,
   * in-flight requests are aborted and the run ends normally with the items
   * collected so far and `stats.truncated = true`. Unlike `signal`, hitting
   * the deadline does not reject. Page failures that happen before the
   * deadline still follow `continueOnPageError`.
   */
  deadlineMs?: number;

  /**
   * Returns a stable key for an item (e.g. its id or URL). Items whose key
   * was already emitted during this run are dropped and counted in
   * `stats.duplicateItems`. Return `undefined` to exempt an item. Keys are
   * held in memory for the duration of the run.
   */
  dedupeKey?: (data: unknown) => string | undefined;

  /**
   * Share one in-flight request between pages of this run that ask for the
   * same URL with the same headers and render setting (default: true). Each
   * target still receives and emits the page's items. Only concurrent
   * requests are merged; a later request for the same URL is sent again, so
   * this is not a cache. Merged requests are counted in
   * `stats.coalescedRequests`.
   */
  coalesceRequests?: boolean;

  /** Internal queue buffer size before back-pressure kicks in (default: 256). */
  highWaterMark?: number;

  /** Abort signal – cancels all in-flight requests when triggered. */
  signal?: AbortSignal;

  /**
   * When true, a failed page is recorded in `stats.failures` and the other
   * targets keep running. When false (default) the first page failure aborts
   * the run and `scrape()`/`stream()` reject with that error.
   */
  continueOnPageError?: boolean;

  /**
   * Called after each page has been fetched, parsed and extracted. Useful for
   * progress logging and metrics. Exceptions thrown by the hook are ignored.
   */
  onPage?: (event: PageEvent) => void;

  /**
   * Called for every recorded page failure, before `continueOnPageError` is
   * applied. Exceptions thrown by the hook are ignored.
   */
  onFailure?: (failure: ScrapeFailure) => void;
}

// ─── Result Types ─────────────────────────────────────────────────────

/** Intermediate representation of a fetched page (before extraction). */
export interface PageDocument {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

/** One extracted item yielded by the scraper. */
export interface ScrapeItem<T = unknown> {
  sourceUrl: string;
  pageUrl: string;
  index: number;
  data: T;
  contentType: string;
}

/** Progress event emitted via `ScrapeOptions.onPage`. */
export interface PageEvent {
  sourceUrl: string;
  pageUrl: string;
  status: number;
  contentType: string;
  /** Raw items extracted from the page, before validation and deduplication. */
  itemCount: number;
  /**
   * Time from the start of the page request until the response body was fully
   * read (or the renderer returned). Includes waiting for a concurrency or
   * per-host rate-limit slot, retries and back-off sleeps, and body download.
   * Excludes parsing.
   */
  fetchMs: number;
  /** Time spent on content-type detection, parsing (JSON or HTML) and item extraction. */
  parseMs: number;
  /** Wall time for the page: `fetchMs + parseMs` plus negligible bookkeeping. */
  totalMs: number;
  /** Same value as `totalMs`; kept for backward compatibility. */
  durationMs: number;
}

/** Records why a particular page failed. */
export interface ScrapeFailure {
  sourceUrl: string;
  pageUrl: string;
  message: string;
  /** HTTP status when the failure was a non-OK response. */
  status?: number;
}

/** Aggregate statistics for a completed scrape run. */
export interface ScrapeStats {
  targets: number;
  pages: number;
  items: number;
  failedPages: number;
  /** Items rejected by the target's Zod schema. */
  invalidItems: number;
  /** Items dropped by `ScrapeOptions.dedupeKey`. */
  duplicateItems: number;
  /** Page fetches answered by an identical request already in flight (see `coalesceRequests`). */
  coalescedRequests: number;
  /** True when `ScrapeOptions.deadlineMs` expired before all work finished. */
  truncated: boolean;
  durationMs: number;
  failures: ScrapeFailure[];
}

/** The final output of `scraper.scrape()`. */
export interface ScrapeResult<T = unknown> {
  items: ScrapeItem<T>[];
  stats: ScrapeStats;
}

// ─── Renderer (optional headless browser integration) ─────────────────

/** Implement this interface to plug in a headless browser renderer. */
export interface Renderer {
  render(
    url: string,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<RenderedPage>;
}

export interface RenderedPage {
  url: string;
  contentType: string;
  body: string;
  status?: number;
}
