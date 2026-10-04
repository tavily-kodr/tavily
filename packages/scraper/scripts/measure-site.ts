/**
 * Whole-site crawl benchmark. Measurement only.
 *
 * Seeds the crawl from START_URL and/or URL_FILE, then follows same-origin
 * <a href> links breadth-first and records fetchMs / parseMs / totalMs for
 * every page via the scraper's `onPage` hook. Every page is fetched through
 * ONE UniversalScraper, so the shared HttpClient's concurrency limit, timeout
 * and connection pool apply; there is no second HTTP implementation here.
 *
 * Env:
 *   START_URL    first seed; also fixes the crawl origin
 *   URL_FILE     path to a text file, one absolute http(s) URL per line. Blank
 *                lines are ignored; malformed lines are reported and skipped.
 *                Without START_URL the first valid line fixes the origin;
 *                seeds on other origins are skipped.
 *   (at least one of START_URL / URL_FILE is required)
 *   MAX_PAGES    pages to crawl at most              (default 50)
 *   CONCURRENCY  pages / requests in flight at once   (default 4)
 *   TIMEOUT      per-request timeout in ms            (default 10000)
 *   DEADLINE     whole-crawl budget in ms             (default 60000)
 *   REPEATS      independent crawls to run back to back (default 1). Each run
 *                uses a fresh scraper, queue and visited set and re-fetches
 *                every page; a final summary aggregates whole-crawl durations.
 *   VERBOSE=1    print one line per page
 *
 * Run: START_URL=https://books.toscrape.com/ pnpm measure:site
 *      URL_FILE=urls.txt MAX_PAGES=1000 pnpm measure:site
 *
 * Only crawl sites you are allowed to crawl. Retries are disabled so failures
 * and latency are measured as they happen.
 */
import { readFileSync } from 'node:fs';
import { UniversalScraper } from '../src/index.js';
import { loadSeeds, runRepeated, summarizeRuns, type CrawlResult, type PageRecord } from './site-crawl.js';
import { summarize, type Summary } from './stats.js';

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const START_URL = process.env['START_URL'];
const URL_FILE = process.env['URL_FILE'];
if (!START_URL && !URL_FILE) {
  fail('Set START_URL and/or URL_FILE, e.g. START_URL=https://books.toscrape.com/ pnpm measure:site');
}

let fileText: string | undefined;
if (URL_FILE) {
  try {
    fileText = readFileSync(URL_FILE, 'utf8');
  } catch (error) {
    fail(`Cannot read URL_FILE ${URL_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let seedResult: ReturnType<typeof loadSeeds>;
try {
  seedResult = loadSeeds({ startUrl: START_URL, fileText });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const { seeds, origin, invalidLines, offOrigin, duplicates } = seedResult;
if (!origin || seeds.length === 0) fail('No valid absolute http(s) seed URLs found.');

const MAX_PAGES = intEnv('MAX_PAGES', 50);
const CONCURRENCY = intEnv('CONCURRENCY', 4);
const TIMEOUT = intEnv('TIMEOUT', 10_000);
const DEADLINE = intEnv('DEADLINE', 60_000);
const REPEATS = intEnv('REPEATS', 1);
const VERBOSE = process.env['VERBOSE'] === '1';

const createScraper = (): UniversalScraper => new UniversalScraper({
  http: { concurrency: CONCURRENCY, timeoutMs: TIMEOUT, retries: 0 },
});

const logRecord = (r: PageRecord): void => {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} fetch=${(r.fetchMs ?? 0).toFixed(1)} parse=${(r.parseMs ?? 0).toFixed(1)} total=${r.totalMs.toFixed(1)} links=${r.links} ${r.url}${r.error ? `  ${r.error.slice(0, 100)}` : ''}`);
};

// ── Report ────────────────────────────────────────────────────────────
const row = (label: string, s: Summary): string =>
  `${label.padEnd(8)}${[s.min, s.median, s.p90, s.p95, s.max].map((v) => v.toFixed(1).padStart(9)).join('')}`;

const source = [START_URL ? `start=${START_URL}` : '', URL_FILE ? `file=${URL_FILE}` : ''].filter(Boolean).join(' ');
const repeatsNote = REPEATS > 1 ? ` REPEATS=${REPEATS}` : '';
console.log(`${source} origin=${origin} MAX_PAGES=${MAX_PAGES} CONCURRENCY=${CONCURRENCY} TIMEOUT=${TIMEOUT} DEADLINE=${DEADLINE}${repeatsNote} node=${process.version}\n`);
console.log(`seed URLs         ${seeds.length}`);
if (duplicates > 0) console.log(`  duplicate seeds ${duplicates}`);
if (invalidLines.length > 0) console.log(`  invalid lines   ${invalidLines.length} (line ${invalidLines.slice(0, 10).join(', ')}${invalidLines.length > 10 ? ', …' : ''})`);
if (offOrigin.length > 0) console.log(`  other origins   ${offOrigin.length} skipped (e.g. ${offOrigin[0]})`);

/** Prints one crawl's results; identical to the single-run output. */
function printRun(crawl: CrawlResult): void {
  const ok = crawl.records.filter((r) => r.ok);
  const failed = crawl.records.filter((r) => !r.ok);

  console.log(`discovered URLs   ${crawl.discovered}`);
  console.log(`crawled URLs      ${crawl.records.length}`);
  console.log(`successful        ${ok.length}`);
  console.log(`failed            ${failed.length}`);
  console.log(`aborted at stop   ${crawl.abortedAtDeadline}`);
  console.log(`stopped because   ${crawl.stopReason}`);
  console.log(`crawl duration    ${(crawl.crawlMs / 1000).toFixed(2)} s`);
  console.log(`pages/sec         ${(crawl.records.length / (crawl.crawlMs / 1000)).toFixed(2)}`);

  if (ok.length === 0) {
    console.log('\nno successful pages, so no timing statistics');
  } else {
    console.log('\n(successful pages)  min   median      p90      p95      max  [ms]');
    console.log(row('fetch', summarize(ok.map((r) => r.fetchMs ?? 0))));
    console.log(row('parse', summarize(ok.map((r) => r.parseMs ?? 0))));
    console.log(row('total', summarize(ok.map((r) => r.totalMs))));
  }

  if (failed.length > 0) {
    console.log('\nfailures (first 10):');
    for (const r of failed.slice(0, 10)) console.log(`  ${r.url}  ${r.error?.slice(0, 140)}`);
  }
}

const results = await runRepeated(
  REPEATS,
  createScraper,
  {
    seeds,
    origin,
    maxPages: MAX_PAGES,
    concurrency: CONCURRENCY,
    deadlineMs: DEADLINE,
    onRecord: VERBOSE ? logRecord : undefined,
  },
  {
    onRunStart: (run) => { if (REPEATS > 1) console.log(`\n=== RUN ${run} of ${REPEATS} ===`); },
    onRunEnd: (_run, crawl) => printRun(crawl),
  },
);

if (REPEATS > 1) {
  const summary = summarizeRuns(results);
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;
  console.log(`\n=== SUMMARY (${summary.runs} runs, whole-crawl duration) ===`);
  console.log(`average crawl duration  ${seconds(summary.avgCrawlMs)}`);
  console.log(`median crawl duration   ${seconds(summary.medianCrawlMs)}`);
  console.log(`min crawl duration      ${seconds(summary.minCrawlMs)}`);
  console.log(`max crawl duration      ${seconds(summary.maxCrawlMs)}`);
  console.log(`average pages/sec       ${summary.avgPagesPerSec.toFixed(2)}`);
  console.log('note: runs share Node\'s connection pool, so runs after the first reuse warm connections');
}
