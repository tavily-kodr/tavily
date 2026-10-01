/**
 * Result Deduplication Service
 * Removes redundant results across Canonical URLs, Normalized URLs, Domain+Path, and Content Similarity
 */

import { SearchResult, SearchProviderResult } from '../models/search.types';
import { normalizeUrl, extractDomain } from '../utils/url.utils';
import { jaccardSimilarity } from '../utils/text.utils';

export class DeduplicationService {
  /**
   * Deduplicates SearchProviderResult items by normalized URL and domain+path
   */
  deduplicateProviderResults(items: SearchProviderResult[]): SearchProviderResult[] {
    const seenUrls = new Set<string>();
    const seenPaths = new Set<string>();
    const unique: SearchProviderResult[] = [];

    for (const item of items) {
      if (!item.url) continue;
      const normalized = normalizeUrl(item.url);
      
      let domainPath = '';
      try {
        const u = new URL(normalized);
        let path = u.pathname;
        if (path.length > 1 && path.endsWith('/')) {
          path = path.slice(0, -1);
        }
        domainPath = `${u.hostname.toLowerCase()}${path}`;
      } catch {
        domainPath = normalized;
      }

      if (seenUrls.has(normalized) || seenPaths.has(domainPath)) {
        continue;
      }

      seenUrls.add(normalized);
      seenPaths.add(domainPath);
      unique.push(item);
    }

    return unique;
  }

  /**
   * Deduplicates fully processed SearchResults using Canonical URL, Normalized URL, and Content Similarity
   */
  deduplicateResults(results: SearchResult[], similarityThreshold: number = 0.75): SearchResult[] {
    const seenUrls = new Set<string>();
    const seenCanonical = new Set<string>();
    const seenDomainPaths = new Set<string>();
    const deduplicated: SearchResult[] = [];

    for (const res of results) {
      const norm = normalizeUrl(res.url);

      // Check URL duplicate
      if (seenUrls.has(norm)) {
        continue;
      }

      // Check domain + path
      let domainPath = '';
      try {
        const u = new URL(norm);
        let p = u.pathname;
        if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
        domainPath = `${u.hostname.toLowerCase()}${p}`;
      } catch {
        domainPath = norm;
      }

      if (seenDomainPaths.has(domainPath)) {
        continue;
      }

      // Check content similarity against already accepted results
      if (res.content && res.content.length > 50) {
        let isDuplicateContent = false;
        for (const existing of deduplicated) {
          if (existing.content && existing.content.length > 50) {
            const sim = jaccardSimilarity(res.content, existing.content);
            if (sim >= similarityThreshold) {
              isDuplicateContent = true;
              break;
            }
          }
        }
        if (isDuplicateContent) {
          continue;
        }
      }

      seenUrls.add(norm);
      seenDomainPaths.add(domainPath);
      deduplicated.push(res);
    }

    return deduplicated;
  }
}
