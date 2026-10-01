/**
 * Brave Web Search API Provider
 */

import { SearchProvider } from './search-provider.interface';
import { SearchOptions, SearchProviderResult } from '../models/search.types';

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'Brave';

  constructor(private readonly apiKey: string) {}

  async search(query: string, options: SearchOptions): Promise<SearchProviderResult[]> {
    if (!this.apiKey) {
      throw new Error('Brave API key is not configured');
    }

    const count = Math.min(options.max_results || 10, 20);
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', count.toString());

    if (options.time_range) {
      // Brave freshness: pd (past day), pw (past week), pm (past month), py (past year)
      const freshnessMap: Record<string, string> = {
        day: 'pd',
        week: 'pw',
        month: 'pm',
        year: 'py',
      };
      if (freshnessMap[options.time_range]) {
        url.searchParams.set('freshness', freshnessMap[options.time_range]);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.apiKey,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Brave Search API failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const webResults = data.web?.results || [];

    const results: SearchProviderResult[] = webResults.map((item: any) => ({
      title: item.title || item.url,
      url: item.url,
      snippet: item.description || '',
      published_date: item.page_age || item.family_friendly ? null : null,
      source: 'Brave',
    }));

    return results;
  }
}
