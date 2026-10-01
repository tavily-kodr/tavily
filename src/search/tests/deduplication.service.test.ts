import { DeduplicationService } from '../services/deduplication.service';
import { normalizeUrl } from '../utils/url.utils';
import { SearchResult } from '../models/search.types';

export async function testDeduplicationService() {
  console.log('--- Testing DeduplicationService ---');
  const service = new DeduplicationService();

  // 1. URL Normalization
  const url1 = 'https://example.com/article?utm_source=twitter&utm_medium=social';
  const url2 = 'https://example.com/article/';
  const url3 = 'http://example.com/article#comments';

  const norm1 = normalizeUrl(url1);
  const norm2 = normalizeUrl(url2);

  if (norm1 !== 'https://example.com/article') {
    throw new Error(`Expected https://example.com/article but got ${norm1}`);
  }
  if (norm2 !== 'https://example.com/article') {
    throw new Error(`Expected https://example.com/article but got ${norm2}`);
  }
  console.log('✓ URL normalization strips tracking params and trailing slash');

  // 2. Duplicate Provider Results
  const providerItems = [
    { title: 'Doc A', url: 'https://example.com/doc', snippet: 'Intro' },
    { title: 'Doc A Duplicate', url: 'https://example.com/doc?utm_campaign=launch', snippet: 'Intro' },
    { title: 'Doc B', url: 'https://example.com/other', snippet: 'Other' },
  ];
  const uniqueProviders = service.deduplicateProviderResults(providerItems);
  if (uniqueProviders.length !== 2) {
    throw new Error(`Expected 2 unique provider results, got ${uniqueProviders.length}`);
  }
  console.log('✓ Provider results deduplication successfully removed duplicate URL with tracking params');

  // 3. Content Similarity Deduplication
  const results: SearchResult[] = [
    {
      title: 'Breaking Tech News',
      url: 'https://news-syndicate-a.com/article-1',
      content: 'Artificial intelligence is rapidly advancing in medical diagnostics and robotics with revolutionary discoveries.',
      domain: 'news-syndicate-a.com',
      score: 0.9,
      published_date: '2026-09-01T00:00:00Z',
      source: 'web',
    },
    {
      title: 'Breaking Tech News Re-published',
      url: 'https://news-syndicate-b.com/syndicated-story',
      content: 'Artificial intelligence is rapidly advancing in medical diagnostics and robotics with revolutionary discoveries.',
      domain: 'news-syndicate-b.com',
      score: 0.85,
      published_date: '2026-09-01T00:00:00Z',
      source: 'web',
    },
    {
      title: 'Completely Different Story',
      url: 'https://gardening.com/roses',
      content: 'Tips for planting roses in autumn including pruning and organic fertilizing methods.',
      domain: 'gardening.com',
      score: 0.5,
      published_date: '2026-08-15T00:00:00Z',
      source: 'web',
    },
  ];

  const dedupedResults = service.deduplicateResults(results, 0.7);
  if (dedupedResults.length !== 2) {
    throw new Error(`Expected 2 deduplicated results due to identical syndicated content, got ${dedupedResults.length}`);
  }
  if (dedupedResults[0].url !== 'https://news-syndicate-a.com/article-1') {
    throw new Error('Expected first article to be retained');
  }
  console.log('✓ Content similarity deduplication removed syndicated near-identical article');
}
