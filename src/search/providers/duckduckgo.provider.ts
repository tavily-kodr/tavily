/**
 * DuckDuckGo Search Provider
 * Live, real web search provider requiring no API key.
 */

import * as cheerio from 'cheerio';
import { SearchProvider } from './search-provider.interface';
import { SearchOptions, SearchProviderResult } from '../models/search.types';
import { isValidHttpUrl } from '../utils/url.utils';

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = 'DuckDuckGo';

  async search(query: string, options: SearchOptions): Promise<SearchProviderResult[]> {
    const maxResults = options.max_results || 10;
    
    // Construct search query with domain modifiers if appropriate
    let effectiveQuery = query;
    if (options.include_domains && options.include_domains.length > 0) {
      const siteFilters = options.include_domains.map(d => `site:${d}`).join(' OR ');
      effectiveQuery = `${effectiveQuery} (${siteFilters})`;
    }
    if (options.exclude_domains && options.exclude_domains.length > 0) {
      const excludeFilters = options.exclude_domains.map(d => `-site:${d}`).join(' ');
      effectiveQuery = `${effectiveQuery} ${excludeFilters}`;
    }

    // Map time_range to DuckDuckGo df parameter
    let dfParam = '';
    if (options.time_range) {
      switch (options.time_range) {
        case 'day': dfParam = 'd'; break;
        case 'week': dfParam = 'w'; break;
        case 'month': dfParam = 'm'; break;
        case 'year': dfParam = 'y'; break;
      }
    }

    try {
      const results = await this.fetchHtmlSearch(effectiveQuery, dfParam, maxResults);
      if (results.length > 0) {
        return results.slice(0, maxResults);
      }
    } catch {
      // Fallback to Lite search if HTML endpoint fails
    }

    try {
      const liteResults = await this.fetchLiteSearch(effectiveQuery, maxResults);
      return liteResults.slice(0, maxResults);
    } catch {
      return [];
    }
  }

  /**
   * Fetches results from DuckDuckGo HTML endpoint
   */
  private async fetchHtmlSearch(
    query: string,
    df: string,
    maxResults: number
  ): Promise<SearchProviderResult[]> {
    const params = new URLSearchParams({
      q: query,
      b: '',
      kl: 'us-en',
    });
    if (df) {
      params.append('df', df);
    }

    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://html.duckduckgo.com/',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo HTML search failed with status ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: SearchProviderResult[] = [];

    $('.result').each((_, elem) => {
      if (results.length >= maxResults * 2) return;

      const titleElem = $(elem).find('.result__title a.result__a');
      const snippetElem = $(elem).find('.result__snippet');

      if (!titleElem.length) return;

      const rawUrl = titleElem.attr('href') || '';
      const title = titleElem.text().trim();
      const snippet = snippetElem.text().trim();

      const decodedUrl = this.decodeDuckDuckGoUrl(rawUrl);

      if (decodedUrl && isValidHttpUrl(decodedUrl) && !decodedUrl.includes('duckduckgo.com')) {
        results.push({
          title: title || decodedUrl,
          url: decodedUrl,
          snippet: snippet || '',
          source: 'DuckDuckGo',
        });
      }
    });

    return results;
  }

  /**
   * Fallback: fetches results from DuckDuckGo Lite endpoint
   */
  private async fetchLiteSearch(
    query: string,
    maxResults: number
  ): Promise<SearchProviderResult[]> {
    const params = new URLSearchParams({ q: query, kl: 'us-en' });
    const response = await fetch(`https://lite.duckduckgo.com/lite/?${params.toString()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo Lite failed with status ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: SearchProviderResult[] = [];

    $('tr').each((_, row) => {
      const linkElem = $(row).find('a.result-link');
      if (linkElem.length > 0) {
        const title = linkElem.text().trim();
        const rawUrl = linkElem.attr('href') || '';
        const decodedUrl = this.decodeDuckDuckGoUrl(rawUrl);

        // Next row often contains snippet
        const nextSnippet = $(row).next().find('.result-snippet').text().trim();

        if (decodedUrl && isValidHttpUrl(decodedUrl) && !decodedUrl.includes('duckduckgo.com')) {
          results.push({
            title: title || decodedUrl,
            url: decodedUrl,
            snippet: nextSnippet || '',
            source: 'DuckDuckGo',
          });
        }
      }
    });

    return results;
  }

  /**
   * Decodes DuckDuckGo redirect wrapper URL to actual target URL
   */
  private decodeDuckDuckGoUrl(rawUrl: string): string {
    if (!rawUrl) return '';

    try {
      if (rawUrl.startsWith('//')) {
        rawUrl = `https:${rawUrl}`;
      }

      if (rawUrl.includes('/l/?uddg=')) {
        const parsed = new URL(rawUrl, 'https://duckduckgo.com');
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) {
          return decodeURIComponent(uddg);
        }
      }

      return rawUrl;
    } catch {
      return rawUrl;
    }
  }
}
