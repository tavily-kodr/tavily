import { describe, expect, it } from 'vitest';
import { UniversalScraper, type PageEvent } from '../src/index.js';

/**
 * Offline regression test for the AJAX JSON pattern in scripts/test-ajax-json.ts:
 * one `?ajax=true&year=N` endpoint per year, each answering a bare JSON array
 * of films, extracted with `{ type: 'json' }` and no path. Fetch is stubbed, so
 * no network is used.
 */

interface Film {
  title: string;
  year: number;
  awards: number;
  nominations: number;
  best_picture?: boolean;
}

const EXPECTED_COUNTS: Record<number, number> = { 2010: 13, 2011: 15, 2012: 15, 2013: 12, 2014: 16, 2015: 16 };
const years = Object.keys(EXPECTED_COUNTS).map(Number);
const endpoint = (year: number): string => `https://www.scrapethissite.com/pages/ajax-javascript/?ajax=true&year=${year}`;

/** Same shape as the live endpoint: only the year's best-picture film carries `best_picture`. */
function filmsFor(year: number): Film[] {
  return Array.from({ length: EXPECTED_COUNTS[year] ?? 0 }, (_, i) => ({
    title: `Film ${year}-${i + 1}`,
    year,
    awards: (i % 4) + 1,
    nominations: (i % 7) + 2,
    ...(i === 0 ? { best_picture: true } : {}),
  }));
}

function ajaxFetch() {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    requested.push(url.toString());
    const year = Number(url.searchParams.get('year'));
    if (url.searchParams.get('ajax') !== 'true' || !(year in EXPECTED_COUNTS)) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    }
    return new Response(JSON.stringify(filmsFor(year)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requested, fetchImpl };
}

describe('AJAX JSON year endpoints (scripts/test-ajax-json.ts pattern)', () => {
  it('extracts every film from all six year endpoints without failures', async () => {
    const { requested, fetchImpl } = ajaxFetch();
    const events: PageEvent[] = [];
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const targets = years.map((year) => ({ url: endpoint(year), extraction: { type: 'json' as const } }));

    const result = await scraper.scrape<Film>(targets, { concurrency: 4, onPage: (e) => { events.push(e); } });

    // Every endpoint fetched exactly once, nothing else.
    expect([...requested].sort()).toEqual(years.map(endpoint).sort());

    // Totals and per-page success.
    expect(result.items).toHaveLength(87);
    expect(result.stats).toMatchObject({ targets: 6, pages: 6, items: 87, failedPages: 0, invalidItems: 0, truncated: false, failures: [] });
    expect(events).toHaveLength(6);
    for (const e of events) {
      expect(e.status).toBe(200);
      expect(e.contentType).toBe('application/json');
      expect(e.itemCount).toBe(EXPECTED_COUNTS[Number(new URL(e.pageUrl).searchParams.get('year'))]);
    }

    // Per-year counts, and each page's items keep the source JSON array exactly (order, fields, types).
    for (const year of years) {
      const items = result.items.filter((item) => item.sourceUrl === endpoint(year));
      expect(items.filter((item) => item.data.year === year)).toHaveLength(EXPECTED_COUNTS[year] ?? -1);
      expect(items.map((item) => item.data)).toEqual(filmsFor(year));
      expect(items.map((item) => item.index)).toEqual(items.map((_, i) => i));
      for (const item of items) {
        expect(item.pageUrl).toBe(endpoint(year));
        expect(item.contentType).toBe('application/json');
      }
    }

    // Structure: only the known keys, with JSON types preserved, and `best_picture` once per year.
    for (const { data } of result.items) {
      expect(Object.keys(data).filter((k) => !['title', 'year', 'awards', 'nominations', 'best_picture'].includes(k))).toEqual([]);
      expect(data).toEqual(expect.objectContaining({
        title: expect.any(String), year: expect.any(Number), awards: expect.any(Number), nominations: expect.any(Number),
      }));
      if ('best_picture' in data) expect(data.best_picture).toBe(true);
    }
    expect(result.items.filter((item) => item.data.best_picture === true)).toHaveLength(6);
  });
});
