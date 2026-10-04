/**
 * Measurement only: splits per-page time into network fetch and parsing.
 *
 * Makes 20 sequential requests to a real HTML page and prints each page's
 * fetchMs / parseMs / totalMs from the `onPage` hook, then min / median / p90 /
 * max. Nothing is tuned here: concurrency 1, no retries, no per-host limiter
 * and no warm-up, so fetchMs contains only the request itself. Request 1
 * includes DNS, TCP and TLS setup; later requests reuse the connection.
 *
 * Run: pnpm measure:timing   (optionally: URL=... SELECTOR=... REQUESTS=...)
 */
import { UniversalScraper, type PageEvent } from '../src/index.js';
import { median, percentile } from './stats.js';

const URL_ = process.env['URL'] ?? 'https://httpbin.org/html';
const SELECTOR = process.env['SELECTOR'] ?? 'h1';
const REQUESTS = Math.max(1, Number(process.env['REQUESTS'] ?? '20') || 20);

function summarize(label: string, values: readonly number[]): string {
  const f = (n: number): string => n.toFixed(1).padStart(8);
  return `${label.padEnd(9)}${f(Math.min(...values))}${f(median(values))}${f(percentile(values, 0.9))}${f(Math.max(...values))}`;
}

const events: PageEvent[] = [];
const scraper = new UniversalScraper({ http: { retries: 0, timeoutMs: 15_000 } });

// One target per request (same URL). concurrency 1 keeps requests strictly sequential.
const targets = Array.from({ length: REQUESTS }, () => ({
  url: URL_,
  extraction: { type: 'html' as const, selector: SELECTOR },
}));
const result = await scraper.scrape(targets, {
  concurrency: 1,
  continueOnPageError: true,
  onPage: (event) => { events.push(event); },
});

console.log(`url=${URL_} selector=${SELECTOR} requests=${REQUESTS} node=${process.version}\n`);
console.log('request   fetchMs   parseMs   totalMs');
events.forEach((e, i) => {
  console.log(`${String(i + 1).padStart(7)}${e.fetchMs.toFixed(1).padStart(10)}${e.parseMs.toFixed(1).padStart(10)}${e.totalMs.toFixed(1).padStart(10)}`);
});

if (events.length === 0) {
  console.log('\nNo successful requests; failures:', result.stats.failures);
  process.exit(1);
}

const fetches = events.map((e) => e.fetchMs);
const parses = events.map((e) => e.parseMs);
const totals = events.map((e) => e.totalMs);

console.log(`\nsuccessful=${events.length}/${REQUESTS} failedPages=${result.stats.failedPages}`);
for (const failure of result.stats.failures) console.log(`  failed: ${failure.message.slice(0, 160)}`);
console.log('\n(all requests)  ms        min  median     p90     max');
console.log(summarize('fetchMs', fetches));
console.log(summarize('parseMs', parses));
console.log(summarize('totalMs', totals));

const warm = events.slice(1);
if (warm.length > 0) {
  console.log('\n(excluding request 1, the cold connection)');
  console.log(summarize('fetchMs', warm.map((e) => e.fetchMs)));
  console.log(summarize('parseMs', warm.map((e) => e.parseMs)));
  console.log(summarize('totalMs', warm.map((e) => e.totalMs)));
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
console.log(`\nfetch share of total time: ${((sum(fetches) / sum(totals)) * 100).toFixed(1)}%  parse share: ${((sum(parses) / sum(totals)) * 100).toFixed(1)}%`);
