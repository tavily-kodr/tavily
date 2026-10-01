/**
 * Result Ranking Service
 * Scores and ranks search results using multi-factor relevance, freshness, authority, and content quality
 */

import { SearchResult, TimeRange } from '../models/search.types';
import { ScoredResult, RankingFactors } from '../models/ranking.types';
import { tokenize } from '../utils/text.utils';
import { extractDomain } from '../utils/url.utils';

const HIGH_AUTHORITY_DOMAINS = new Set([
  'wikipedia.org',
  'github.com',
  'stackoverflow.com',
  'arxiv.org',
  'nature.com',
  'science.org',
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'nytimes.com',
  'wsj.com',
  'bloomberg.com',
  'techcrunch.com',
  'theverge.com',
  'wired.com',
  'nih.gov',
  'who.int',
  'nasa.gov',
  'mit.edu',
  'stanford.edu',
  'harvard.edu',
  'developer.mozilla.org',
  'microsoft.com',
  'google.com',
  'apple.com',
]);

export class RankingService {
  /**
   * Ranks an array of search results against a query and optional time_range
   */
  rankResults(
    results: SearchResult[],
    query: string,
    options?: { time_range?: TimeRange }
  ): ScoredResult[] {
    if (!results || results.length === 0) return [];

    const queryTokens = tokenize(query, true);
    const rawQueryLower = query.toLowerCase().trim();

    const scored = results.map(result => {
      const factors = this.computeFactors(result, rawQueryLower, queryTokens, options?.time_range);
      return {
        ...result,
        score: factors.finalScore,
        factors,
      };
    });

    // Sort descending by finalScore
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }

  /**
   * Computes individual ranking factors for a single result
   */
  private computeFactors(
    result: SearchResult,
    rawQuery: string,
    queryTokens: string[],
    timeRange?: TimeRange
  ): RankingFactors {
    const titleLower = (result.title || '').toLowerCase();
    const contentLower = (result.content || '').toLowerCase();

    // 1. Title Relevance (0.0 - 1.0)
    let titleRelevance = 0.1;
    if (titleLower.includes(rawQuery)) {
      titleRelevance = 1.0;
    } else if (queryTokens.length > 0) {
      let matchedCount = 0;
      for (const token of queryTokens) {
        if (titleLower.includes(token)) matchedCount++;
      }
      titleRelevance = 0.3 + 0.7 * (matchedCount / queryTokens.length);
    }

    // 2. Content Relevance (0.0 - 1.0)
    let contentRelevance = 0.1;
    if (contentLower.includes(rawQuery)) {
      contentRelevance = 0.95;
    } else if (queryTokens.length > 0) {
      let tokenHits = 0;
      for (const token of queryTokens) {
        // Count occurrences
        const regex = new RegExp(`\\b${token}\\b`, 'gi');
        const matches = contentLower.match(regex);
        if (matches) {
          tokenHits += Math.min(matches.length, 3);
        }
      }
      const maxPossible = queryTokens.length * 3;
      contentRelevance = Math.min(1.0, 0.2 + (tokenHits / maxPossible) * 0.8);
    }

    // Combined query relevance
    const queryRelevance = (titleRelevance * 0.6) + (contentRelevance * 0.4);

    // 3. Source Quality / Domain Authority (0.0 - 1.0)
    const domain = result.domain || extractDomain(result.url);
    let sourceQuality = 0.65; // neutral baseline

    if (domain.endsWith('.edu') || domain.endsWith('.gov') || domain.endsWith('.mil')) {
      sourceQuality = 0.95;
    } else if (domain.endsWith('.org')) {
      sourceQuality = 0.85;
    }

    // Check authority domain registry
    for (const authDomain of HIGH_AUTHORITY_DOMAINS) {
      if (domain === authDomain || domain.endsWith(`.${authDomain}`)) {
        sourceQuality = Math.max(sourceQuality, 0.95);
        break;
      }
    }

    // 4. Freshness Score (0.0 - 1.0)
    let freshness = 0.5; // neutral default when publication date is unavailable
    if (result.published_date) {
      try {
        const pubTime = new Date(result.published_date).getTime();
        const now = Date.now();
        const ageDays = Math.max(0, (now - pubTime) / (1000 * 60 * 60 * 24));

        if (ageDays <= 1) freshness = 1.0;
        else if (ageDays <= 7) freshness = 0.92;
        else if (ageDays <= 30) freshness = 0.80;
        else if (ageDays <= 90) freshness = 0.68;
        else if (ageDays <= 365) freshness = 0.50;
        else freshness = 0.35;

        // If time_range is specified, adjust freshness expectations
        if (timeRange) {
          if (timeRange === 'day' && ageDays <= 1) freshness = 1.0;
          else if (timeRange === 'week' && ageDays <= 7) freshness = 0.95;
          else if (timeRange === 'month' && ageDays <= 30) freshness = 0.90;
          else if (timeRange === 'year' && ageDays <= 365) freshness = 0.85;
          else freshness = Math.max(0.1, freshness - 0.4);
        }
      } catch {
        freshness = 0.5;
      }
    }

    // 5. Content Quality (0.0 - 1.0)
    let contentQuality = 0.5;
    const contentLength = (result.content || '').length;
    if (contentLength > 600) {
      contentQuality = 1.0;
    } else if (contentLength > 250) {
      contentQuality = 0.85;
    } else if (contentLength > 100) {
      contentQuality = 0.70;
    } else if (contentLength > 30) {
      contentQuality = 0.50;
    } else {
      contentQuality = 0.20;
    }

    // Weighted combination
    const rawScore =
      titleRelevance * 0.35 +
      contentRelevance * 0.25 +
      sourceQuality * 0.15 +
      freshness * 0.15 +
      contentQuality * 0.10;

    // Normalize into [0.05, 0.99] range, rounded to 2 decimal places
    const clamped = Math.max(0.05, Math.min(0.99, rawScore));
    const finalScore = Math.round(clamped * 100) / 100;

    return {
      queryRelevance: Math.round(queryRelevance * 100) / 100,
      titleRelevance: Math.round(titleRelevance * 100) / 100,
      contentRelevance: Math.round(contentRelevance * 100) / 100,
      sourceQuality: Math.round(sourceQuality * 100) / 100,
      freshness: Math.round(freshness * 100) / 100,
      contentQuality: Math.round(contentQuality * 100) / 100,
      finalScore,
    };
  }
}
