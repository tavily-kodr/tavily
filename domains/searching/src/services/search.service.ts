/**
 * Core Search Service
 * Coordinates query processing, search providers, deduplication, ranking, and answer synthesis
 */

import { logger } from '@tavily/logger';
import { AppError } from '@tavily/errors';
import {
  SearchOptions,
  SearchResponse,
  SearchResult,
  FailedSource,
  SearchProviderResult,
} from '../models/search.types';
import { SearchProvider } from '../providers/search-provider.interface';
import { createSearchProvider } from '../providers/provider-factory';
import { DeduplicationService } from './deduplication.service';
import { RankingService } from './ranking.service';
import { AnswerService } from './answer.service';
import { CacheService } from './cache.service';
import { normalizeQuery, tokenize } from '../utils/text.utils';
import { matchesDomainFilter, extractDomain } from '../utils/url.utils';

export class SearchService {
  private readonly provider: SearchProvider;
  private readonly deduplicationService: DeduplicationService;
  private readonly rankingService: RankingService;
  private readonly answerService: AnswerService;
  private readonly cacheService: CacheService;

  private readonly maxResultsLimit: number;

  constructor(dependencies?: {
    provider?: SearchProvider;
    deduplicationService?: DeduplicationService;
    rankingService?: RankingService;
    answerService?: AnswerService;
    cacheService?: CacheService;
  }) {
    this.provider = dependencies?.provider || createSearchProvider();
    this.deduplicationService = dependencies?.deduplicationService || new DeduplicationService();
    this.rankingService = dependencies?.rankingService || new RankingService();
    this.answerService = dependencies?.answerService || new AnswerService();
    this.cacheService = dependencies?.cacheService || new CacheService();

    this.maxResultsLimit = parseInt(process.env.MAX_RESULTS_LIMIT || '20', 10);
  }

  /**
   * Primary search method executing the complete search pipeline
   */
  async search(query: string, options: Partial<SearchOptions> = {}): Promise<SearchResponse> {
    const startTime = performance.now();

    // 1. Query Validation & Normalization
    const rawQuery = (query || options.query || '').trim();
    if (!rawQuery) {
      throw new AppError('Query parameter is required and cannot be empty.', {
        code: 'INVALID_QUERY',
        statusCode: 400,
      });
    }

    const normalizedQ = normalizeQuery(rawQuery);
    if (normalizedQ.length < 2) {
      throw new AppError('Query is too short. Please provide a more specific search term.', {
        code: 'QUERY_TOO_SHORT',
        statusCode: 400,
      });
    }

    const searchDepth = options.search_depth === 'advanced' ? 'advanced' : 'basic';
    const requestedMax = options.max_results || 10;
    const maxResults = Math.min(Math.max(1, requestedMax), this.maxResultsLimit);

    const fullOptions: SearchOptions = {
      query: normalizedQ,
      search_depth: searchDepth,
      max_results: maxResults,
      include_domains: options.include_domains || [],
      exclude_domains: options.exclude_domains || [],
      include_answer: options.include_answer ?? true,
      include_raw_content: options.include_raw_content ?? false,
      time_range: options.time_range,
      topic: options.topic || 'general',
      skip_cache: options.skip_cache ?? false,
    };

    logger.info('Executing search request', {
      query: fullOptions.query,
      searchDepth: fullOptions.search_depth,
      maxResults: fullOptions.max_results,
    });

    // 2. Cache Lookup
    const cacheKey = this.cacheService.createKey(fullOptions);
    if (!fullOptions.skip_cache) {
      const cachedResponse = this.cacheService.get(cacheKey);
      if (cachedResponse) {
        logger.debug('Cache hit for query', { query: fullOptions.query });
        return {
          ...cachedResponse,
          cached: true,
          response_time: Math.round(((performance.now() - startTime) / 1000) * 100) / 100,
        };
      }
    }

    // 3. Search Provider Execution with Depth Strategy
    let providerResults: SearchProviderResult[] = [];
    try {
      if (searchDepth === 'advanced') {
        providerResults = await this.executeAdvancedRetrieval(fullOptions);
      } else {
        providerResults = await this.provider.search(fullOptions.query, fullOptions);
      }
    } catch (err: any) {
      logger.error('Search provider error', { error: err.message, query: fullOptions.query });
      return {
        query: fullOptions.query,
        results: [],
        response_time: Math.round(((performance.now() - startTime) / 1000) * 100) / 100,
        status: 'error',
        failed_sources: [{ url: 'provider', reason: err.message || 'Search provider failure' }],
        search_depth: searchDepth,
        total_found: 0,
      };
    }

    // 4. Domain Filtering
    const domainFiltered = providerResults.filter(item =>
      matchesDomainFilter(item.url, fullOptions.include_domains, fullOptions.exclude_domains)
    );

    // 5. Initial Deduplication of Provider Results
    const uniqueCandidates = this.deduplicationService.deduplicateProviderResults(domainFiltered);

    // 6. Map Provider Results into SearchResult objects
    const candidateResults: SearchResult[] = uniqueCandidates.map(candidate => ({
      title: candidate.title,
      url: candidate.url,
      content: candidate.content || candidate.snippet || '',
      domain: extractDomain(candidate.url),
      score: 0,
      published_date: candidate.published_date || null,
      source: candidate.source || 'web',
      raw_content: fullOptions.include_raw_content ? candidate.snippet : undefined,
    }));

    // 7. Result Deduplication (Content similarity + Normalized URL)
    const deduplicatedResults = this.deduplicationService.deduplicateResults(candidateResults);

    // 8. Result Ranking (Multi-factor relevance, authority, freshness, quality)
    const rankedResults = this.rankingService.rankResults(
      deduplicatedResults,
      fullOptions.query,
      { time_range: fullOptions.time_range }
    );

    // Limit to requested max_results
    const finalResults = rankedResults.slice(0, maxResults);

    // 9. Grounded AI Answer Generation (if requested)
    let answerText: string | undefined;
    if (fullOptions.include_answer && finalResults.length > 0) {
      try {
        const answerObj = await this.answerService.generateAnswer(fullOptions.query, finalResults);
        if (answerObj) {
          answerText = answerObj.answer;
        }
      } catch (answerErr: any) {
        logger.warn('Answer generation failed gracefully', { error: answerErr.message });
      }
    }

    const elapsedSeconds = (performance.now() - startTime) / 1000;
    const responseTime = Math.round(elapsedSeconds * 100) / 100;

    const responseStatus = finalResults.length > 0 ? 'success' : 'partial_success';

    const response: SearchResponse = {
      query: fullOptions.query,
      answer: answerText,
      results: finalResults,
      response_time: responseTime,
      status: responseStatus,
      search_depth: searchDepth,
      total_found: finalResults.length,
    };

    // 10. Cache Response
    this.cacheService.set(cacheKey, response);

    return response;
  }

  /**
   * Advanced Retrieval: Query expansion and multi-angle retrieval
   */
  private async executeAdvancedRetrieval(options: SearchOptions): Promise<SearchProviderResult[]> {
    const primaryQuery = options.query;
    const queries = [primaryQuery];

    // Generate complementary sub-queries for broader coverage
    const tokens = tokenize(primaryQuery, true);
    if (tokens.length >= 2) {
      queries.push(`${primaryQuery} overview`);
      queries.push(`${primaryQuery} analysis`);
    }

    // Execute searches concurrently across sub-queries
    const resultsLists = await Promise.all(
      queries.map(q =>
        this.provider
          .search(q, {
            ...options,
            max_results: Math.min(options.max_results || 10, 15),
          })
          .catch(() => [] as SearchProviderResult[])
      )
    );

    // Flatten and combine
    const merged: SearchProviderResult[] = [];
    for (const list of resultsLists) {
      merged.push(...list);
    }

    return merged;
  }
}
