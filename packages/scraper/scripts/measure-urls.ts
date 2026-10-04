/**
 * Fixed URL-list benchmark. Measurement only.
 *
 * Fetches and parses every URL in URL_FILE exactly once per run and records
 * fetchMs / parseMs / totalMs per page via the scraper's `onPage` hook. No
 * links are followed, and URLs on different origins are all kept: every line
 * is an explicit benchmark target. Every page goes through ONE
 * UniversalScraper per run, so the shared HttpClient's concurrency limit,
 * timeout and connection pool apply; there is no second HTTP implementation.
 *
 * Env:
 *   URL_FILE     text file, one absolute http(s) URL per line
 *                (default sheryians-all-urls.txt). Blank lines are ignored,
 *                malformed lines are reported and skipped, duplicates merged.
 *   CONCURRENCY  pages / requests in flight at once   (default 4)
 *   TIMEOUT      per-request timeout in ms            (default 10000)
 *   REPEATS      runs over the full list, back to back (default 1). Each run
 *                uses a fresh scraper and result state and re-fetches every URL.
 *   VERBOSE=1    print one line per page
 *
 * Run: URL_FILE=sheryians-all-urls.txt REPEATS=3 pnpm measure:urls
 *
 * Only benchmark sites you are allowed to load. Retries are disabled so
 * failures and latency are measured as they happen.
 */
import { readFileSync } from 'node:fs';
import { UniversalScraper } from '../src/index.js';
import type { PageRecord } from './site-crawl.js';
import { summarize, type Summary } from './stats.js';
import { loadUrlList, runUrlListRepeated, summarizeUrlRuns, attemptedUrlsPerSec, successfulUrlsPerSec, type UrlRunResult } from './url-list.js';

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const URL_FILE = process.env['URL_FILE'] || 'sheryians-all-urls.txt';
let fileText = '';
try {
  fileText = readFileSync(URL_FILE, 'utf8');
} catch (error) {
  fail(`Cannot read URL_FILE ${URL_FILE}: ${error instanceof Error ? error.message : String(error)}`);
}

const { urls, invalidLines, duplicates, origins } = loadUrlList(fileText);
if (urls.length === 0) fail(`No valid absolute http(s) URLs found in ${URL_FILE}.`);

const CONCURRENCY = intEnv('CONCURRENCY', 4);
const TIMEOUT = intEnv('TIMEOUT', 10_000);
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
const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

console.log(`file=${URL_FILE} CONCURRENCY=${CONCURRENCY} TIMEOUT=${TIMEOUT} REPEATS=${REPEATS} node=${process.version}\n`);
console.log(`benchmark URLs    ${urls.length}`);
console.log(`  origins         ${origins.length} (${origins.slice(0, 5).join(', ')}${origins.length > 5 ? ', …' : ''})`);
if (duplicates > 0) console.log(`  duplicate URLs  ${duplicates} merged`);
if (invalidLines.length > 0) console.log(`  invalid lines   ${invalidLines.length} (line ${invalidLines.slice(0, 10).join(', ')}${invalidLines.length > 10 ? ', …' : ''})`);

function printRun(run: UrlRunResult): void {
  const ok = run.records.filter((r) => r.ok);
  const failed = run.records.filter((r) => !r.ok);

  console.log(`URLs attempted    ${run.attempted}`);
  console.log(`successful        ${run.successful}`);
  console.log(`failed            ${run.failed}`);
  console.log(`crawl duration    ${seconds(run.runMs)}`);
  console.log(`successful URLs/sec  ${successfulUrlsPerSec(run).toFixed(2)}`);
  console.log(`attempted URLs/sec   ${attemptedUrlsPerSec(run).toFixed(2)}`);

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

const results = await runUrlListRepeated(
  REPEATS,
  createScraper,
  { urls, concurrency: CONCURRENCY, onRecord: VERBOSE ? logRecord : undefined },
  {
    onRunStart: (run) => console.log(`\n=== RUN ${run} of ${REPEATS} ===`),
    onRunEnd: (_run, result) => printRun(result),
  },
);

const summary = summarizeUrlRuns(results);
console.log(`\n=== SUMMARY (${summary.runs} run${summary.runs === 1 ? '' : 's'}, ${urls.length} URLs each) ===`);
console.log(`average duration               ${seconds(summary.avgRunMs)}`);
console.log(`median duration                ${seconds(summary.medianRunMs)}`);
console.log(`min duration                   ${seconds(summary.minRunMs)}`);
console.log(`max duration                   ${seconds(summary.maxRunMs)}`);
console.log(`average successful URLs/sec    ${summary.avgSuccessfulUrlsPerSec.toFixed(2)}  (mean of run successful / run s)`);
console.log(`aggregate successful URLs/sec  ${summary.aggregateSuccessfulUrlsPerSec.toFixed(2)}  (total successful / total run s)`);
console.log(`aggregate attempted URLs/sec   ${summary.aggregateAttemptedUrlsPerSec.toFixed(2)}  (total attempted / total run s)`);
console.log(`failed                         ${summary.failed} of ${summary.attempted} attempted`);
console.log(`success rate                   ${(summary.successRate * 100).toFixed(1)}% (${summary.successful}/${summary.attempted})`);
if (summary.runs > 1) console.log('note: runs share Node\'s connection pool, so runs after the first reuse warm connections');
