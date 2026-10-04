import pLimit from 'p-limit';
import type { ZodType } from 'zod';
import { HttpClient, HttpError, type HttpClientOptions } from '../transport/http.js';
import { detectMode } from '../detection/content-type.js';
import { extractFromPage, parsePage, type ParsedPage, type ParseOptions } from '../extraction/extract.js';
import type { HtmlParser } from '../parsers/html.js';
import { buildPageUrl, getInitialPageUrl, getNextPageInfo } from '../pagination/pagination.js';
import { AsyncQueue, throwIfAborted } from '../util/async.js';
import type {
  PageDocument,
  PageEvent,
  PaginationConfig,
  Renderer,
  ScrapeMode,
  ScrapeTarget,
  ScrapeOptions,
  ScrapeItem,
  ScrapeFailure,
  ScrapeStats,
  ScrapeResult,
} from './types.js';

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_HIGH_WATER_MARK = 256;
const DEFAULT_MAX_RECORDED_FAILURES = 100;

/** Sentinel value returned by `validate()` for schema-invalid items. */
const INVALID = Symbol('INVALID');

/** Abort reason used when the consumer stops iterating early. */
const CONSUMER_STOPPED = 'Scrape consumer stopped';

/** Abort reason used when `ScrapeOptions.deadlineMs` expires. */
const DEADLINE_REACHED = 'Scrape deadline reached';

/** Abort reasons that end a run normally instead of failing it. */
const GRACEFUL_STOPS: ReadonlySet<string> = new Set([CONSUMER_STOPPED, DEADLINE_REACHED]);

// ─── Configuration ────────────────────────────────────────────────────

export interface UniversalScraperConfig {
  http?: HttpClientOptions;
  renderer?: Renderer;

  /**
   * HTML parser backend (default: `parse5`). `htmlparser2` is measurably
   * faster for CPU-bound HTML workloads; see `HtmlParser` for the trade-off.
   */
  htmlParser?: HtmlParser;

  /** Cap on how many individual `ScrapeFailure` objects are kept (default: 100). */
  maxRecordedFailures?: number;
}

// ─── Internal types ───────────────────────────────────────────────────

/** State shared by every target of one `stream()` call. */
interface RunContext {
  stats: ScrapeStats;
  queue: AsyncQueue<ScrapeItem>;
  onPage: ((event: PageEvent) => void) | undefined;
  /** Aborts when the caller cancels, a fatal page error occurs, or the consumer stops. */
  signal: AbortSignal;
  maxItems: number;
  dedupeKey: ((data: unknown) => string | undefined) | undefined;
  seenKeys: Set<string> | null;
  /** In-flight page fetches keyed by request identity; null when coalescing is off. */
  inFlight: Map<string, Promise<PageDocument>> | null;
}

/** A fetched, parsed page with its extracted (not yet validated) items. */
interface FetchedPage {
  url: string;
  document: PageDocument;
  page: ParsedPage;
  items: unknown[];
}

/** Lets the page loops report which URL was being processed when they threw. */
interface PageCursor {
  pageUrl: string;
}

// ─── Scraper ──────────────────────────────────────────────────────────

export class UniversalScraper {
  readonly http: HttpClient;
  private readonly renderer?: Renderer;
  private readonly maxRecordedFailures: number;
  private readonly parseOptions: ParseOptions;

  constructor(config: UniversalScraperConfig = {}) {
    this.http = new HttpClient(config.http);
    this.renderer = config.renderer;
    this.parseOptions = { htmlParser: config.htmlParser };
    this.maxRecordedFailures = config.maxRecordedFailures ?? DEFAULT_MAX_RECORDED_FAILURES;
  }

  /**
   * Streams scraped items one-by-one via an async generator.
   *
   * The generator's *return value* (accessible via `iterator.next()` when
   * `done === true`) contains the final `ScrapeStats`.
   */
  async *stream<T = unknown>(
    targets: readonly ScrapeTarget<T>[],
    options: ScrapeOptions = {},
  ): AsyncGenerator<ScrapeItem<T>, ScrapeStats, void> {
    const started = performance.now();
    const stats = createEmptyStats(targets.length);

    if (targets.length === 0) {
      stats.durationMs = performance.now() - started;
      return stats;
    }

    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    const highWaterMark = Math.max(1, options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK);

    const limit = pLimit(concurrency);
    const producerController = new AbortController();
    const ctx: RunContext = {
      stats,
      queue: new AsyncQueue<ScrapeItem>(highWaterMark),
      onPage: options.onPage,
      signal: options.signal
        ? AbortSignal.any([options.signal, producerController.signal])
        : producerController.signal,
      maxItems: options.maxItems === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.maxItems),
      dedupeKey: options.dedupeKey,
      seenKeys: options.dedupeKey ? new Set<string>() : null,
      inFlight: options.coalesceRequests === false ? null : new Map(),
    };

    let producersDone = false;
    const deadlineTimer = options.deadlineMs === undefined
      ? undefined
      : setTimeout(() => {
        if (producersDone || producerController.signal.aborted) return;
        stats.truncated = true;
        producerController.abort(new Error(DEADLINE_REACHED));
      }, Math.max(0, options.deadlineMs));

    // ── Background producer ───────────────────────────────────────
    const runTarget = async (target: ScrapeTarget): Promise<void> => {
      const cursor: PageCursor = { pageUrl: target.url };

      try {
        const firstUrl = getInitialPageUrl(this.http.resolve(target.url), target.pagination);
        cursor.pageUrl = firstUrl;

        if (pageConcurrencyOf(target.pagination) > 1) {
          await this.runPagesInParallel(target, firstUrl, ctx, cursor);
        } else {
          await this.runPagesSequentially(target, firstUrl, ctx, cursor);
        }
      } catch (error) {
        // Ignore errors caused by abort (consumer stopped or another target
        // already triggered a failure). Only record genuine page errors.
        if (!producerController.signal.aborted && !options.signal?.aborted) {
          const failure: ScrapeFailure = {
            sourceUrl: target.url,
            pageUrl: cursor.pageUrl,
            message: error instanceof Error ? error.message : String(error),
            status: error instanceof HttpError ? error.status : undefined,
          };
          stats.failedPages += 1;
          recordFailure(stats, this.maxRecordedFailures, failure);
          notify(options.onFailure, failure);

          if (!options.continueOnPageError) {
            producerController.abort(error);
          }
        }
      }
    };

    const produce = async (): Promise<void> => {
      try {
        await Promise.all(targets.map((target) => limit(() => runTarget(target))));
        producersDone = true;

        if (options.signal?.aborted) {
          ctx.queue.fail(options.signal.reason);
        } else if (
          !options.continueOnPageError
          && producerController.signal.aborted
          && !GRACEFUL_STOPS.has((producerController.signal.reason as Error | undefined)?.message ?? '')
        ) {
          ctx.queue.fail(producerController.signal.reason);
        } else {
          ctx.queue.close();
        }
      } catch (error) {
        ctx.queue.fail(error);
      }
    };

    // Fire-and-forget the producer; errors flow through the queue.
    void produce();

    // ── Yield items to the consumer ───────────────────────────────
    try {
      while (true) {
        const next = await ctx.queue.next();
        if (next.done) break;
        // Items were validated by the target's ZodType<T> (or T is unknown).
        yield next.value as ScrapeItem<T>;
      }
    } finally {
      clearTimeout(deadlineTimer);
      producerController.abort(new Error(CONSUMER_STOPPED));
      ctx.queue.close();
      stats.durationMs = performance.now() - started;
    }

    return stats;
  }

  /**
   * Convenience wrapper: runs `stream()` to completion and collects all
   * items into an array.
   */
  async scrape<T = unknown>(
    targets: readonly ScrapeTarget<T>[],
    options: ScrapeOptions = {},
  ): Promise<ScrapeResult<T>> {
    const iterator = this.stream(targets, options);
    const items: ScrapeItem<T>[] = [];

    for (;;) {
      const next = await iterator.next();
      if (next.done) return { items, stats: next.value };
      items.push(next.value);
    }
  }

  // ── Page loops ──────────────────────────────────────────────────

  /**
   * Default loop: each page decides the next URL (cursor, next-link, or the
   * page counter), so pages are fetched one after another.
   */
  private async runPagesSequentially(
    target: ScrapeTarget,
    firstUrl: string,
    ctx: RunContext,
    cursor: PageCursor,
  ): Promise<void> {
    const requestedMode = resolveRequestedMode(target);
    const pagination = target.pagination;
    const seenUrls = new Set<string>();
    let pageUrl: string | null = firstUrl;
    let pageCount = 0;

    while (pageUrl) {
      cursor.pageUrl = pageUrl;
      throwIfAborted(ctx.signal);
      if (ctx.stats.items >= ctx.maxItems) break;

      if (seenUrls.has(pageUrl)) {
        throw new Error('Pagination cycle detected at ' + pageUrl);
      }
      seenUrls.add(pageUrl);

      if (pagination?.maxPages !== undefined && pageCount >= pagination.maxPages) break;

      const fetched = await this.fetchPage(target, pageUrl, requestedMode, ctx);
      pageCount += 1;

      await emitItems(ctx, target, fetched);
      if (ctx.stats.items >= ctx.maxItems) break;

      if (!pagination || pagination.mode === 'none') break;
      pageUrl = getNextPageInfo(
        fetched.page,
        fetched.document.contentType,
        pagination,
        pageUrl,
        fetched.items.length,
      ).nextUrl;
    }
  }

  /**
   * Opt-in loop for `page` mode with `pageConcurrency > 1`: page numbers are
   * known up front, so a batch of consecutive pages is fetched together and
   * processed in order. The run stops at the first empty page (unless
   * `stopWhenEmpty: false`), `maxPages`, or `maxItems`. Pages fetched in the
   * same batch after the stop point are discarded.
   */
  private async runPagesInParallel(
    target: ScrapeTarget,
    firstUrl: string,
    ctx: RunContext,
    cursor: PageCursor,
  ): Promise<void> {
    const requestedMode = resolveRequestedMode(target);
    const pagination = target.pagination as PaginationConfig;
    const pageParam = pagination.pageParam ?? 'page';
    const batchSize = pageConcurrencyOf(pagination);

    // `getInitialPageUrl` guarantees the page parameter is present.
    let nextPage = Number(new URL(firstUrl).searchParams.get(pageParam));
    let pageCount = 0;
    let done = false;

    while (!done) {
      throwIfAborted(ctx.signal);
      if (ctx.stats.items >= ctx.maxItems) break;

      const remaining = pagination.maxPages === undefined
        ? batchSize
        : Math.min(batchSize, pagination.maxPages - pageCount);
      if (remaining <= 0) break;

      const urls = Array.from({ length: remaining }, (_, i) =>
        buildPageUrl(firstUrl, pageParam, nextPage + i, pagination.pageSizeParam, pagination.pageSize));
      nextPage += remaining;
      pageCount += remaining;

      // Bounded by `remaining` (≤ pageConcurrency) and by the HTTP client's limiter.
      const batch = await Promise.all(urls.map(async (url) => {
        try {
          return await this.fetchPage(target, url, requestedMode, ctx);
        } catch (error) {
          cursor.pageUrl = url;
          throw error;
        }
      }));

      for (const fetched of batch) {
        if (done) break;
        cursor.pageUrl = fetched.url;

        if (fetched.items.length === 0 && pagination.stopWhenEmpty !== false) {
          done = true;
          break;
        }

        await emitItems(ctx, target, fetched);
        if (ctx.stats.items >= ctx.maxItems) done = true;
      }
    }
  }

  // ── Fetching ────────────────────────────────────────────────────

  /** Fetches one page, parses it once, and extracts raw items. */
  private async fetchPage(
    target: ScrapeTarget,
    url: string,
    requestedMode: ScrapeMode,
    ctx: RunContext,
  ): Promise<FetchedPage> {
    // Timing boundaries (see PageEvent): started → fetched → parsed → emitted.
    const started = performance.now();
    const document = await this.fetchShared(target, url, requestedMode, ctx);
    const fetched = performance.now();
    ctx.stats.pages += 1;

    const mode = detectMode(document, requestedMode);
    const page = parsePage(document.body, mode, this.parseOptions);
    const items = extractFromPage(page, target.extraction);
    const parsed = performance.now();

    const totalMs = performance.now() - started;
    notify(ctx.onPage, {
      sourceUrl: target.url,
      pageUrl: url,
      status: document.status,
      contentType: document.contentType,
      itemCount: items.length,
      fetchMs: fetched - started,
      parseMs: parsed - fetched,
      totalMs,
      durationMs: totalMs,
    });

    return { url, document, page, items };
  }

  /**
   * Returns the in-flight fetch for an identical request when there is one,
   * otherwise starts a new fetch. All requests of a run share one abort
   * signal, so a shared promise can never be cancelled by an unrelated caller.
   */
  private fetchShared(
    target: ScrapeTarget,
    url: string,
    requestedMode: ScrapeMode,
    ctx: RunContext,
  ): Promise<PageDocument> {
    if (!ctx.inFlight) return this.fetchDocument(target, url, ctx.signal, requestedMode);

    const key = requestKey(target, url, requestedMode);
    const existing = ctx.inFlight.get(key);
    if (existing) {
      ctx.stats.coalescedRequests += 1;
      return existing;
    }

    const inFlight = ctx.inFlight;
    const pending = this.fetchDocument(target, url, ctx.signal, requestedMode)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  /**
   * Fetches a single page, optionally falling back to the renderer
   * when `target.render` is set.
   */
  private async fetchDocument(
    target: ScrapeTarget,
    url: string,
    signal: AbortSignal,
    requestedMode: ScrapeMode,
  ): Promise<PageDocument> {
    const headers = target.headers;

    if (target.render === 'always') {
      if (!this.renderer) {
        throw new Error('render=always requires a renderer implementation');
      }
      return toDocument(await this.renderer.render(url, { signal, headers }));
    }

    try {
      const response = await this.http.request(url, { headers, signal });
      const contentType = response.headers.get('content-type') ?? '';
      const body = await this.http.readBody(response, url);
      return { url, status: response.status, contentType, body };
    } catch (error) {
      // Only attempt renderer fallback when configured and sensible.
      const canFallback =
        !signal.aborted
        && target.render === 'on-error'
        && this.renderer != null
        && requestedMode !== 'json';

      if (!canFallback || !this.renderer) throw error;

      return toDocument(await this.renderer.render(url, { signal, headers }));
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Validates, deduplicates and enqueues a page's items, reserving `maxItems`
 * slots synchronously so concurrent targets can never overshoot the limit.
 */
async function emitItems(ctx: RunContext, target: ScrapeTarget, fetched: FetchedPage): Promise<void> {
  const { stats, maxItems } = ctx;

  for (let index = 0; index < fetched.items.length && stats.items < maxItems; index += 1) {
    throwIfAborted(ctx.signal);

    const value = target.schema ? validate(target.schema, fetched.items[index]) : fetched.items[index];
    if (value === INVALID) {
      stats.invalidItems += 1;
      continue;
    }

    if (ctx.seenKeys && ctx.dedupeKey) {
      const key = ctx.dedupeKey(value);
      if (key !== undefined) {
        if (ctx.seenKeys.has(key)) {
          stats.duplicateItems += 1;
          continue;
        }
        ctx.seenKeys.add(key);
      }
    }

    // Reserve the slot before the (possibly blocking) push. Nothing awaits
    // between the loop condition and this increment, so it is race-free.
    stats.items += 1;
    try {
      await ctx.queue.push({
        sourceUrl: target.url,
        pageUrl: fetched.url,
        index,
        data: value,
        contentType: fetched.document.contentType,
      });
    } catch (pushError) {
      stats.items -= 1;
      throw pushError;
    }
  }
}

/** Calls an observer hook; a throwing hook must never fail the scrape. */
function notify<E>(hook: ((event: E) => void) | undefined, event: E): void {
  if (!hook) return;
  try {
    hook(event);
  } catch {
    // Observability is best effort.
  }
}

/**
 * Identity of a page request for coalescing: URL, mode (it controls renderer
 * fallback), render setting and headers in a stable order.
 */
function requestKey(target: ScrapeTarget, url: string, requestedMode: ScrapeMode): string {
  const headers = Object.entries(target.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value])
    .sort(([a], [b]) => (a ?? '').localeCompare(b ?? ''));
  return JSON.stringify([url, requestedMode, target.render ?? 'never', headers]);
}

function createEmptyStats(targetCount: number): ScrapeStats {
  return {
    targets: targetCount,
    pages: 0,
    items: 0,
    failedPages: 0,
    invalidItems: 0,
    duplicateItems: 0,
    coalescedRequests: 0,
    truncated: false,
    durationMs: 0,
    failures: [],
  };
}

/**
 * An explicit `target.mode` wins. Otherwise the extraction rule's `type`
 * decides, and only a target with neither falls back to content sniffing.
 */
function resolveRequestedMode(target: ScrapeTarget): ScrapeMode {
  if (target.mode && target.mode !== 'auto') return target.mode;
  return target.extraction?.type ?? 'auto';
}

/** Effective per-target page concurrency; only `page` mode may exceed 1. */
function pageConcurrencyOf(pagination: PaginationConfig | undefined): number {
  if (pagination?.mode !== 'page') return 1;
  return Math.max(1, Math.floor(pagination.pageConcurrency ?? 1));
}

function toDocument(rendered: { url: string; contentType: string; body: string; status?: number }): PageDocument {
  return {
    url: rendered.url,
    status: rendered.status ?? 200,
    contentType: rendered.contentType || 'text/html',
    body: rendered.body,
  };
}

function validate(schema: ZodType<unknown>, value: unknown): unknown {
  const result = schema.safeParse(value);
  return result.success ? result.data : INVALID;
}

function recordFailure(stats: ScrapeStats, max: number, failure: ScrapeFailure): void {
  if (stats.failures.length < max) {
    stats.failures.push(failure);
  }
}

// ─── Standalone Convenience Function ──────────────────────────────────

/**
 * One-shot scrape: creates a scraper, runs it, and returns the result.
 * Useful when you don't need to reuse the HTTP client across calls.
 */
export async function scrape<T = unknown>(
  targets: readonly ScrapeTarget<T>[],
  options: ScrapeOptions = {},
  config: UniversalScraperConfig = {},
): Promise<ScrapeResult<T>> {
  return new UniversalScraper(config).scrape(targets, options);
}
