import { SearchService } from "@tavily/searching";
import { CrawlerEngine } from "@tavily/scraping";
import { logger } from "@tavily/logger";

export interface UnifiedSearchOptions {
  query: string;
  maxResults?: number | undefined;
  includeImages?: boolean | undefined;
  fallbackToPlaywright?: boolean | undefined;
}

export interface MergedSearchResult {
  title: string;
  url: string;
  score: number;
  snippet: string;
  markdown: string;
  metadata?:
    | {
        contentHash?: string | undefined;
        byteSize?: number | undefined;
        language?: string | undefined;
        isSpa?: boolean | undefined;
        usedPlaywright?: boolean | undefined;
      }
    | undefined;
  outboundLinks?: string[] | undefined;
}

export interface UnifiedSearchResponse {
  query: string;
  resultsCount: number;
  results: MergedSearchResult[];
  timings: {
    searchTookMs: number;
    scrapeTookMs: number;
    totalTookMs: number;
  };
}

export class OrchestratorService {
  private readonly searchService: SearchService;
  private readonly crawlerEngine: CrawlerEngine;

  constructor(searchService?: SearchService, crawlerEngine?: CrawlerEngine) {
    this.searchService = searchService ?? new SearchService();
    this.crawlerEngine = crawlerEngine ?? new CrawlerEngine();
  }

  /**
   * Orchestrates the 2-stage search and scrape pipeline:
   * 1. Query Google via SearXNG in @tavily/searching
   * 2. Concurrently fetch, clean, and convert top URLs to Markdown in @tavily/scraping
   * 3. Merge ranking relevance with markdown payloads
   */
  public async searchAndScrape(options: UnifiedSearchOptions): Promise<UnifiedSearchResponse> {
    const pipelineStartTime = performance.now();
    logger.info("Starting unified Search + Scrape pipeline", { query: options.query });

    // Stage 1: Search Domain Execution
    const searchStartTime = performance.now();
    const searchResult = await this.searchService.search(options.query);
    const searchTookMs = Math.max(0, Math.round(performance.now() - searchStartTime));

    // Apply maxResults limit if requested
    const targetItems =
      options.maxResults && options.maxResults > 0
        ? searchResult.results.slice(0, options.maxResults)
        : searchResult.results;

    const urls = targetItems.map((item) => item.url);

    if (urls.length === 0) {
      return {
        query: options.query,
        resultsCount: 0,
        results: [],
        timings: {
          searchTookMs,
          scrapeTookMs: 0,
          totalTookMs: Math.round(performance.now() - pipelineStartTime),
        },
      };
    }

    // Stage 2: Scraping Domain Execution
    const scrapeResult = await this.crawlerEngine.extract({
      urls,
      includeImages: options.includeImages ?? false,
      fallbackToPlaywright: options.fallbackToPlaywright ?? false,
    });
    const scrapeTookMs = scrapeResult.tookMs;

    // Stage 3: Merge and Rank Results
    const resultMap = new Map(scrapeResult.results.map((r) => [r.url, r]));

    const mergedResults: MergedSearchResult[] = targetItems.map((searchItem) => {
      const page = resultMap.get(searchItem.url);
      return {
        title: searchItem.title,
        url: searchItem.url,
        score: searchItem.score,
        snippet: searchItem.content,
        markdown: page?.markdown ?? "",
        metadata: page?.metadata
          ? {
              contentHash: page.metadata.contentHash,
              byteSize: page.metadata.byteSize,
              language: page.metadata.language,
              isSpa: page.metadata.isSpa,
              usedPlaywright: page.metadata.usedPlaywright,
            }
          : undefined,
        outboundLinks: page?.outboundLinks,
      };
    });

    const totalTookMs = Math.round(performance.now() - pipelineStartTime);
    logger.info("Unified Search + Scrape pipeline completed", {
      query: options.query,
      resultsCount: mergedResults.length,
      timings: { searchTookMs, scrapeTookMs, totalTookMs },
    });

    return {
      query: options.query,
      resultsCount: mergedResults.length,
      results: mergedResults,
      timings: {
        searchTookMs,
        scrapeTookMs,
        totalTookMs,
      },
    };
  }

  /**
   * Executes a deep crawl either starting from a direct URL or resolved via a search query.
   */
  public async searchAndCrawl(options: {
    url?: string | undefined;
    query?: string | undefined;
    limit?: number | undefined;
    maxDepth?: number | undefined;
    enablePlaywrightFallback?: boolean | undefined;
  }) {
    const startTime = performance.now();
    let seedUrl = options.url;

    if (!seedUrl && options.query) {
      logger.info("Resolving seed URL from Search service for crawl", { query: options.query });
      const searchResult = await this.searchService.search(options.query);
      const firstResult = searchResult.results[0];
      if (!firstResult) {
        throw new Error(`No search results found for query: '${options.query}'`);
      }
      seedUrl = firstResult.url;
    }

    if (!seedUrl) {
      throw new Error("Either 'url' or 'query' must be provided for crawl.");
    }

    logger.info("Starting deep crawl on seed URL", { seedUrl, limit: options.limit });
    const crawlResult = await this.crawlerEngine.crawl({
      url: seedUrl,
      limit: options.limit ?? 20,
      maxDepth: options.maxDepth ?? 2,
      enablePlaywrightFallback: options.enablePlaywrightFallback ?? false,
    });

    const tookMs = Math.round(performance.now() - startTime);
    return {
      query: options.query,
      seedUrl,
      crawl: crawlResult,
      tookMs,
    };
  }
}
