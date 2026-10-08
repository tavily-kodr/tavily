/**
 * Search Provider Interface
 */

import { SearchOptions, SearchProviderResult } from '../models/search.types';

export interface SearchProvider {
  readonly name: string;
  search(query: string, options: SearchOptions): Promise<SearchProviderResult[]>;
}
