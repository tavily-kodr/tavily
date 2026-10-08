/**
 * Tavily API Search Provider
 */

import { SearchProvider } from './search-provider.interface';
import { SearchOptions, SearchProviderResult } from '../models/search.types';

export class TavilySearchProvider implements SearchProvider {
  readonly name = 'Tavily';

  constructor(private readonly apiKey: string) {}

  async search(query: string, options: SearchOptions): Promise<SearchProviderResult[]> {
    if (!this.apiKey) {
      throw new Error('Tavily API key is not configured');
    }

    const payload = {
      api_key: this.apiKey,
      query,
      search_depth: options.search_depth || 'basic',
      max_results: options.max_results || 10,
      include_domains: options.include_domains || [],
      exclude_domains: options.exclude_domains || [],
      include_answer: false,
      include_raw_content: false,
    };

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Tavily API request failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const results: SearchProviderResult[] = (data.results || []).map((r: any) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.content || '',
      content: r.content || '',
      published_date: r.published_date || null,
      source: 'Tavily',
    }));

    return results;
  }
}
