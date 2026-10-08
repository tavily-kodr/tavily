/**
 * Factory for creating configured SearchProvider instances
 */

import { SearchProvider } from './search-provider.interface';
import { DuckDuckGoProvider } from './duckduckgo.provider';
import { TavilySearchProvider } from './tavily.provider';
import { BraveSearchProvider } from './brave.provider';
import { SearxngSearchProvider } from './searxng.provider';
import { CompositeSearchProvider } from './composite.provider';

export function createSearchProvider(): SearchProvider {
  const ddg = new DuckDuckGoProvider();
  const providerList: SearchProvider[] = [];

  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  if (tavilyKey) {
    providerList.push(new TavilySearchProvider(tavilyKey));
  }

  const braveKey = process.env.BRAVE_API_KEY?.trim();
  if (braveKey) {
    providerList.push(new BraveSearchProvider(braveKey));
  }

  const searxUrl = process.env.SEARXNG_URL?.trim();
  if (searxUrl) {
    providerList.push(new SearxngSearchProvider(searxUrl));
  }

  // Always append DuckDuckGo as reliable zero-config provider/fallback
  providerList.push(ddg);

  if (providerList.length === 1) {
    return providerList[0];
  }

  return new CompositeSearchProvider(providerList);
}
