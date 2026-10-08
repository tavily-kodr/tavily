import { DeduplicationService } from '../services/deduplication.service';
import { normalizeUrl } from '../utils/url.utils';
import { SearchProviderResult, SearchResult } from '../models/search.types';

export async function testDeduplicationService() {
  console.log('--- Testing DeduplicationService ---');
  const dedup = new DeduplicationService();

  // Test 1: URL Normalization
  const rawUrl = 'https://www.example.com/blog/article/?utm_source=twitter&utm_medium=social#heading';
  const expected = 'https://example.com/blog/article';
  const normalized = normalizeUrl(rawUrl);
  if (normalized !== expected) {
    throw new Error(`Normalization failed. Expected ${expected}, got ${normalized}`);
  }
  console.log('✓ URL normalization strips tracking params and trailing slash');

  // Test 2: Provider results deduplication
  const providerItems: SearchProviderResult[] = [
    { title: 'Doc A', url: 'https://example.com/page1', snippet: 'Content A' },
    { title: 'Doc A Duplicate', url: 'https://example.com/page1?utm_medium=email', snippet: 'Content A duplicate' },
    { title: 'Doc B', url: 'https://example.com/page2/', snippet: 'Content B' },
  ];
  const uniqueProviders = dedup.deduplicateProviderResults(providerItems);
  if (uniqueProviders.length !== 2) {
    throw new Error(`Expected 2 unique provider results, got ${uniqueProviders.length}`);
  }
  console.log('✓ Provider results deduplication successfully removed duplicate URL with tracking params');

  // Test 3: Content similarity deduplication
  const results: SearchResult[] = [
    {
      title: 'Original Article',
      url: 'https://news.com/tech/original',
      content: 'Antigravity AI announced a state of the art search intelligence engine with multi-factor ranking and real-time triggers for web events.',
      domain: 'news.com',
      score: 0.9,
      published_date: '2026-10-01',
      source: 'web',
    },
    {
      title: 'Syndicated Mirror',
      url: 'https://mirror.com/tech/syndicated',
      content: 'Antigravity AI announced a state of the art search intelligence engine with multi-factor ranking and real-time triggers for web events.',
      domain: 'mirror.com',
      score: 0.85,
      published_date: '2026-10-01',
      source: 'web',
    },
    {
      title: 'Completely Different Article',
      url: 'https://space.com/quantum',
      content: 'Astronomers discovered a new planetary system around Proxima Centauri with potential biosignatures.',
      domain: 'space.com',
      score: 0.7,
      published_date: '2026-10-02',
      source: 'web',
    },
  ];

  const uniqueArticles = dedup.deduplicateResults(results);
  if (uniqueArticles.length !== 2) {
    throw new Error(`Expected 2 unique articles after similarity deduplication, got ${uniqueArticles.length}`);
  }
  console.log('✓ Content similarity deduplication removed syndicated near-identical article');
}
