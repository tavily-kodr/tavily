import { describe, expect, it } from 'vitest';
import { extractFromPage, extractNextLink, getInitialPageUrl, getNextPageInfo, parsePage } from '../src/index.js';

describe('getInitialPageUrl', () => {
  it('makes startPage and pageSize explicit on the first request', () => {
    expect(getInitialPageUrl('https://a.test/x', { mode: 'page', startPage: 5, pageSizeParam: 'limit', pageSize: 50 }))
      .toBe('https://a.test/x?page=5&limit=50');
    expect(getInitialPageUrl('https://a.test/x', { mode: 'page' })).toBe('https://a.test/x?page=1');
  });

  it('keeps parameters already present in the URL', () => {
    expect(getInitialPageUrl('https://a.test/x?page=3&limit=10', { mode: 'page', startPage: 1, pageSizeParam: 'limit', pageSize: 50 }))
      .toBe('https://a.test/x?page=3&limit=10');
  });

  it('leaves non-page modes untouched', () => {
    expect(getInitialPageUrl('https://a.test/x', undefined)).toBe('https://a.test/x');
    expect(getInitialPageUrl('https://a.test/x', { mode: 'cursor' })).toBe('https://a.test/x');
    expect(getInitialPageUrl('https://a.test/x', { mode: 'next-link' })).toBe('https://a.test/x');
  });
});

describe('offset pagination', () => {
  it('starts at startOffset with the page size and advances by pageSize', () => {
    const config = { mode: 'offset' as const, pageSizeParam: 'limit', pageSize: 50 };
    const first = getInitialPageUrl('https://a.test/items', config);
    expect(first).toBe('https://a.test/items?offset=0&limit=50');
    expect(getNextPageInfo('[]', 'application/json', config, first, 50).nextUrl).toBe('https://a.test/items?offset=50&limit=50');
    expect(getInitialPageUrl('https://a.test/items', { mode: 'offset', startOffset: 200, offsetParam: 'skip' })).toBe('https://a.test/items?skip=200');
  });

  it('stops on an empty page or a short page', () => {
    const config = { mode: 'offset' as const, pageSize: 50 };
    expect(getNextPageInfo('[]', 'application/json', config, 'https://a.test/i?offset=100', 0).nextUrl).toBeNull();
    expect(getNextPageInfo('[]', 'application/json', config, 'https://a.test/i?offset=100', 20).nextUrl).toBeNull();
    expect(getNextPageInfo('[]', 'application/json', config, 'https://a.test/i?offset=100', 50).nextUrl).toBe('https://a.test/i?offset=150');
  });

  it('advances by the item count when no page size is configured', () => {
    expect(getNextPageInfo('[]', 'application/json', { mode: 'offset' }, 'https://a.test/i?offset=10', 7).nextUrl).toBe('https://a.test/i?offset=17');
  });
});

describe('getNextPageInfo with a pre-parsed page', () => {
  it('reads next links from an HTML ParsedPage', () => {
    const page = parsePage('<a rel="next" href="/2">n</a>', 'html');
    expect(getNextPageInfo(page, 'text/html', { mode: 'next-link' }, 'https://a.test/1').nextUrl).toBe('https://a.test/2');
  });

  it('reads next links and cursors from a JSON ParsedPage', () => {
    const page = parsePage(JSON.stringify({ next: '/p2', meta: { cursor: 'abc' } }), 'json');
    expect(getNextPageInfo(page, 'application/json', { mode: 'next-link' }, 'https://a.test/p1').nextUrl).toBe('https://a.test/p2');
    expect(getNextPageInfo(page, 'application/json', { mode: 'cursor', nextCursorPath: 'meta.cursor' }, 'https://a.test/p1'))
      .toEqual({ nextUrl: 'https://a.test/p1?cursor=abc', nextCursor: 'abc' });
  });

  it('does not attempt cursor pagination on an HTML page', () => {
    const page = parsePage('<p>hi</p>', 'html');
    expect(getNextPageInfo(page, 'text/html', { mode: 'cursor' }, 'https://a.test/1').nextUrl).toBeNull();
  });

  it('still accepts a raw body for backwards compatibility', () => {
    expect(getNextPageInfo('<a rel="next" href="/2">n</a>', 'text/html', { mode: 'next-link' }, 'https://a.test/1').nextUrl).toBe('https://a.test/2');
    expect(getNextPageInfo('{"next_cursor":7}', 'application/json', { mode: 'cursor' }, 'https://a.test/1').nextCursor).toBe('7');
  });
});

describe('extractNextLink', () => {
  it('matches rel token lists and is case-insensitive', () => {
    expect(extractNextLink('<a rel="nofollow next" href="/2">n</a>')).toBe('/2');
    expect(extractNextLink('<a rel="Next" href="/3">n</a>')).toBe('/3');
    expect(extractNextLink('<link rel="prefetch next" href="/4">')).toBe('/4');
  });

  it('does not match rel values that merely contain "next"', () => {
    expect(extractNextLink('<a rel="nextdoor" href="/x">n</a>')).toBeNull();
  });
});

describe('extractFromPage', () => {
  it('yields the same items as parsing from a string', () => {
    const body = JSON.stringify({ data: { items: [1, 2] } });
    expect(extractFromPage(parsePage(body, 'json'), { type: 'json', path: 'data.items' })).toEqual([1, 2]);
    expect(extractFromPage(parsePage('<i class="a">x</i><i class="a">y</i>', 'html'), { type: 'html', selector: '.a' })).toEqual(['x', 'y']);
  });
});
