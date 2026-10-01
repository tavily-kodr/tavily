/**
 * Composite Fallback Search Provider
 * Attempts primary provider and automatically falls back to secondary provider on error or empty results
 */

import { SearchProvider } from './search-provider.interface';
import { SearchOptions, SearchProviderResult } from '../models/search.types';

export class CompositeSearchProvider implements SearchProvider {
  readonly name: string;

  constructor(private readonly providers: SearchProvider[]) {
    if (!providers || providers.length === 0) {
      throw new Error('CompositeSearchProvider requires at least one provider');
    }
    this.name = `Composite(${providers.map(p => p.name).join(' -> ')})`;
  }

  async search(query: string, options: SearchOptions): Promise<SearchProviderResult[]> {
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      try {
        const results = await provider.search(query, options);
        if (results && results.length > 0) {
          return results;
        }
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Fallback to next provider
      }
    }

    if (lastError) {
      throw lastError;
    }

    return [];
  }
}
