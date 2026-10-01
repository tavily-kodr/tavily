/**
 * Tavily Search Engine & Web Intelligence Module
 * Public Exports
 */

// Models & Types
export * from './models/search.types';
export * from './models/scraper.types';
export * from './models/ranking.types';
export * from './models/trigger.types';

// Providers
export * from './providers/search-provider.interface';
export * from './providers/duckduckgo.provider';
export * from './providers/tavily.provider';
export * from './providers/brave.provider';
export * from './providers/searxng.provider';
export * from './providers/composite.provider';
export * from './providers/provider-factory';

// Services
export * from './services/search.service';
export * from './services/scraper.service';
export * from './services/extraction.service';
export * from './services/deduplication.service';
export * from './services/ranking.service';
export * from './services/answer.service';
export * from './services/cache.service';
export * from './services/trigger.service';
export * from './services/event-bus.service';

// Utilities
export * from './utils/url.utils';
export * from './utils/text.utils';
export * from './utils/robots.utils';
export * from './utils/concurrency.utils';

// Default Singleton Instance for fast integration
import { SearchService } from './services/search.service';
export const defaultSearchService = new SearchService();
export async function search(query: string, options?: any) {
  return defaultSearchService.search(query, options);
}
