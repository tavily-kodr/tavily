import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UniversalScraper } from '../src/index.js';
import { loadUrlList, runUrlList, runUrlListRepeated, summarizeUrlRuns, attemptedUrlsPerSec, successfulUrlsPerSec, type UrlRunResult } from '../scripts/url-list.js';

describe('loadUrlList', () => {
  it('loads every URL in file order', () => {
    const text = 'https://shop.test/a\nhttps://shop.test/b?x=1\r\nhttps://shop.test/c#frag\n';
    expect(loadUrlList(text)).toEqual({
      urls: ['https://shop.test/a', 'https://shop.test/b?x=1', 'https://shop.test/c'],
      invalidLines: [],
      duplicates: 0,
      origins: ['https://shop.test'],
    });
  });

  it('merges duplicates after normalisation', () => {
    const text = ['https://shop.test/a', 'HTTPS://SHOP.TEST:443/a', 'https://shop.test/a#top', '  https://shop.test/a  ', 'https://shop.test/a/', 'https://shop.test', 'https://shop.test/'].join('\n');
    const list = loadUrlList(text);
    expect(list.urls).toEqual(['https://shop.test/a', 'https://shop.test/a/', 'https://shop.test/']);
    expect(list.duplicates).toBe(4);
  });

  it('ignores blank lines and reports invalid ones by line number', () => {
    const text = ['', 'https://shop.test/ok', '   ', '/relative', 'shop.test/no-scheme', 'mailto:a@shop.test', 'ftp://shop.test/f', 'https://[bad', '# comment', 'https://shop.test/ok2'].join('\n');
    const list = loadUrlList(text);
    expect(list.urls).toEqual(['https://shop.test/ok', 'https://shop.test/ok2']);
    expect(list.invalidLines).toEqual([4, 5, 6, 7, 8, 9]);
    expect(loadUrlList('\n\n').urls).toEqual([]);
  });

  it('keeps URLs on every origin as explicit targets', () => {
    const text = ['https://www.shop.test/', 'https://shop.test/courses', 'https://bootcamp.shop.test', 'http://shop.test/x', 'https://shop.test:8443/y', 'https://other.test/z'].join('\n');
    const list = loadUrlList(text);
    expect(list.urls).toHaveLength(6);
    expect(list.origins).toEqual([
      'https://www.shop.test', 'https://shop.test', 'https://bootcamp.shop.test', 'http://shop.test', 'https://shop.test:8443', 'https://other.test',
    ]);
  });
});

/** In-memory web: absolute URL → HTML. Unknown URLs return 404. */
function webFetch(pages: Record<string, string>) {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    const html = pages[url];
    return html === undefined
      ? new Response('missing', { status: 404 })
      : new Response(html, { headers: { 'content-type': 'text/html' } });
  };
  return { requested, fetchImpl };
}

const pages = {
  'https://www.shop.test/': '<a href="/a">a</a><a href="https://other.test/">o</a>',
  'https://shop.test/courses': '<a href="/x">x</a>',
  'https://bootcamp.shop.test/': 'leaf',
  'https://other.test/': '<a href="/never-followed">n</a>',
};
const urls = Object.keys(pages);

describe('runUrlList', () => {
  it('fetches and parses every URL across origins once, without following links', async () => {
    const { requested, fetchImpl } = webFetch(pages);
    const result = await runUrlList(new UniversalScraper({ http: { fetchImpl } }), { urls, concurrency: 2 });

    expect([...requested].sort()).toEqual([...urls].sort());
    expect(result).toMatchObject({ attempted: 4, successful: 4, failed: 0 });
    expect(result.runMs).toBeGreaterThan(0);
    for (const r of result.records) {
      expect(r.ok).toBe(true);
      expect(r.fetchMs).toEqual(expect.any(Number));
      expect(r.parseMs).toEqual(expect.any(Number));
    }
    expect(result.records.find((r) => r.url === 'https://www.shop.test/')?.links).toBe(2);
  });

  it('records failures without stopping the run', async () => {
    const { fetchImpl } = webFetch(pages);
    const scraper = new UniversalScraper({ http: { fetchImpl, retries: 0 } });
    const result = await runUrlList(scraper, { urls: ['https://shop.test/gone', ...urls], concurrency: 3 });
    expect(result).toMatchObject({ attempted: 5, successful: 4, failed: 1 });
    expect(result.records.find((r) => !r.ok)).toMatchObject({ url: 'https://shop.test/gone', error: expect.stringContaining('HTTP 404') });
  });

  it('never exceeds CONCURRENCY pages in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = async (): Promise<Response> => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response('x', { headers: { 'content-type': 'text/html' } });
    };
    const many = Array.from({ length: 10 }, (_, i) => `https://h${i}.test/`);
    const result = await runUrlList(new UniversalScraper({ http: { fetchImpl } }), { urls: many, concurrency: 3 });
    expect(result.successful).toBe(10);
    expect(peak).toBe(3);
  });
});

describe('repeated runs', () => {
  it('runs the full list REPEATS times with a fresh scraper each run', async () => {
    const { requested, fetchImpl } = webFetch(pages);
    const scrapers: UniversalScraper[] = [];
    const started: number[] = [];
    const ended: number[] = [];
    const results = await runUrlListRepeated(
      3,
      () => { const s = new UniversalScraper({ http: { fetchImpl } }); scrapers.push(s); return s; },
      { urls, concurrency: 2 },
      { onRunStart: (run) => started.push(run), onRunEnd: (run) => ended.push(run) },
    );

    expect(results).toHaveLength(3);
    expect(started).toEqual([1, 2, 3]);
    expect(ended).toEqual([1, 2, 3]);
    expect(new Set(scrapers).size).toBe(3);
    expect(new Set(results.map((r) => r.records)).size).toBe(3);
    for (const r of results) expect(r).toMatchObject({ attempted: 4, successful: 4, failed: 0 });
    const counts = requested.reduce<Record<string, number>>((acc, u) => ({ ...acc, [u]: (acc[u] ?? 0) + 1 }), {});
    expect(counts).toEqual(Object.fromEntries(urls.map((u) => [u, 3])));
  });

  it('defaults to one run for REPEATS below 1', async () => {
    const { fetchImpl } = webFetch(pages);
    expect(await runUrlListRepeated(0, () => new UniversalScraper({ http: { fetchImpl } }), { urls, concurrency: 1 })).toHaveLength(1);
  });
});

describe('summarizeUrlRuns', () => {
  const fake = (runMs: number, successful: number, failed: number): UrlRunResult => ({
    records: [], attempted: successful + failed, successful, failed, runMs,
  });

  it('aggregates durations, URLs/sec and success rate', () => {
    expect(successfulUrlsPerSec(fake(2000, 6, 4))).toBe(3);
    expect(attemptedUrlsPerSec(fake(2000, 6, 4))).toBe(5);
    expect(successfulUrlsPerSec(fake(0, 1, 0))).toBe(0);
    expect(attemptedUrlsPerSec(fake(0, 1, 0))).toBe(0);

    expect(summarizeUrlRuns([fake(2000, 9, 1), fake(1000, 10, 0), fake(4000, 6, 4)])).toEqual({
      runs: 3,
      avgRunMs: 7000 / 3,
      medianRunMs: 2000,
      minRunMs: 1000,
      maxRunMs: 4000,
      // successful / run s per run: 9/2, 10/1, 6/4
      avgSuccessfulUrlsPerSec: (4.5 + 10 + 1.5) / 3,
      aggregateSuccessfulUrlsPerSec: 25 / 7,
      aggregateAttemptedUrlsPerSec: 30 / 7,
      attempted: 30,
      successful: 25,
      failed: 5,
      successRate: 25 / 30,
    });
  });

  it('every throughput metric uses its documented numerator and denominator', () => {
    // Run 1: 10 successful, 0 failed in 1 s. Run 2: 5 successful, 5 failed in 10 s.
    const summary = summarizeUrlRuns([fake(1000, 10, 0), fake(10_000, 5, 5)]);
    // mean(10/1, 5/10): failures never count, each run weighs the same.
    expect(summary.avgSuccessfulUrlsPerSec).toBe(5.25);
    // (10 + 5) / (1 + 10): time-weighted, failures never count.
    expect(summary.aggregateSuccessfulUrlsPerSec).toBeCloseTo(15 / 11, 12);
    // (10 + 10) / (1 + 10): same denominator, failures included.
    expect(summary.aggregateAttemptedUrlsPerSec).toBeCloseTo(20 / 11, 12);
    expect(summary).toMatchObject({ attempted: 20, successful: 15, failed: 5, successRate: 0.75 });

    // One run: average and aggregate agree.
    expect(summarizeUrlRuns([fake(2000, 4, 2)])).toMatchObject({ avgSuccessfulUrlsPerSec: 2, aggregateSuccessfulUrlsPerSec: 2, aggregateAttemptedUrlsPerSec: 3 });
    // No elapsed time: rates are 0 instead of Infinity / NaN.
    expect(summarizeUrlRuns([fake(0, 3, 0)])).toMatchObject({ avgSuccessfulUrlsPerSec: 0, aggregateSuccessfulUrlsPerSec: 0, aggregateAttemptedUrlsPerSec: 0 });
  });

  it('uses the mean of the middle two for an even run count and handles no runs', () => {
    expect(summarizeUrlRuns([fake(1000, 1, 0), fake(3000, 1, 0)]).medianRunMs).toBe(2000);
    expect(summarizeUrlRuns([])).toMatchObject({ runs: 0, avgRunMs: 0, medianRunMs: 0, minRunMs: 0, maxRunMs: 0, avgSuccessfulUrlsPerSec: 0, aggregateSuccessfulUrlsPerSec: 0, aggregateAttemptedUrlsPerSec: 0, failed: 0, successRate: 0 });
  });
});

describe('measure-urls script (end to end)', () => {
  const servers: Server[] = [];
  const hits: string[] = [];
  let baseA = '';
  let baseB = '';
  let dir = '';

  const listen = async (name: string): Promise<string> => {
    const server = createServer((req, res) => {
      hits.push(`${name}${req.url ?? ''}`);
      const ok = req.url === '/page' || req.url === '/';
      res.writeHead(ok ? 200 : 404, { 'content-type': 'text/html' });
      res.end(ok ? '<a href="/not-followed">x</a>' : 'missing');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  };

  beforeAll(async () => {
    baseA = await listen('A');
    baseB = await listen('B');
    dir = mkdtempSync(join(tmpdir(), 'measure-urls-'));
  });

  afterAll(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (env: Record<string, string>) => promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'scripts/measure-urls.ts'],
    { env: { ...process.env, VERBOSE: '', ...env }, timeout: 30_000 },
  );

  it('loads URL_FILE, keeps both origins, repeats every URL and prints the summary', async () => {
    const file = join(dir, 'urls.txt');
    writeFileSync(file, [`${baseA}/page`, '', `${baseB}/`, `${baseA}/page#dup`, 'not a url', `${baseB}/gone`].join('\n'));

    const { stdout } = await run({ URL_FILE: file, REPEATS: '2', CONCURRENCY: '2' });

    expect(stdout).toMatch(/benchmark URLs\s+3\n/);
    expect(stdout).toMatch(/origins\s+2 \(/);
    expect(stdout).toMatch(/duplicate URLs\s+1 merged/);
    expect(stdout).toMatch(/invalid lines\s+1 \(line 5\)/);
    expect(stdout.match(/=== RUN \d of 2 ===/g)).toEqual(['=== RUN 1 of 2 ===', '=== RUN 2 of 2 ===']);
    expect(stdout.match(/URLs attempted\s+3\n/g)).toHaveLength(2);
    expect(stdout.match(/successful\s+2\n/g)).toHaveLength(2);
    expect(stdout.match(/failed\s+1\n/g)).toHaveLength(2);
    expect(stdout.match(/crawl duration\s+\d+\.\d{2} s/g)).toHaveLength(2);
    expect(stdout.match(/\nsuccessful URLs\/sec\s+\d+\.\d{2}\n/g)).toHaveLength(2);
    expect(stdout.match(/\nattempted URLs\/sec\s+\d+\.\d{2}\n/g)).toHaveLength(2);
    for (const label of ['fetch', 'parse', 'total']) expect(stdout.match(new RegExp(`\\n${label}\\s+(\\d+\\.\\d\\s+){4}\\d+\\.\\d\\n`, 'g'))).toHaveLength(2);
    expect(stdout).toMatch(/=== SUMMARY \(2 runs, 3 URLs each\) ===/);
    for (const label of ['average duration', 'median duration', 'min duration', 'max duration']) {
      expect(stdout).toMatch(new RegExp(`${label}\\s+\\d+\\.\\d{2} s`));
    }
    expect(stdout).toMatch(/average successful URLs\/sec\s+\d+\.\d{2} {2}\(mean of run successful \/ run s\)/);
    expect(stdout).toMatch(/aggregate successful URLs\/sec\s+\d+\.\d{2} {2}\(total successful \/ total run s\)/);
    expect(stdout).toMatch(/aggregate attempted URLs\/sec\s+\d+\.\d{2} {2}\(total attempted \/ total run s\)/);
    expect(stdout).toMatch(/\nfailed\s+2 of 6 attempted\n/);
    expect(stdout).toMatch(/success rate\s+66\.7% \(4\/6\)/);
    expect([...hits].sort()).toEqual(['A/page', 'A/page', 'B/', 'B/', 'B/gone', 'B/gone']);
  }, 40_000);

  it('exits with an error when URL_FILE is missing or has no valid URLs', async () => {
    await expect(run({ URL_FILE: join(dir, 'does-not-exist.txt') })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Cannot read URL_FILE') });
    const empty = join(dir, 'empty.txt');
    writeFileSync(empty, 'nope\n\n');
    await expect(run({ URL_FILE: empty })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('No valid absolute http(s) URLs') });
  }, 40_000);
});
