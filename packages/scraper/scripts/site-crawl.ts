/**
 * Helpers for the site-crawl benchmark (scripts/measure-site.ts): URL
 * normalisation, seed loading and the crawl loop. No file or console I/O here
 * so everything can be unit-tested; the crawl takes the scraper as a parameter.
 */
import type { ExtractionRule, PageEvent, UniversalScraper } from '../src/index.js';

/** Extraction rule that makes the scraper return every anchor's raw href. */
export const LINK_RULE: ExtractionRule = {
  type: 'html',
  selector: 'a[href]',
  fields: { href: { attribute: 'href' } },
};

/**
 * File extensions that are almost never HTML. Links to them are skipped so
 * the benchmark measures page crawling rather than asset downloads.
 */
const ASSET_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|pdf|zip|gz|tar|rar|7z|mp3|mp4|webm|mov|avi|woff2?|ttf|otf|eot|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?)$/i;

/**
 * Resolves `href` against `baseUrl` and returns a canonical absolute URL, or
 * null when the link should not be followed:
 * - schemes other than http(s) (mailto:, tel:, javascript:, data:, ftp:, …)
 * - empty and fragment-only links (`#top`)
 * - unparseable values
 *
 * Canonical form: the fragment is removed; host lower-casing, default-port
 * removal, dot-segment resolution and percent-encoding come from WHATWG URL.
 * Path, trailing slash and query order are kept as-is because servers may
 * treat them as different resources.
 */
export function normalizeUrl(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  let url: URL;
  try {
    url = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.toString();
}

/** True when `url` has exactly the same origin (scheme, host, port) as `origin`. */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** True when the URL path ends in a known non-HTML file extension. */
export function isLikelyAsset(url: string): boolean {
  try {
    return ASSET_EXTENSIONS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Turns raw hrefs found on `pageUrl` into the crawlable, same-origin,
 * de-duplicated (within the page) absolute URLs, in first-seen order.
 */
export function extractLinks(hrefs: readonly string[], pageUrl: string, origin: string): string[] {
  const out = new Set<string>();
  for (const href of hrefs) {
    const url = normalizeUrl(href, pageUrl);
    if (url && isSameOrigin(url, origin) && !isLikelyAsset(url)) out.add(url);
  }
  return [...out];
}

/** Reads the `href` strings out of the items produced by `LINK_RULE`. */
export function hrefsFromItems(items: readonly { data: unknown }[]): string[] {
  const hrefs: string[] = [];
  for (const { data } of items) {
    const href = (data as { href?: unknown } | null)?.href;
    if (typeof href === 'string') hrefs.push(href);
  }
  return hrefs;
}

/**
 * Crawl frontier that records every URL it has ever accepted, so a URL is
 * crawled at most once no matter how many pages link to it.
 */
export class Frontier {
  private readonly seen = new Set<string>();
  private readonly pending: string[] = [];

  /** Adds a URL if it was never seen. Returns true when it was new. */
  add(url: string): boolean {
    if (this.seen.has(url)) return false;
    this.seen.add(url);
    this.pending.push(url);
    return true;
  }

  /** Next URL to crawl in discovery (breadth-first) order. */
  next(): string | undefined {
    return this.pending.shift();
  }

  get discovered(): number {
    return this.seen.size;
  }

  get queued(): number {
    return this.pending.length;
  }
}

// ─── Seeds ────────────────────────────────────────────────────────────

export interface SeedResult {
  /** Normalised, de-duplicated seeds on the crawl origin, in input order (START_URL first). */
  seeds: string[];
  /** Origin every crawled URL must share; null when no valid seed exists. */
  origin: string | null;
  /** 1-based URL_FILE line numbers that were not absolute http(s) URLs. */
  invalidLines: number[];
  /** Valid seeds dropped because they are on a different origin. */
  offOrigin: string[];
  /** Seeds dropped because they normalised to a URL already seeded. */
  duplicates: number;
}

/**
 * Parses an absolute seed URL. Unlike `normalizeUrl`, relative values are
 * rejected because a seed has no page to be relative to.
 */
export function parseSeed(value: string): string | null {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return normalizeUrl(trimmed, trimmed);
}

/**
 * Builds the initial crawl seeds from START_URL and/or URL_FILE contents.
 *
 * - Blank lines are ignored; other lines that are not absolute http(s) URLs
 *   are reported in `invalidLines`.
 * - Seeds are normalised with `normalizeUrl` and de-duplicated.
 * - The crawl origin is START_URL's origin, or the first valid file seed's
 *   origin when START_URL is absent. Seeds on other origins are dropped
 *   (`offOrigin`) so the crawl never leaves one site.
 *
 * Throws when START_URL is given but is not an absolute http(s) URL.
 */
export function loadSeeds(input: { startUrl?: string; fileText?: string }): SeedResult {
  const result: SeedResult = { seeds: [], origin: null, invalidLines: [], offOrigin: [], duplicates: 0 };
  const seen = new Set<string>();

  const accept = (url: string): void => {
    result.origin ??= new URL(url).origin;
    if (!isSameOrigin(url, result.origin)) {
      result.offOrigin.push(url);
    } else if (seen.has(url)) {
      result.duplicates += 1;
    } else {
      seen.add(url);
      result.seeds.push(url);
    }
  };

  if (input.startUrl !== undefined && input.startUrl.trim() !== '') {
    const start = parseSeed(input.startUrl);
    if (!start) throw new Error(`START_URL is not an absolute http(s) URL: ${input.startUrl}`);
    accept(start);
  }

  (input.fileText ?? '').split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const url = parseSeed(line);
    if (url) accept(url);
    else result.invalidLines.push(index + 1);
  });

  return result;
}

// ─── Crawl loop ───────────────────────────────────────────────────────

export interface PageRecord {
  url: string;
  ok: boolean;
  /** Present for successful pages (from PageEvent). */
  fetchMs?: number;
  parseMs?: number;
  /** PageEvent.totalMs on success; wall time of the attempt on failure. */
  totalMs: number;
  /** New-or-known same-origin links found on the page. */
  links: number;
  error?: string;
}

export interface CrawlOptions {
  seeds: readonly string[];
  origin: string;
  maxPages: number;
  concurrency: number;
  deadlineMs: number;
  /** Called once per finished page (success or failure). */
  onRecord?: (record: PageRecord) => void;
}

export interface CrawlResult {
  records: PageRecord[];
  discovered: number;
  abortedAtDeadline: number;
  stopReason: 'deadline' | 'MAX_PAGES' | 'no more links';
  crawlMs: number;
}

/**
 * Fetches and parses one page as a single `scraper.scrape()` call with
 * `LINK_RULE`, timing it via the `onPage` hook. Page failures become a
 * failed record (`links` is 0; callers fill it in). Throws only when `signal`
 * aborted the request, so callers can tell cancellation from failure.
 */
export async function scrapePage(
  scraper: UniversalScraper,
  url: string,
  signal?: AbortSignal,
): Promise<{ record: PageRecord; hrefs: string[] }> {
  let event: PageEvent | undefined;
  const started = performance.now();
  try {
    const result = await scraper.scrape([{ url, extraction: LINK_RULE }], {
      concurrency: 1,
      continueOnPageError: true,
      signal,
      onPage: (e) => { event = e; },
    });

    const failure = result.stats.failures[0];
    if (failure || !event) {
      return { record: { url, ok: false, totalMs: performance.now() - started, links: 0, error: failure?.message ?? 'no page event' }, hrefs: [] };
    }
    return {
      record: { url, ok: true, fetchMs: event.fetchMs, parseMs: event.parseMs, totalMs: event.totalMs, links: 0 },
      hrefs: hrefsFromItems(result.items),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { record: { url, ok: false, totalMs: performance.now() - started, links: 0, error: error instanceof Error ? error.message : String(error) }, hrefs: [] };
  }
}

/**
 * Breadth-first same-origin crawl through the given scraper. Every page is
 * one `scraper.scrape()` call, so the scraper's single HttpClient (its
 * concurrency limit, timeout and connection pool) serves the whole crawl.
 * Up to `concurrency` pages run at once in a rolling pool.
 */
export async function runCrawl(scraper: UniversalScraper, options: CrawlOptions): Promise<CrawlResult> {
  const frontier = new Frontier();
  for (const seed of options.seeds) frontier.add(seed);

  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new Error('crawl deadline reached')), options.deadlineMs);
  const records: PageRecord[] = [];
  let scheduled = 0;
  let abortedAtDeadline = 0;

  const finish = (record: PageRecord): void => {
    records.push(record);
    options.onRecord?.(record);
  };

  const crawl = async (url: string): Promise<void> => {
    let page: Awaited<ReturnType<typeof scrapePage>>;
    try {
      page = await scrapePage(scraper, url, deadline.signal);
    } catch {
      abortedAtDeadline += 1;
      return;
    }
    if (page.record.ok) {
      const links = extractLinks(page.hrefs, url, options.origin);
      for (const link of links) frontier.add(link);
      page.record.links = links.length;
    }
    finish(page.record);
  };

  const crawlStarted = performance.now();
  const inFlight = new Set<Promise<void>>();
  try {
    for (;;) {
      while (!deadline.signal.aborted && scheduled < options.maxPages && inFlight.size < options.concurrency) {
        const url = frontier.next();
        if (!url) break;
        scheduled += 1;
        const task = crawl(url).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  return {
    records,
    discovered: frontier.discovered,
    abortedAtDeadline,
    stopReason: deadline.signal.aborted
      ? 'deadline'
      : scheduled >= options.maxPages && frontier.queued > 0 ? 'MAX_PAGES' : 'no more links',
    crawlMs: performance.now() - crawlStarted,
  };
}

// ─── Repeats ──────────────────────────────────────────────────────────

/**
 * Runs `runCrawl` `repeats` times, one after another. Each run gets a new
 * scraper from `createScraper` (so a fresh HttpClient, limiter and per-host
 * state) and `runCrawl` builds a fresh frontier and visited set, so every run
 * re-fetches every page. Only Node's process-wide connection pool carries
 * over, which means runs after the first start with warm connections.
 */
export async function runRepeated(
  repeats: number,
  createScraper: () => UniversalScraper,
  options: CrawlOptions,
  hooks: { onRunStart?: (run: number) => void; onRunEnd?: (run: number, result: CrawlResult) => void } = {},
): Promise<CrawlResult[]> {
  const results: CrawlResult[] = [];
  for (let run = 1; run <= Math.max(1, Math.floor(repeats)); run += 1) {
    hooks.onRunStart?.(run);
    const result = await runCrawl(createScraper(), options);
    results.push(result);
    hooks.onRunEnd?.(run, result);
  }
  return results;
}

export interface RepeatSummary {
  runs: number;
  /** Whole-crawl wall time per run, in ms. */
  avgCrawlMs: number;
  medianCrawlMs: number;
  minCrawlMs: number;
  maxCrawlMs: number;
  /** Mean of each run's crawled-pages / crawl-seconds. */
  avgPagesPerSec: number;
}

/** Aggregates whole-crawl durations (not page latencies) across runs. */
export function summarizeRuns(results: readonly CrawlResult[]): RepeatSummary {
  const durations = results.map((r) => r.crawlMs);
  const rates = results.map((r) => (r.crawlMs > 0 ? r.records.length / (r.crawlMs / 1000) : 0));
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    runs: results.length,
    avgCrawlMs: mean(durations),
    medianCrawlMs: sorted.length === 0 ? 0 : sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2,
    minCrawlMs: sorted[0] ?? 0,
    maxCrawlMs: sorted.at(-1) ?? 0,
    avgPagesPerSec: mean(rates),
  };
}
