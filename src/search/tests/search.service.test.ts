import { SearchService } from '../services/search.service';
import { SearchProvider } from '../providers/search-provider.interface';
import { SearchOptions, SearchProviderResult } from '../models/search.types';

class MockSearchProvider implements SearchProvider {
  readonly name = 'MockSearchProvider';

  async search(query: string, options: SearchOptions): Promise<SearchProviderResult[]> {
    if (query.includes('fail-provider')) {
      throw new Error('Upstream provider rate limited or unreachable');
    }

    return [
      {
        title: 'Machine Learning Developments in 2026',
        url: 'https://arxiv.org/abs/2601.12345',
        snippet: 'Recent breakthroughs in transformer architectures and neural efficiency.',
      },
      {
        title: 'Nature Machine Intelligence Report',
        url: 'https://nature.com/articles/nm-2026',
        snippet: 'Peer reviewed comprehensive survey of autonomous agents.',
      },
      {
        title: 'Random Excluded Site',
        url: 'https://spam-site.com/seo-article',
        snippet: 'Low quality duplicated content.',
      },
    ];
  }
}

export async function testSearchService() {
  console.log('--- Testing SearchService ---');

  const mockProvider = new MockSearchProvider();
  const searchService = new SearchService({ provider: mockProvider });

  // 1. Empty Query validation
  let caughtEmpty = false;
  try {
    await searchService.search('   ');
  } catch (err: any) {
    caughtEmpty = true;
  }
  if (!caughtEmpty) {
    throw new Error('Search did not reject empty query');
  }
  console.log('✓ Rejected empty query with proper validation error');

  // 2. Basic Search execution
  const res = await searchService.search('machine learning breakthroughs', {
    search_depth: 'basic',
    max_results: 5,
  });

  if (!res || !Array.isArray(res.results)) {
    throw new Error('Invalid search response structure');
  }
  if (res.results.length === 0) {
    throw new Error('Expected results, got 0');
  }
  if (typeof res.response_time !== 'number') {
    throw new Error('Response time metric missing');
  }
  console.log('✓ Basic search returned structured results in', res.response_time, 's');

  // 3. Domain Filtering (exclude_domains)
  const filteredRes = await searchService.search('machine learning', {
    exclude_domains: ['spam-site.com'],
  });
  const hasSpam = filteredRes.results.some(r => r.url.includes('spam-site.com'));
  if (hasSpam) {
    throw new Error('Domain exclusion filter failed to remove spam-site.com');
  }
  console.log('✓ Exclude domain filter successfully omitted spam-site.com');

  // 4. Domain Filtering (include_domains)
  const includeRes = await searchService.search('machine learning', {
    include_domains: ['arxiv.org'],
  });
  for (const r of includeRes.results) {
    if (!r.url.includes('arxiv.org')) {
      throw new Error(`Expected only arxiv.org results, got ${r.url}`);
    }
  }
  console.log('✓ Include domain filter successfully restricted results to arxiv.org');

  // 5. Advanced Search Depth
  const advancedRes = await searchService.search('machine learning breakthroughs', {
    search_depth: 'advanced',
  });
  if (advancedRes.search_depth !== 'advanced') {
    throw new Error(`Expected advanced search depth, got ${advancedRes.search_depth}`);
  }
  console.log('✓ Advanced search depth executed successfully');

  // 6. Graceful failure on provider error
  const failRes = await searchService.search('fail-provider-query');
  if (failRes.status !== 'error') {
    throw new Error('Expected status: error on provider failure');
  }
  console.log('✓ Provider failure handled gracefully without crashing');
}
