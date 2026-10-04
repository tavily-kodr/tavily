/**
 * Helpers for the fixed URL-list benchmark (scripts/measure-urls.ts): URL list
 * loading, one run over the list, repeats and the summary. No file or console
 * I/O here so everything can be unit-tested; runs take the scraper as a
 * parameter. Unlike the site crawl, no links are followed and URLs on any
 * origin are kept: every listed URL is an explicit benchmark target.
 */
import pLimit from 'p-limit';
import type { UniversalScraper } from '../src/index.js';
import { parseSeed, scrapePage, type PageRecord } from './site-crawl.js';
import { median } from './stats.js';

export interface UrlList {
  /** Normalised, de-duplicated URLs in file order, on any origin. */
  urls: string[];
  /** 1-based line numbers that were not absolute http(s) URLs. */
  invalidLines: number[];
  /** Lines dropped because they normalised to a URL already listed. */
  duplicates: number;
  /** Distinct origins among `urls`, in first-seen order. */
  origins: string[];
}

/**
 * Parses URL_FILE contents: one absolute http(s) URL per line. Blank lines are
 * ignored, other non-URL lines are reported in `invalidLines`, and URLs are
 * normalised with `parseSeed` (fragment dropped, host lower-cased, default
 * port removed) and de-duplicated. Different origins are all kept.
 */
export function loadUrlList(fileText: string): UrlList {
  const result: UrlList = { urls: [], invalidLines: [], duplicates: 0, origins: [] };
  const seen = new Set<string>();
  const origins = new Set<string>();

  fileText.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const url = parseSeed(line);
    if (!url) {
      result.invalidLines.push(index + 1);
    } else if (seen.has(url)) {
      result.duplicates += 1;
    } else {
      seen.add(url);
      result.urls.push(url);
      origins.add(new URL(url).origin);
    }
  });

  result.origins = [...origins];
  return result;
}

export interface UrlRunOptions {
  urls: readonly string[];
  /** Pages in flight at once. */
  concurrency: number;
  /** Called once per finished page (success or failure). */
  onRecord?: (record: PageRecord) => void;
}

export interface UrlRunResult {
  /** One record per URL, in completion order. `links` is the page's raw href count. */
  records: PageRecord[];
  attempted: number;
  successful: number;
  failed: number;
  /** Wall time from the first request to the last page finishing. */
  runMs: number;
}

/**
 * Fetches and parses every URL once through the given scraper, up to
 * `concurrency` at a time. Each page is one `scrapePage` call, so the
 * scraper's single HttpClient (limit, timeout, connection pool) serves the run.
 */
export async function runUrlList(scraper: UniversalScraper, options: UrlRunOptions): Promise<UrlRunResult> {
  const limit = pLimit(Math.max(1, Math.floor(options.concurrency)));
  const records: PageRecord[] = [];

  const started = performance.now();
  await Promise.all(options.urls.map((url) => limit(async () => {
    const { record, hrefs } = await scrapePage(scraper, url);
    record.links = hrefs.length;
    records.push(record);
    options.onRecord?.(record);
  })));
  const runMs = performance.now() - started;

  const successful = records.filter((r) => r.ok).length;
  return { records, attempted: records.length, successful, failed: records.length - successful, runMs };
}

/** `count` per second of `runMs`; 0 for an instantaneous run. */
const perSec = (count: number, runMs: number): number => (runMs > 0 ? count / (runMs / 1000) : 0);

/** One run's successful URLs / run seconds; 0 for an instantaneous run. */
export function successfulUrlsPerSec(run: UrlRunResult): number {
  return perSec(run.successful, run.runMs);
}

/** One run's attempted URLs (successful + failed) / run seconds; 0 for an instantaneous run. */
export function attemptedUrlsPerSec(run: UrlRunResult): number {
  return perSec(run.attempted, run.runMs);
}

/**
 * Runs the full list `repeats` times, one after another. Each run gets a new
 * scraper from `createScraper` (fresh HttpClient, limiter and per-host state)
 * and fresh result state, so every run re-fetches every URL. Only Node's
 * process-wide connection pool carries over between runs.
 */
export async function runUrlListRepeated(
  repeats: number,
  createScraper: () => UniversalScraper,
  options: UrlRunOptions,
  hooks: { onRunStart?: (run: number) => void; onRunEnd?: (run: number, result: UrlRunResult) => void } = {},
): Promise<UrlRunResult[]> {
  const results: UrlRunResult[] = [];
  for (let run = 1; run <= Math.max(1, Math.floor(repeats)); run += 1) {
    hooks.onRunStart?.(run);
    const result = await runUrlList(createScraper(), options);
    results.push(result);
    hooks.onRunEnd?.(run, result);
  }
  return results;
}

export interface UrlRunSummary {
  runs: number;
  /** Whole-run wall time, in ms. */
  avgRunMs: number;
  medianRunMs: number;
  minRunMs: number;
  maxRunMs: number;
  /** mean over runs of (run successful / run seconds). Each run weighs the same. */
  avgSuccessfulUrlsPerSec: number;
  /** (sum of successful over runs) / (sum of run seconds). Longer runs weigh more. Primary metric. */
  aggregateSuccessfulUrlsPerSec: number;
  /** (sum of attempted over runs) / (sum of run seconds). */
  aggregateAttemptedUrlsPerSec: number;
  attempted: number;
  successful: number;
  failed: number;
  /** successful / attempted over all runs, 0..1; 0 when nothing was attempted. */
  successRate: number;
}

/** Aggregates whole-run durations and request outcomes across runs. */
export function summarizeUrlRuns(results: readonly UrlRunResult[]): UrlRunSummary {
  const durations = results.map((r) => r.runMs);
  const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const attempted = results.reduce((n, r) => n + r.attempted, 0);
  const successful = results.reduce((n, r) => n + r.successful, 0);
  const totalRunMs = durations.reduce((a, b) => a + b, 0);
  return {
    runs: results.length,
    avgRunMs: mean(durations),
    medianRunMs: median(durations),
    minRunMs: durations.length ? Math.min(...durations) : 0,
    maxRunMs: durations.length ? Math.max(...durations) : 0,
    avgSuccessfulUrlsPerSec: mean(results.map(successfulUrlsPerSec)),
    aggregateSuccessfulUrlsPerSec: perSec(successful, totalRunMs),
    aggregateAttemptedUrlsPerSec: perSec(attempted, totalRunMs),
    attempted,
    successful,
    failed: attempted - successful,
    successRate: attempted > 0 ? successful / attempted : 0,
  };
}
