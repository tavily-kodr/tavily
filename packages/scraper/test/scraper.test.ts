import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { UniversalScraper, type PageEvent } from '../src/index.js';

const productSchema = z.object({ id: z.number(), title: z.string() });

function response(body: string, contentType = 'application/json') {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('UniversalScraper', () => {
  it('fetches JSON and extracts an array by path', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      expect(String(url)).toBe('https://api.test/products');
      return response(JSON.stringify({ products: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] }));
    };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{ url: 'https://api.test/products', extraction: { type: 'json', path: 'products' }, schema: productSchema }]);
    expect(result.items.map((x) => x.data)).toEqual([{ id: 1, title: 'A' }, { id: 2, title: 'B' }]);
    expect(result.stats.items).toBe(2);
  });

  it('auto detects HTML and extracts fields', async () => {
    const fetchImpl = async (): Promise<Response> => response(
      '<ul><li class="product"><a class="title" href="/1">One</a></li><li class="product"><a class="title" href="/2">Two</a></li></ul>',
      'text/html; charset=utf-8',
    );
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{
      url: 'https://example.test/products',
      extraction: { type: 'html', selector: '.product', fields: { title: { selector: '.title' }, url: { selector: '.title', attribute: 'href' } } },
    }]);
    expect(result.items.map((x) => x.data)).toEqual([{ title: 'One', url: '/1' }, { title: 'Two', url: '/2' }]);
  });

  it('follows next-link pagination completely', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      calls.push(String(url));
      if (String(url).endsWith('/1')) return response('<a rel="next" href="/2">Next</a>', 'text/html');
      return response('<div class="item">done</div>', 'text/html');
    };
    const scraper = new UniversalScraper({ http: { baseUrl: 'https://example.test', fetchImpl } });
    const result = await scraper.scrape([{ url: '/1', mode: 'html', extraction: { type: 'html', selector: '.item' }, pagination: { mode: 'next-link', maxPages: 5 } }]);
    expect(calls).toEqual(['https://example.test/1', 'https://example.test/2']);
    expect(result.items).toHaveLength(1);
  });

  it('skips schema-invalid records without aborting the target', async () => {
    const fetchImpl = async (): Promise<Response> => response(JSON.stringify({ items: [
      { id: 1, title: 'valid' },
      { id: 'bad', title: 42 },
      { id: 2, title: 'valid-2' },
    ] }));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{ url: 'https://api.test/items', extraction: { type: 'json', path: 'items' }, schema: productSchema }]);
    expect(result.items.map((x) => x.data)).toEqual([{ id: 1, title: 'valid' }, { id: 2, title: 'valid-2' }]);
    expect(result.stats.invalidItems).toBe(1);
    expect(result.stats.failedPages).toBe(0);
  });

  it('respects maxItems globally across concurrent targets', async () => {
    const fetchImpl = async (): Promise<Response> => response(JSON.stringify({ items: [{ id: 1, title: 'x' }] }));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const targets = Array.from({ length: 10 }, (_, i) => ({ url: `https://api.test/${i}`, mode: 'json' as const, extraction: { type: 'json' as const, path: 'items' }, schema: productSchema }));
    const result = await scraper.scrape(targets, { concurrency: 10, maxItems: 3 });
    expect(result.items).toHaveLength(3);
    expect(result.stats.items).toBe(3);
  });

  it('respects concurrency across targets', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = async (): Promise<Response> => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return response('{"id":1,"title":"x"}');
    };
    const scraper = new UniversalScraper({ http: { concurrency: 10, fetchImpl } });
    const targets = Array.from({ length: 20 }, (_, i) => ({ url: `https://api.test/${i}`, extraction: { type: 'json' as const }, schema: productSchema }));
    await scraper.scrape(targets, { concurrency: 4 });
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('fails clearly when an infinite pagination cycle is returned', async () => {
    const fetchImpl = async (): Promise<Response> => response('<a rel="next" href="/1">Next</a>', 'text/html');
    const scraper = new UniversalScraper({ http: { baseUrl: 'https://example.test', fetchImpl } });
    const result = await scraper.scrape([{ url: '/1', mode: 'html', extraction: { type: 'html', selector: 'a' }, pagination: { mode: 'next-link' } }], { continueOnPageError: true });
    expect(result.stats.failedPages).toBe(1);
    expect(result.stats.failures[0]?.message).toContain('Pagination cycle detected');
  });

  it('handles backpressure when items exceed highWaterMark without deadlocking', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, title: `item-${i}` }));
    const fetchImpl = async (): Promise<Response> => response(JSON.stringify({ items }));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{ url: 'https://api.test/items', extraction: { type: 'json', path: 'items' } }], { highWaterMark: 2 });
    expect(result.items).toHaveLength(10);
    expect(result.stats.items).toBe(10);
  });

  it('aborts and rejects when continueOnPageError is false and a page fails', async () => {
    const fetchImpl = async (): Promise<Response> => {
      return new Response('Not Found', { status: 404 });
    };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    await expect(scraper.scrape([{ url: 'https://api.test/missing' }])).rejects.toThrow();
  });

  it('computes durationMs and cleans up resources on early generator break', async () => {
    const fetchImpl = async (): Promise<Response> => {
      const items = Array.from({ length: 20 }, (_, i) => ({ id: i, title: `item-${i}` }));
      return response(JSON.stringify({ items }));
    };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const stream = scraper.stream([{ url: 'https://api.test/stream', extraction: { type: 'json', path: 'items' } }]);
    let count = 0;
    for await (const _ of stream) {
      count += 1;
      if (count === 3) break;
    }
    expect(count).toBe(3);
  });

  it('returns empty array when json path does not exist', async () => {
    const fetchImpl = async (): Promise<Response> => response(JSON.stringify({ other: 123 }));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{ url: 'https://api.test/empty', extraction: { type: 'json', path: 'missing' } }]);
    expect(result.items).toHaveLength(0);
    expect(result.stats.items).toBe(0);
  });

  it('applies startPage and pageSize to the first page request and stops on an empty page', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      calls.push(String(url));
      const page = Number(new URL(String(url)).searchParams.get('p'));
      return response(JSON.stringify({ items: page < 4 ? [{ id: page, title: `page-${page}` }] : [] }));
    };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{
      url: 'https://api.test/list',
      extraction: { type: 'json', path: 'items' },
      pagination: { mode: 'page', pageParam: 'p', startPage: 2, pageSizeParam: 'limit', pageSize: 25, maxPages: 10 },
    }]);
    expect(calls).toEqual([
      'https://api.test/list?p=2&limit=25',
      'https://api.test/list?p=3&limit=25',
      'https://api.test/list?p=4&limit=25',
    ]);
    expect(result.items.map((x) => x.data)).toEqual([{ id: 2, title: 'page-2' }, { id: 3, title: 'page-3' }]);
    expect(result.stats.pages).toBe(3);
  });

  it('uses extraction.type as the parse mode so a JSON rule on an HTML body fails loudly', async () => {
    const fetchImpl = async (): Promise<Response> => response('<html><body><h1>Access denied</h1></body></html>', 'text/html');
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape(
      [{ url: 'https://api.test/products', extraction: { type: 'json', path: 'products' } }],
      { continueOnPageError: true },
    );
    expect(result.items).toHaveLength(0);
    expect(result.stats.failedPages).toBe(1);
    expect(result.stats.failures[0]?.message).toContain('not valid JSON');
  });

  it('lets an explicit target.mode override extraction.type', async () => {
    const fetchImpl = async (): Promise<Response> => response('<p class="x">text</p>', 'text/html');
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{ url: 'https://api.test/x', mode: 'html', extraction: { type: 'json', selector: '.x' } }]);
    expect(result.items.map((x) => x.data)).toEqual(['text']);
  });

  it('follows next links whose rel has several tokens', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => String(url).endsWith('/1')
      ? response('<a rel="nofollow next" href="/2">Next</a>', 'text/html')
      : response('<div class="item">done</div>', 'text/html');
    const scraper = new UniversalScraper({ http: { baseUrl: 'https://example.test', fetchImpl } });
    const result = await scraper.scrape([{ url: '/1', extraction: { type: 'html', selector: '.item' }, pagination: { mode: 'next-link', maxPages: 5 } }]);
    expect(result.stats.pages).toBe(2);
    expect(result.items).toHaveLength(1);
  });

  it('falls back to the renderer when render=on-error and the fetch fails', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('blocked', { status: 403 });
    const rendered: string[] = [];
    const scraper = new UniversalScraper({
      http: { fetchImpl, retries: 0 },
      renderer: {
        async render(url) {
          rendered.push(url);
          return { url, contentType: 'text/html', body: '<div class="item">rendered</div>' };
        },
      },
    });
    const result = await scraper.scrape([{ url: 'https://example.test/x', render: 'on-error', extraction: { type: 'html', selector: '.item' } }]);
    expect(rendered).toEqual(['https://example.test/x']);
    expect(result.items.map((x) => x.data)).toEqual(['rendered']);
  });

  it('stops promptly when the caller aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
      });
      return response('{}');
    };
    const scraper = new UniversalScraper({ http: { fetchImpl, retries: 0 } });
    const targets = Array.from({ length: 4 }, (_, i) => ({ url: `https://api.test/${i}` }));
    const pending = scraper.scrape(targets, { signal: controller.signal, concurrency: 4 });
    setTimeout(() => controller.abort(new Error('caller cancelled')), 20);
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(calls).toBe(4);
  });

  it('drops duplicates across pages and targets when dedupeKey is set', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const u = new URL(String(url));
      const next = u.pathname === '/a' ? '/a2' : null;
      return response(JSON.stringify({ items: [{ id: 1, title: 'x' }, { id: 2, title: 'y' }], next }));
    };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape(
      [
        { url: 'https://api.test/a', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'next-link' } },
        { url: 'https://api.test/b', extraction: { type: 'json', path: 'items' } },
      ],
      { dedupeKey: (data) => String((data as { id: number }).id) },
    );
    expect(result.items.map((x) => (x.data as { id: number }).id)).toEqual([1, 2]);
    expect(result.stats.pages).toBe(3);
    expect(result.stats.items).toBe(2);
    expect(result.stats.duplicateItems).toBe(4);
  });

  it('stops at maxPages even when pages keep returning items', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => { calls += 1; return response(JSON.stringify({ items: [{ id: calls, title: 't' }] })); };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{ url: 'https://api.test/p', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'page', maxPages: 3 } }]);
    expect(calls).toBe(3);
    expect(result.stats.pages).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  it('returns empty results for no targets and for pages with no matches', async () => {
    const scraper = new UniversalScraper({ http: { fetchImpl: async () => response('<p>nothing</p>', 'text/html') } });
    const none = await scraper.scrape([]);
    expect(none.items).toEqual([]);
    expect(none.stats).toMatchObject({ targets: 0, pages: 0, items: 0 });

    const empty = await scraper.scrape([{ url: 'https://example.test/x', extraction: { type: 'html', selector: '.missing' } }]);
    expect(empty.items).toEqual([]);
    expect(empty.stats).toMatchObject({ pages: 1, items: 0, failedPages: 0 });
  });

  it('isolates a malformed JSON page to its own target when continueOnPageError is set', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => String(url).endsWith('/bad')
      ? response('{"items": [truncated', 'application/json')
      : response(JSON.stringify({ items: [{ id: 1, title: 'ok' }] }));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape(
      [{ url: 'https://api.test/bad', extraction: { type: 'json', path: 'items' } }, { url: 'https://api.test/good', extraction: { type: 'json', path: 'items' } }],
      { continueOnPageError: true },
    );
    expect(result.items.map((x) => x.data)).toEqual([{ id: 1, title: 'ok' }]);
    expect(result.stats.failedPages).toBe(1);
    expect(result.stats.failures[0]).toMatchObject({ sourceUrl: 'https://api.test/bad', message: expect.stringContaining('not valid JSON') });
  });

  it('records the HTTP status on page failures', async () => {
    const scraper = new UniversalScraper({ http: { fetchImpl: async () => new Response('gone', { status: 410 }) } });
    const result = await scraper.scrape([{ url: 'https://api.test/old' }], { continueOnPageError: true });
    expect(result.stats.failures[0]).toMatchObject({ status: 410, message: expect.stringContaining('HTTP 410') });
  });

  it('stops fetching further pages once the consumer breaks early', async () => {
    let calls = 0;
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      const page = Number(new URL(String(url)).searchParams.get('page') ?? '1');
      return response(JSON.stringify({ items: [{ id: page, title: 't' }] }));
    };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const stream = scraper.stream([{ url: 'https://api.test/p', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'page', maxPages: 100 } }]);
    for await (const _ of stream) break;
    const callsAtBreak = calls;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBeLessThanOrEqual(callsAtBreak + 1);
    expect(calls).toBeLessThan(10);
  });

  it('records an oversized page as a failure without buffering it', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('x'.repeat(2_000), { status: 200, headers: { 'content-type': 'text/html' } });
    const scraper = new UniversalScraper({ http: { fetchImpl, maxResponseBytes: 1_000 } });
    const result = await scraper.scrape([{ url: 'https://example.test/huge' }], { continueOnPageError: true });
    expect(result.items).toHaveLength(0);
    expect(result.stats.failures[0]?.message).toContain('exceeds maxResponseBytes=1000');
  });

  describe('parallel page-number pagination', () => {
    /** Pages 1..7 have one item each; page 8 onwards is empty. */
    function pagedFetch(onRequest?: (page: number) => void | Promise<void>) {
      return async (url: string | URL | Request): Promise<Response> => {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        await onRequest?.(page);
        return response(JSON.stringify({ items: page <= 7 ? [{ id: page, title: `p${page}` }] : [] }));
      };
    }

    it('fetches pages concurrently, emits them in order and stops at the first empty page', async () => {
      let active = 0;
      let maxActive = 0;
      const fetchImpl = pagedFetch(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const result = await scraper.scrape([{
        url: 'https://api.test/list',
        extraction: { type: 'json', path: 'items' },
        pagination: { mode: 'page', pageConcurrency: 4, maxPages: 20 },
      }]);
      expect(result.items.map((x) => (x.data as { id: number }).id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(maxActive).toBe(4);
      // Two batches of four: pages 1-4, then 5-8 (page 8 is the empty stop page).
      expect(result.stats.pages).toBe(8);
    });

    it('respects maxPages and maxItems', async () => {
      const scraper = new UniversalScraper({ http: { fetchImpl: pagedFetch() } });
      const target = { url: 'https://api.test/list', extraction: { type: 'json' as const, path: 'items' } };

      const capped = await scraper.scrape([{ ...target, pagination: { mode: 'page', pageConcurrency: 4, maxPages: 6 } }]);
      expect(capped.stats.pages).toBe(6);
      expect(capped.items).toHaveLength(6);

      const limited = await scraper.scrape([{ ...target, pagination: { mode: 'page', pageConcurrency: 4 } }], { maxItems: 3 });
      expect(limited.items.map((x) => (x.data as { id: number }).id)).toEqual([1, 2, 3]);
      expect(limited.stats.items).toBe(3);
    });

    it('reports the failing page URL and honours startPage', async () => {
      const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        if (page === 3) return new Response('boom', { status: 500 });
        return response(JSON.stringify({ items: [{ id: page, title: 't' }] }));
      };
      const scraper = new UniversalScraper({ http: { fetchImpl, retries: 0 } });
      const result = await scraper.scrape(
        [{ url: 'https://api.test/list', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'page', pageConcurrency: 3, startPage: 2, maxPages: 3 } }],
        { continueOnPageError: true },
      );
      expect(result.stats.failures[0]).toMatchObject({ pageUrl: 'https://api.test/list?page=3', status: 500 });
      expect(result.items).toHaveLength(0);
    });

    it('is ignored for cursor and next-link modes', async () => {
      let calls = 0;
      const fetchImpl = async (): Promise<Response> => {
        calls += 1;
        return response(JSON.stringify({ items: [{ id: calls, title: 't' }], next_cursor: calls < 3 ? `c${calls}` : null }));
      };
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const result = await scraper.scrape([{
        url: 'https://api.test/c',
        extraction: { type: 'json', path: 'items' },
        pagination: { mode: 'cursor', pageConcurrency: 8 },
      }]);
      expect(calls).toBe(3);
      expect(result.items).toHaveLength(3);
    });
  });

  it('types items from the target schema', async () => {
    const fetchImpl = async (): Promise<Response> => response(JSON.stringify({ items: [{ id: 1, title: 'A' }] }));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const typed = await scraper.scrape([{ url: 'https://api.test/p', extraction: { type: 'json', path: 'items' }, schema: productSchema }]);
    expectTypeOf(typed.items[0]!.data).toEqualTypeOf<{ id: number; title: string }>();
    expect(typed.items[0]?.data.title).toBe('A');

    const untyped = await scraper.scrape([{ url: 'https://api.test/p', extraction: { type: 'json', path: 'items' } }]);
    expectTypeOf(untyped.items[0]!.data).toEqualTypeOf<unknown>();
  });

  it('follows offset pagination end to end', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      calls.push(String(url));
      const offset = Number(new URL(String(url)).searchParams.get('offset'));
      const items = Array.from({ length: Math.max(0, Math.min(2, 5 - offset)) }, (_, i) => ({ id: offset + i, title: 't' }));
      return response(JSON.stringify({ items }));
    };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{ url: 'https://api.test/items', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'offset', pageSizeParam: 'limit', pageSize: 2 } }]);
    expect(calls).toEqual([
      'https://api.test/items?offset=0&limit=2',
      'https://api.test/items?offset=2&limit=2',
      'https://api.test/items?offset=4&limit=2',
    ]);
    expect(result.items.map((x) => (x.data as { id: number }).id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reports progress through onPage and onFailure', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => String(url).endsWith('/bad')
      ? new Response('nope', { status: 404 })
      : response(JSON.stringify({ items: [{ id: 1, title: 'x' }, { id: 2, title: 'y' }] }));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const pages: string[] = [];
    const failures: string[] = [];
    const result = await scraper.scrape(
      [{ url: 'https://api.test/good', extraction: { type: 'json', path: 'items' } }, { url: 'https://api.test/bad' }],
      {
        continueOnPageError: true,
        onPage: (event) => { pages.push(`${event.pageUrl} status=${event.status} items=${event.itemCount}`); expect(event.durationMs).toBeGreaterThanOrEqual(0); },
        onFailure: (failure) => failures.push(`${failure.pageUrl} ${failure.status}`),
      },
    );
    expect(pages).toEqual(['https://api.test/good status=200 items=2']);
    expect(failures).toEqual(['https://api.test/bad 404']);
    expect(result.stats.failedPages).toBe(1);
  });

  describe('deadlineMs', () => {
    /** Responds instantly for /fast and stalls until aborted for /slow. */
    function mixedFetch(onAbort?: () => void) {
      return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(url).endsWith('/fast')) return Promise.resolve(response(JSON.stringify({ items: [{ id: 1, title: 'fast' }] })));
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => { onAbort?.(); reject(init.signal?.reason); }, { once: true });
        });
      };
    }
    const targets = [
      { url: 'https://api.test/fast', extraction: { type: 'json' as const, path: 'items' } },
      { url: 'https://api.test/slow', extraction: { type: 'json' as const, path: 'items' } },
    ];

    it('returns the items collected so far, flags truncation and aborts stalled requests', async () => {
      let aborted = false;
      const scraper = new UniversalScraper({ http: { fetchImpl: mixedFetch(() => { aborted = true; }), retries: 0 } });
      const started = Date.now();
      const result = await scraper.scrape(targets, { deadlineMs: 60 });
      expect(Date.now() - started).toBeLessThan(500);
      expect(result.items.map((x) => x.data)).toEqual([{ id: 1, title: 'fast' }]);
      expect(result.stats.truncated).toBe(true);
      expect(result.stats.failedPages).toBe(0);
      expect(aborted).toBe(true);
    });

    it('does not truncate or reject when the work finishes first', async () => {
      const scraper = new UniversalScraper({ http: { fetchImpl: async () => response(JSON.stringify({ items: [{ id: 1, title: 'x' }] })) } });
      const result = await scraper.scrape([targets[0]!], { deadlineMs: 5_000 });
      expect(result.stats.truncated).toBe(false);
      expect(result.items).toHaveLength(1);
    });

    it('still rejects on a real page failure that happens before the deadline', async () => {
      const fetchImpl = async (): Promise<Response> => new Response('nope', { status: 500 });
      const scraper = new UniversalScraper({ http: { fetchImpl, retries: 0 } });
      await expect(scraper.scrape([{ url: 'https://api.test/x' }], { deadlineMs: 5_000 })).rejects.toThrow('HTTP 500');
    });

    it('stops pagination at the deadline and keeps pages already emitted', async () => {
      const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
        await new Promise((r) => setTimeout(r, 20));
        const page = Number(new URL(String(url)).searchParams.get('page'));
        return response(JSON.stringify({ items: [{ id: page, title: 't' }] }));
      };
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const result = await scraper.scrape(
        [{ url: 'https://api.test/p', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'page', maxPages: 1000 } }],
        { deadlineMs: 100 },
      );
      expect(result.stats.truncated).toBe(true);
      expect(result.items.length).toBeGreaterThanOrEqual(2);
      expect(result.items.length).toBeLessThan(10);
    });
  });

  describe('request coalescing', () => {
    function countingFetch(delayMs = 20) {
      const calls: string[] = [];
      const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
        calls.push(String(url));
        await new Promise((r) => setTimeout(r, delayMs));
        return response(JSON.stringify({ items: [{ id: 1, title: 'x' }] }));
      };
      return { calls, fetchImpl };
    }
    const target = { url: 'https://api.test/same', extraction: { type: 'json' as const, path: 'items' } };

    it('sends one request for identical concurrent pages and gives every target its items', async () => {
      const { calls, fetchImpl } = countingFetch();
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const result = await scraper.scrape([target, target, target], { concurrency: 3 });
      expect(calls).toHaveLength(1);
      expect(result.items).toHaveLength(3);
      expect(result.stats).toMatchObject({ pages: 3, items: 3, coalescedRequests: 2 });
    });

    it('is not a cache: sequential requests for the same URL are sent again', async () => {
      const { calls, fetchImpl } = countingFetch(1);
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const result = await scraper.scrape([target, target, target], { concurrency: 1 });
      expect(calls).toHaveLength(3);
      expect(result.stats.coalescedRequests).toBe(0);
    });

    it('keeps requests with different headers or render settings separate', async () => {
      const { calls, fetchImpl } = countingFetch();
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const result = await scraper.scrape([
        { ...target, headers: { 'X-Lang': 'en' } },
        { ...target, headers: { 'x-lang': 'en' } },
        { ...target, headers: { 'X-Lang': 'hi' } },
        { ...target, render: 'on-error' },
      ], { concurrency: 4 });
      expect(calls).toHaveLength(3);
      expect(result.stats.coalescedRequests).toBe(1);
    });

    it('can be turned off', async () => {
      const { calls, fetchImpl } = countingFetch();
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      await scraper.scrape([target, target, target], { concurrency: 3, coalesceRequests: false });
      expect(calls).toHaveLength(3);
    });

    it('reports a shared failure on every target that waited for it', async () => {
      let calls = 0;
      const fetchImpl = async (): Promise<Response> => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return new Response('down', { status: 503 });
      };
      const scraper = new UniversalScraper({ http: { fetchImpl, retries: 0 } });
      const result = await scraper.scrape([target, target], { concurrency: 2, continueOnPageError: true });
      expect(calls).toBe(1);
      expect(result.stats.failedPages).toBe(2);
      expect(result.stats.failures.map((f) => f.status)).toEqual([503, 503]);
    });
  });

  describe('page timing', () => {
    function capture() {
      const events: PageEvent[] = [];
      return { events, onPage: (event: PageEvent) => { events.push(event); } };
    }

    it('records fetchMs, parseMs and totalMs on every page event', async () => {
      const fetchImpl = async (): Promise<Response> => response(JSON.stringify({ items: [{ id: 1, title: 'x' }] }));
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const { events, onPage } = capture();
      await scraper.scrape([{ url: 'https://api.test/t', extraction: { type: 'json', path: 'items' } }], { onPage });

      expect(events).toHaveLength(1);
      const [event] = events;
      for (const key of ['fetchMs', 'parseMs', 'totalMs', 'durationMs'] as const) {
        expect(event?.[key]).toEqual(expect.any(Number));
        expect(event?.[key]).toBeGreaterThanOrEqual(0);
      }
      expect(event?.totalMs).toBeGreaterThanOrEqual((event?.fetchMs ?? 0) + (event?.parseMs ?? 0) - 0.001);
      expect(event?.durationMs).toBe(event?.totalMs);
    });

    it('counts network wait in fetchMs and not in parseMs', async () => {
      const fetchImpl = async (): Promise<Response> => {
        await new Promise((r) => setTimeout(r, 60));
        return response('<p class="a">hi</p>', 'text/html');
      };
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const { events, onPage } = capture();
      await scraper.scrape([{ url: 'https://example.test/slow', extraction: { type: 'html', selector: '.a' } }], { onPage });

      expect(events[0]?.fetchMs).toBeGreaterThanOrEqual(55);
      expect(events[0]?.parseMs).toBeLessThan(events[0]?.fetchMs ?? 0);
    });

    it('counts parsing in parseMs and not in fetchMs', async () => {
      // Instant network, large document: parse5 needs far longer than reading the body.
      const big = `<html><body>${'<div class="row"><span>cell</span><a href="/x">link</a></div>'.repeat(60_000)}</body></html>`;
      const fetchImpl = async (): Promise<Response> => response(big, 'text/html');
      const scraper = new UniversalScraper({ http: { fetchImpl, maxResponseBytes: 50 * 1024 * 1024 } });
      const { events, onPage } = capture();
      await scraper.scrape([{ url: 'https://example.test/big', extraction: { type: 'html', selector: '.row' } }], { onPage });

      expect(events[0]?.itemCount).toBe(60_000);
      expect(events[0]?.parseMs).toBeGreaterThan(events[0]?.fetchMs ?? Infinity);
      expect(events[0]?.fetchMs).toBeLessThan(100);
    });

    it('reports a timing event per page with its own values', async () => {
      const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        await new Promise((r) => setTimeout(r, page === 2 ? 50 : 1));
        return response(JSON.stringify({ items: page < 3 ? [{ id: page, title: 't' }] : [] }));
      };
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      const { events, onPage } = capture();
      await scraper.scrape([{ url: 'https://api.test/p', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'page' } }], { onPage });
      expect(events.map((e) => e.pageUrl)).toEqual(['https://api.test/p?page=1', 'https://api.test/p?page=2', 'https://api.test/p?page=3']);
      expect(events[1]?.fetchMs).toBeGreaterThanOrEqual(45);
      expect(events[0]?.fetchMs).toBeLessThan(events[1]?.fetchMs ?? 0);
    });

    it('does not fail the scrape when onPage or onFailure throw', async () => {
      const fetchImpl = async (url: string | URL | Request): Promise<Response> => String(url).endsWith('/bad')
        ? new Response('nope', { status: 404 })
        : response(JSON.stringify({ items: [{ id: 1, title: 'x' }, { id: 2, title: 'y' }] }));
      const scraper = new UniversalScraper({ http: { fetchImpl } });
      let pageCalls = 0;
      let failureCalls = 0;
      const result = await scraper.scrape(
        [{ url: 'https://api.test/good', extraction: { type: 'json', path: 'items' } }, { url: 'https://api.test/bad' }],
        {
          continueOnPageError: true,
          onPage: () => { pageCalls += 1; throw new Error('metrics bug'); },
          onFailure: () => { failureCalls += 1; throw new Error('logger bug'); },
        },
      );
      expect(pageCalls).toBe(1);
      expect(failureCalls).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.stats).toMatchObject({ pages: 1, failedPages: 1, items: 2 });
    });
  });

  it('handles cursor pagination with numeric cursor', async () => {
    let call = 0;
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      call += 1;
      const strUrl = String(url);
      if (call === 1) {
        return response(JSON.stringify({ items: [{ id: 1, title: 'one' }], next_cursor: 999 }));
      }
      expect(strUrl).toContain('cursor=999');
      return response(JSON.stringify({ items: [{ id: 2, title: 'two' }] }));
    };
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape([{
      url: 'https://api.test/cursor',
      extraction: { type: 'json', path: 'items' },
      pagination: { mode: 'cursor', cursorParam: 'cursor', maxPages: 2 },
    }]);
    expect(result.items).toHaveLength(2);
    expect(call).toBe(2);
  });
});
