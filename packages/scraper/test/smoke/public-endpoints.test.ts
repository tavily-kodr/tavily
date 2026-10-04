import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UniversalScraper } from '../../src/index.js';

/**
 * Smoke tests against public, documented-for-testing endpoints. They verify
 * the real transport path (TLS, compression, charset, redirects) that unit
 * tests with mocked fetch cannot. Run with `pnpm test:smoke`.
 */
const scraper = new UniversalScraper({
  http: { timeoutMs: 20_000, retries: 2, perHost: { concurrency: 2, minIntervalMs: 250 } },
});

const post = z.object({ id: z.number(), userId: z.number(), title: z.string() });

describe('public endpoints (network)', () => {
  it('fetches a JSON API with page-number pagination', async () => {
    const result = await scraper.scrape([{
      url: 'https://jsonplaceholder.typicode.com/posts',
      extraction: { type: 'json' },
      schema: post,
      pagination: { mode: 'page', pageParam: '_page', pageSizeParam: '_limit', pageSize: 10, maxPages: 2 },
    }]);
    expect(result.stats.failedPages).toBe(0);
    expect(result.stats.pages).toBe(2);
    expect(result.items).toHaveLength(20);
    expect(new Set(result.items.map((i) => i.data.id)).size).toBe(20);
  });

  it('auto-detects and extracts an HTML page', async () => {
    // example.com asks not to be used for testing, so use httpbin's HTML sample.
    const result = await scraper.scrape([{
      url: 'https://httpbin.org/html',
      extraction: { type: 'html', selector: 'h1' },
    }]);
    expect(result.stats.failedPages).toBe(0);
    expect(result.items.map((i) => i.data)).toEqual(['Herman Melville - Moby-Dick']);
  });

  it('records a 404 as a failure with its status', async () => {
    const result = await scraper.scrape(
      [{ url: 'https://jsonplaceholder.typicode.com/posts/999999', extraction: { type: 'json' } }],
      { continueOnPageError: true },
    );
    expect(result.stats.failures[0]?.status).toBe(404);
  });
});
