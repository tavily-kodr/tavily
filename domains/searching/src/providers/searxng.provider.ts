/**
 * SearXNG Search Provider
 */

import { SearchProvider } from './search-provider.interface';
import { SearchOptions, SearchProviderResult } from '../models/search.types';

export class SearxngSearchProvider implements SearchProvider {
  readonly name = 'SearXNG';

  constructor(private readonly baseUrl: string) {}

  async search(query: string, options: SearchOptions): Promise<SearchProviderResult[]> {
    if (!this.baseUrl) {
      throw new Error('SearXNG base URL is not configured');
    }

    const cleanBase = this.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${cleanBase}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');

    if (options.time_range) {
      url.searchParams.set('time_range', options.time_range);
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`SearXNG request failed with status ${response.status}`);
    }

    const data = await response.json();
    const items = data.results || [];

    const results: SearchProviderResult[] = items.map((item: any) => ({
      title: item.title || item.url,
      url: item.url,
      snippet: item.content || '',
      content: item.content || '',
      published_date: item.publishedDate || null,
      source: 'SearXNG',
    }));

    return results;
  }
}
