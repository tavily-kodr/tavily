import { describe, expect, it } from 'vitest';
import { extractHtml } from '../src/index.js';
import { Frontier, LINK_RULE, extractLinks, hrefsFromItems, isLikelyAsset, isSameOrigin, normalizeUrl } from '../scripts/site-crawl.js';
import { median, percentile, summarize } from '../scripts/stats.js';

const page = 'https://shop.test/catalog/index.html';

describe('normalizeUrl', () => {
  it('resolves relative links against the page URL', () => {
    expect(normalizeUrl('item.html', page)).toBe('https://shop.test/catalog/item.html');
    expect(normalizeUrl('../about', page)).toBe('https://shop.test/about');
    expect(normalizeUrl('/a/./b/../c', page)).toBe('https://shop.test/a/c');
    expect(normalizeUrl('//shop.test/x', page)).toBe('https://shop.test/x');
  });

  it('removes fragments and canonicalises host and default port', () => {
    expect(normalizeUrl('/x#reviews', page)).toBe('https://shop.test/x');
    expect(normalizeUrl('HTTPS://SHOP.TEST:443/Path?q=1#top', page)).toBe('https://shop.test/Path?q=1');
  });

  it('keeps trailing slashes and query strings as distinct resources', () => {
    expect(normalizeUrl('/a/', page)).toBe('https://shop.test/a/');
    expect(normalizeUrl('/a', page)).toBe('https://shop.test/a');
    expect(normalizeUrl('/a?b=2&a=1', page)).toBe('https://shop.test/a?b=2&a=1');
  });

  it('ignores mailto, tel, javascript, other schemes, fragments and garbage', () => {
    for (const href of ['mailto:a@b.test', 'tel:+911234', 'javascript:void(0)', ' JavaScript:alert(1)', 'data:text/html,x', 'ftp://shop.test/f', '#top', '#', '', '   ', 'http://[bad']) {
      expect(normalizeUrl(href, page), href).toBeNull();
    }
  });
});

describe('isSameOrigin', () => {
  it('requires identical scheme, host and port', () => {
    expect(isSameOrigin('https://shop.test/a', 'https://shop.test')).toBe(true);
    expect(isSameOrigin('http://shop.test/a', 'https://shop.test')).toBe(false);
    expect(isSameOrigin('https://www.shop.test/a', 'https://shop.test')).toBe(false);
    expect(isSameOrigin('https://shop.test:8443/a', 'https://shop.test')).toBe(false);
    expect(isSameOrigin('https://evil.test/?u=https://shop.test', 'https://shop.test')).toBe(false);
    expect(isSameOrigin('not a url', 'https://shop.test')).toBe(false);
  });
});

describe('extractLinks', () => {
  it('keeps only crawlable same-origin pages, deduplicated in first-seen order', () => {
    const hrefs = [
      'b.html', '/catalog/b.html#top', 'https://shop.test/catalog/b.html', // same page three ways
      'a.html',
      'https://other.test/x', '//cdn.test/lib.js', // external
      'mailto:x@shop.test', 'tel:1', 'javascript:void(0)', '#reviews', // ignored schemes / fragments
      '/img/cover.JPG', '/static/site.css', '/docs/manual.pdf', // assets
    ];
    expect(extractLinks(hrefs, page, 'https://shop.test')).toEqual([
      'https://shop.test/catalog/b.html',
      'https://shop.test/catalog/a.html',
    ]);
  });

  it('works end to end with the scraper extraction rule', () => {
    const html = `<html><body>
      <a href="/one">1</a><a href="two?x=1#f">2</a><a>no href</a>
      <a href="https://elsewhere.test/">ext</a><a href="mailto:a@b">m</a>
      <nav><a href="/one">dup</a></nav></body></html>`;
    const items = extractHtml(html, LINK_RULE).map((data) => ({ data }));
    expect(hrefsFromItems(items)).toEqual(['/one', 'two?x=1#f', 'https://elsewhere.test/', 'mailto:a@b', '/one']);
    expect(extractLinks(hrefsFromItems(items), page, 'https://shop.test')).toEqual([
      'https://shop.test/one',
      'https://shop.test/catalog/two?x=1',
    ]);
  });

  it('detects common asset extensions only in the path', () => {
    expect(isLikelyAsset('https://shop.test/a.png')).toBe(true);
    expect(isLikelyAsset('https://shop.test/page?file=a.png')).toBe(false);
    expect(isLikelyAsset('https://shop.test/catalog/')).toBe(false);
  });
});

describe('Frontier', () => {
  it('deduplicates across pages and hands URLs out breadth-first', () => {
    const f = new Frontier();
    expect(f.add('https://shop.test/')).toBe(true);
    expect(f.add('https://shop.test/a')).toBe(true);
    expect(f.add('https://shop.test/')).toBe(false);
    expect(f.next()).toBe('https://shop.test/');
    expect(f.add('https://shop.test/')).toBe(false); // already crawled, still deduplicated
    expect(f.add('https://shop.test/b')).toBe(true);
    expect([f.next(), f.next(), f.next()]).toEqual(['https://shop.test/a', 'https://shop.test/b', undefined]);
    expect(f.discovered).toBe(3);
    expect(f.queued).toBe(0);
  });
});

describe('stats helpers', () => {
  it('computes median and nearest-rank percentiles', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 0.9)).toBe(18);
    expect(percentile(values, 0.95)).toBe(19);
    expect(summarize(values)).toEqual({ min: 1, median: 10.5, p90: 18, p95: 19, max: 20 });
    expect(summarize([])).toEqual({ min: 0, median: 0, p90: 0, p95: 0, max: 0 });
  });
});
