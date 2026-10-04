import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UniversalScraper } from '../src/index.js';
import { loadSeeds, parseSeed, runCrawl, runRepeated, summarizeRuns } from '../scripts/site-crawl.js';

describe('loadSeeds', () => {
  it('loads every URL from URL_FILE text and fixes the origin from the first seed', () => {
    const text = 'https://shop.test/a\nhttps://shop.test/b?x=1\nhttps://shop.test/c#frag\n';
    expect(loadSeeds({ fileText: text })).toEqual({
      seeds: ['https://shop.test/a', 'https://shop.test/b?x=1', 'https://shop.test/c'],
      origin: 'https://shop.test',
      invalidLines: [],
      offOrigin: [],
      duplicates: 0,
    });
  });

  it('deduplicates seeds after normalisation', () => {
    const text = ['https://shop.test/a', 'HTTPS://SHOP.TEST:443/a', 'https://shop.test/a#top', '  https://shop.test/a  ', 'https://shop.test/a/'].join('\n');
    const result = loadSeeds({ fileText: text });
    expect(result.seeds).toEqual(['https://shop.test/a', 'https://shop.test/a/']);
    expect(result.duplicates).toBe(3);
  });

  it('ignores blank lines and reports malformed ones by line number', () => {
    const text = [
      '', 'https://shop.test/ok', '   ', '/relative/path', 'shop.test/no-scheme', 'mailto:a@shop.test',
      'ftp://shop.test/file', 'https://[bad', '# a comment', 'https://shop.test/ok2', '\t',
    ].join('\r\n');
    const result = loadSeeds({ fileText: text });
    expect(result.seeds).toEqual(['https://shop.test/ok', 'https://shop.test/ok2']);
    expect(result.invalidLines).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('combines START_URL and URL_FILE, START_URL first and owning the origin', () => {
    const text = 'https://www.shop.test/x\nhttps://shop.test/b\nhttps://shop.test/\nhttps://other.test/y\nhttps://shop.test/b';
    const result = loadSeeds({ startUrl: 'https://shop.test/', fileText: text });
    expect(result.origin).toBe('https://shop.test');
    expect(result.seeds).toEqual(['https://shop.test/', 'https://shop.test/b']);
    expect(result.offOrigin).toEqual(['https://www.shop.test/x', 'https://other.test/y']);
    expect(result.duplicates).toBe(2);
  });

  it('keeps START_URL-only behaviour and rejects an invalid START_URL', () => {
    expect(loadSeeds({ startUrl: 'https://shop.test' }).seeds).toEqual(['https://shop.test/']);
    expect(() => loadSeeds({ startUrl: 'shop.test' })).toThrow(/START_URL is not an absolute http\(s\) URL/);
    expect(loadSeeds({ fileText: '\n\n' })).toMatchObject({ seeds: [], origin: null });
  });

  it('parseSeed only accepts absolute http(s) URLs', () => {
    expect(parseSeed('http://a.test/x#y')).toBe('http://a.test/x');
    expect(parseSeed('/x')).toBeNull();
    expect(parseSeed('javascript:alert(1)')).toBeNull();
  });
});

/** In-memory site: path → HTML. Unknown paths return 404. */
function siteFetch(pages: Record<string, string>) {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);
    const html = pages[url.pathname + url.search];
    return html === undefined
      ? new Response('missing', { status: 404 })
      : new Response(html, { headers: { 'content-type': 'text/html' } });
  };
  return { requested, fetchImpl };
}

const crawlOptions = { origin: 'https://shop.test', maxPages: 50, concurrency: 3, deadlineMs: 5_000 };

describe('runCrawl with seeds', () => {
  it('crawls every seed, keeps discovering links, and never refetches a URL', async () => {
    const { requested, fetchImpl } = siteFetch({
      '/a': '<a href="/c">c</a><a href="/b">b (also a seed)</a><a href="https://other.test/x">ext</a>',
      '/b': '<a href="/a">back to a</a><a href="/d#part">d</a><a href="/logo.png">img</a>',
      '/c': '<a href="/e">e</a>',
      '/d': 'leaf',
      '/e': '<a href="/c">loop</a>',
      '/orphan': 'only reachable as a seed',
    });
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await runCrawl(scraper, { ...crawlOptions, seeds: ['https://shop.test/a', 'https://shop.test/b', 'https://shop.test/orphan'] });

    expect([...requested].sort()).toEqual(['/a', '/b', '/c', '/d', '/e', '/orphan']);
    expect(result.discovered).toBe(6);
    expect(result.records.every((r) => r.ok)).toBe(true);
    expect(result.stopReason).toBe('no more links');
    for (const r of result.records) {
      expect(r.fetchMs).toEqual(expect.any(Number));
      expect(r.parseMs).toEqual(expect.any(Number));
    }
  });

  it('records failed seeds without stopping the crawl', async () => {
    const { fetchImpl } = siteFetch({ '/ok': '<a href="/next">n</a>', '/next': 'leaf' });
    const scraper = new UniversalScraper({ http: { fetchImpl, retries: 0 } });
    const result = await runCrawl(scraper, { ...crawlOptions, seeds: ['https://shop.test/gone', 'https://shop.test/ok'] });
    expect(result.records.map((r) => [r.url, r.ok])).toEqual(expect.arrayContaining([
      ['https://shop.test/gone', false], ['https://shop.test/ok', true], ['https://shop.test/next', true],
    ]));
    expect(result.records.find((r) => !r.ok)?.error).toContain('HTTP 404');
  });

  it('stops at maxPages even when seeds alone exceed it', async () => {
    const { requested, fetchImpl } = siteFetch(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/p${i}`, 'x'])));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const seeds = Array.from({ length: 10 }, (_, i) => `https://shop.test/p${i}`);
    const result = await runCrawl(scraper, { ...crawlOptions, seeds, maxPages: 4 });
    expect(requested).toHaveLength(4);
    expect(result.stopReason).toBe('MAX_PAGES');
  });
});

describe('measure-site script with URL_FILE (end to end)', () => {
  let server: Server;
  let base = '';
  let dir = '';
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const pages: Record<string, string> = {
        '/seed-1': '<a href="/found">f</a>',
        '/seed-2': '<a href="/seed-1">dup</a>',
        '/found': 'leaf',
      };
      const html = pages[req.url ?? ''];
      res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
      res.end(html ?? 'missing');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
    dir = mkdtempSync(join(tmpdir(), 'measure-site-'));
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds from the file, reports seed URLs, and discovers further links', async () => {
    const file = join(dir, 'urls.txt');
    writeFileSync(file, [`${base}/seed-1`, '', `${base}/seed-2`, `${base}/seed-1#again`, 'not a url', 'https://external.test/x'].join('\n'));

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/measure-site.ts'],
      { env: { ...process.env, URL_FILE: file, CONCURRENCY: '2', START_URL: '' }, timeout: 30_000 },
    );

    expect(stdout).toMatch(/seed URLs\s+2\n/);
    expect(stdout).toMatch(/duplicate seeds\s+1\n/);
    expect(stdout).toMatch(/invalid lines\s+1 \(line 5\)/);
    expect(stdout).toMatch(/other origins\s+1 skipped/);
    expect(stdout).toMatch(/discovered URLs\s+3\n/);
    expect(stdout).toMatch(/crawled URLs\s+3\n/);
    expect(stdout).toMatch(/successful\s+3\n/);
    expect([...hits].sort()).toEqual(['/found', '/seed-1', '/seed-2']);
  }, 40_000);

  it('REPEATS=3 prints three runs, re-fetches every page each run, and adds a summary', async () => {
    hits.length = 0;
    const file = join(dir, 'repeat-urls.txt');
    writeFileSync(file, `${base}/seed-1\n${base}/seed-2\n`);

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/measure-site.ts'],
      { env: { ...process.env, URL_FILE: file, REPEATS: '3', START_URL: '' }, timeout: 30_000 },
    );

    expect(stdout.match(/=== RUN \d of 3 ===/g)).toEqual(['=== RUN 1 of 3 ===', '=== RUN 2 of 3 ===', '=== RUN 3 of 3 ===']);
    expect(stdout.match(/crawled URLs\s+3\n/g)).toHaveLength(3);
    expect(stdout).toMatch(/=== SUMMARY \(3 runs, whole-crawl duration\) ===/);
    for (const label of ['average crawl duration', 'median crawl duration', 'min crawl duration', 'max crawl duration']) {
      expect(stdout).toMatch(new RegExp(`${label}\\s+\\d+\\.\\d{2} s`));
    }
    expect(stdout).toMatch(/average pages\/sec\s+\d+\.\d{2}/);
    expect([...hits].sort()).toEqual(['/found', '/found', '/found', '/seed-1', '/seed-1', '/seed-1', '/seed-2', '/seed-2', '/seed-2']);
  }, 40_000);

  it('REPEATS unset keeps the single-run output without RUN headers or summary', async () => {
    const file = join(dir, 'single-urls.txt');
    writeFileSync(file, `${base}/seed-1\n`);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/measure-site.ts'],
      { env: { ...process.env, URL_FILE: file, START_URL: '', REPEATS: '' }, timeout: 30_000 },
    );
    expect(stdout).not.toMatch(/=== RUN/);
    expect(stdout).not.toMatch(/SUMMARY/);
    expect(stdout).toMatch(/seed URLs\s+1\n[\s\S]*crawled URLs\s+2\n/);
  }, 40_000);
});

describe('REPEATS', () => {
  const pages = {
    '/': '<a href="/a">a</a><a href="/b">b</a>',
    '/a': '<a href="/c">c</a><a href="/">home</a>',
    '/b': '<a href="/a">a</a>',
    '/c': 'leaf',
  };

  it('runRepeated performs three independent crawls that each re-fetch every page', async () => {
    const { requested, fetchImpl } = siteFetch(pages);
    const scrapers: UniversalScraper[] = [];
    const started: number[] = [];
    const ended: number[] = [];
    const results = await runRepeated(
      3,
      () => { const s = new UniversalScraper({ http: { fetchImpl } }); scrapers.push(s); return s; },
      { ...crawlOptions, seeds: ['https://shop.test/'] },
      { onRunStart: (run) => started.push(run), onRunEnd: (run) => ended.push(run) },
    );

    expect(results).toHaveLength(3);
    expect(started).toEqual([1, 2, 3]);
    expect(ended).toEqual([1, 2, 3]);
    expect(new Set(scrapers).size).toBe(3);
    // Each run discovers and fetches the same four pages again; nothing is carried over.
    for (const r of results) {
      expect(r.discovered).toBe(4);
      expect(r.records).toHaveLength(4);
      expect(r.records.every((x) => x.ok)).toBe(true);
    }
    const counts = requested.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p]: (acc[p] ?? 0) + 1 }), {});
    expect(counts).toEqual({ '/': 3, '/a': 3, '/b': 3, '/c': 3 });
  });

  it('defaults to one run and summarises whole-crawl durations', async () => {
    const { fetchImpl } = siteFetch(pages);
    const single = await runRepeated(0, () => new UniversalScraper({ http: { fetchImpl } }), { ...crawlOptions, seeds: ['https://shop.test/'] });
    expect(single).toHaveLength(1);

    const fake = (crawlMs: number, pagesCrawled: number) => ({
      records: Array.from({ length: pagesCrawled }, () => ({ url: 'u', ok: true, totalMs: 1, links: 0 })),
      discovered: pagesCrawled, abortedAtDeadline: 0, stopReason: 'no more links' as const, crawlMs,
    });
    expect(summarizeRuns([fake(2000, 10), fake(1000, 10), fake(4000, 10)])).toEqual({
      runs: 3,
      avgCrawlMs: 7000 / 3,
      medianCrawlMs: 2000,
      minCrawlMs: 1000,
      maxCrawlMs: 4000,
      avgPagesPerSec: (5 + 10 + 2.5) / 3,
    });
    expect(summarizeRuns([fake(1000, 1), fake(3000, 1)]).medianCrawlMs).toBe(2000);
  });
});
