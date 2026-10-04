/**
 * End-to-end benchmark against a local HTTP server with a fixed response
 * delay. It measures the complete pipeline (fetch → detect → parse → extract
 * → queue → collect) for a JSON and an HTML workload across concurrency
 * levels, and reports the per-request latency and the observed in-flight
 * maximum so the concurrency limit is verified rather than assumed.
 *
 * Run with `pnpm benchmark`. Numbers depend on the machine; only quote the
 * output you actually observed.
 */
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { UniversalScraper, type HtmlParser, type ScrapeTarget } from './src/index.js';

const RESPONSE_DELAY_MS = 25;
const PAGES = 200;
const ITEMS_PER_PAGE = 100;
/** Pages per target in the paginated workload (PAGES / PAGES_PER_TARGET targets). */
const PAGES_PER_TARGET = 5;
const CONCURRENCY_LEVELS = [1, 2, 4, 8, 16, 32, 64];
/** Set HTML_PARSER=htmlparser2 to benchmark the alternative parser backend. */
const HTML_PARSER: HtmlParser = process.env['HTML_PARSER'] === 'htmlparser2' ? 'htmlparser2' : 'parse5';
/** Set BENCH_REPEATS=n to run each cell n times and report the median (default 1). */
const REPEATS = Math.max(1, Number(process.env['BENCH_REPEATS'] ?? '1') || 1);

/**
 * - `json`:        single-page JSON API targets
 * - `json-paged`:  page-number JSON targets fetched sequentially
 * - `json-paged-p`: same targets with `pageConcurrency = PAGES_PER_TARGET`
 * - `html`:        single-page HTML targets with field extraction
 * - `html-paged`:  HTML targets that follow rel=next links; exercises the
 *                  extraction + pagination path over the same parsed document
 */
type Workload = 'json' | 'json-paged' | 'json-paged-p' | 'html' | 'html-paged';
const WORKLOADS: readonly Workload[] = ['json', 'json-paged', 'json-paged-p', 'html', 'html-paged'];

const jsonBody = JSON.stringify({
  items: Array.from({ length: ITEMS_PER_PAGE }, (_, id) => ({ id, title: `item-${id}` })),
});
const htmlItems = Array.from(
  { length: ITEMS_PER_PAGE },
  (_, id) => `<li class="product"><a class="title" href="/items/${id}">item-${id}</a><span class="price">${id}.00</span></li>`,
).join('');
const htmlBody = (nextHref: string | null): string =>
  `<!doctype html><html><body><ul>${htmlItems}</ul>${nextHref ? `<a rel="next" href="${nextHref}">next</a>` : ''}</body></html>`;

const server = createServer((req, res) => {
  setTimeout(() => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonBody);
      return;
    }
    const page = Number(url.searchParams.get('page') ?? '1');
    const next = url.pathname.startsWith('/paged') && page < PAGES_PER_TARGET ? `?page=${page + 1}` : null;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlBody(next));
  }, RESPONSE_DELAY_MS);
});
server.keepAliveTimeout = 60_000;

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to start benchmark server');
const baseUrl = `http://127.0.0.1:${address.port}`;

const htmlExtraction: ScrapeTarget['extraction'] = {
  type: 'html',
  selector: '.product',
  fields: {
    title: { selector: '.title' },
    price: { selector: '.price' },
    url: { selector: 'a', attribute: 'href' },
  },
};

function buildTargets(workload: Workload): ScrapeTarget[] {
  switch (workload) {
    case 'json':
      return Array.from({ length: PAGES }, (_, i) => ({ url: `${baseUrl}/json/${i}`, extraction: { type: 'json', path: 'items' } }));
    case 'json-paged':
    case 'json-paged-p':
      return Array.from({ length: PAGES / PAGES_PER_TARGET }, (_, i) => ({
        url: `${baseUrl}/json/${i}`,
        extraction: { type: 'json', path: 'items' },
        pagination: {
          mode: 'page',
          maxPages: PAGES_PER_TARGET,
          pageConcurrency: workload === 'json-paged-p' ? PAGES_PER_TARGET : 1,
        },
      }));
    case 'html':
      return Array.from({ length: PAGES }, (_, i) => ({ url: `${baseUrl}/html/${i}`, extraction: htmlExtraction }));
    case 'html-paged':
      return Array.from({ length: PAGES / PAGES_PER_TARGET }, (_, i) => ({
        url: `${baseUrl}/paged/${i}`,
        extraction: htmlExtraction,
        pagination: { mode: 'next-link', maxPages: PAGES_PER_TARGET },
      }));
  }
}

interface Row {
  workload: Workload;
  concurrency: number;
  pages: number;
  items: number;
  failures: number;
  durationMs: number;
  /** Process CPU time (user + system) consumed during the run. */
  cpuMs: number;
  itemsPerSecond: number;
  avgLatencyMs: number;
  maxInFlight: number;
}

async function run(workload: Workload, concurrency: number): Promise<Row> {
  const latencies: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  // Wrap the real fetch to observe latency and the true in-flight count.
  const fetchImpl: typeof fetch = async (input, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const started = performance.now();
    try {
      return await fetch(input, init);
    } finally {
      latencies.push(performance.now() - started);
      inFlight -= 1;
    }
  };

  const scraper = new UniversalScraper({ http: { concurrency, retries: 0, timeoutMs: 5_000, fetchImpl }, htmlParser: HTML_PARSER });
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const result = await scraper.scrape(buildTargets(workload), { concurrency, continueOnPageError: true });
  const durationMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);

  return {
    workload,
    concurrency,
    pages: result.stats.pages,
    items: result.stats.items,
    failures: result.stats.failedPages,
    durationMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    itemsPerSecond: result.stats.items / (durationMs / 1000),
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length),
    maxInFlight,
  };
}

function formatRow(row: Row): string {
  return [
    row.workload.padEnd(12),
    String(row.concurrency).padStart(4),
    String(row.pages).padStart(6),
    String(row.items).padStart(7),
    String(row.failures).padStart(5),
    row.durationMs.toFixed(1).padStart(10),
    row.cpuMs.toFixed(0).padStart(7),
    row.itemsPerSecond.toFixed(0).padStart(9),
    row.avgLatencyMs.toFixed(1).padStart(9),
    String(row.maxInFlight).padStart(6),
  ].join('  ');
}

console.log(`server delay=${RESPONSE_DELAY_MS}ms pages=${PAGES} items/page=${ITEMS_PER_PAGE} pages/target(paged)=${PAGES_PER_TARGET} htmlParser=${HTML_PARSER} node=${process.version}`);
console.log(`repeats=${REPEATS} (median duration shown)  ideal floor = pages * delay / min(concurrency, targets)\n`);
console.log(['workload    ', 'conc', ' pages', '  items', ' fail', 'duration ms', ' cpu ms', '  items/s', 'avg lat ms', 'inflt'].join('  '));

/** Runs a cell REPEATS times and returns the run with the median duration. */
async function runMedian(workload: Workload, concurrency: number): Promise<Row> {
  const rows: Row[] = [];
  for (let i = 0; i < REPEATS; i += 1) rows.push(await run(workload, concurrency));
  rows.sort((a, b) => a.durationMs - b.durationMs);
  return rows[Math.floor(rows.length / 2)] as Row;
}

// Warm up JIT and keep-alive connections before measuring.
await run('json', 8);

for (const workload of WORKLOADS) {
  for (const concurrency of CONCURRENCY_LEVELS) {
    console.log(formatRow(await runMedian(workload, concurrency)));
  }
  console.log('');
}

server.close();
