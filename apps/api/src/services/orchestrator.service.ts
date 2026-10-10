import fs from "node:fs/promises";
import path from "node:path";
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

    // Write consolidated single latest_crawl.md document
    try {
      const storageDir = path.resolve(process.cwd(), "storage");
      await fs.mkdir(storageDir, { recursive: true });
      const combinedMd = [
        `# Unified Search & Scrape Data Archive`,
        `- **Query:** \`${options.query}\``,
        `- **Date:** ${new Date().toISOString()}`,
        `- **Results Found:** ${mergedResults.length}`,
        `- **Total Duration:** ${totalTookMs}ms`,
        "",
        "---",
        "",
        ...mergedResults.map((r, idx) => {
          return [
            `## Result ${idx + 1}: ${r.title}`,
            `- **Source URL:** [${r.url}](${r.url})`,
            `- **Relevance Score:** ${r.score}`,
            "",
            r.markdown || r.snippet || "*(No markdown extracted)*",
            "",
            "---",
            "",
          ].join("\n");
        }),
      ].join("\n");
      await fs.writeFile(path.join(storageDir, "latest_crawl.md"), combinedMd, "utf-8");
    } catch {
      // ignore
    }

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
   * Executes a deep crawl either starting from direct URL(s) or resolved across multiple domains via a search query.
   */
  public async searchAndCrawl(options: {
    url?: string | undefined;
    urls?: string[] | undefined;
    query?: string | undefined;
    limit?: number | undefined;
    maxDepth?: number | undefined;
    searchLimit?: number | undefined;
    seedLimit?: number | undefined;
    multiDomain?: boolean | undefined;
    allowExternal?: boolean | undefined;
    enablePlaywrightFallback?: boolean | undefined;
  }) {
    const startTime = performance.now();
    const limit = options.limit ?? 5;
    const maxDepth = options.maxDepth ?? 5;
    const multiDomain = options.multiDomain !== false;
    const allowExternal = options.allowExternal ?? multiDomain;

    let seedUrls: string[] = [];
    if (options.urls && options.urls.length > 0) {
      seedUrls = [...options.urls];
    } else if (options.url) {
      if (options.url.includes(",")) {
        seedUrls = options.url
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean);
      } else {
        seedUrls = [options.url.trim()];
      }
    }

    let query = options.query?.trim();

    // If single seedUrl is not a valid http URL, treat it as a query
    if (seedUrls.length === 1 && !/^https?:\/\//i.test(seedUrls[0]!)) {
      query = seedUrls[0];
      seedUrls = [];
    }

    // Auto-detect if query is a URL directly, or resolve variable URLs across search
    if (seedUrls.length === 0 && query) {
      if (/^https?:\/\//i.test(query)) {
        seedUrls = [query];
      } else {
        const searchMax = options.searchLimit ?? Math.max(limit * 2, 15);
        logger.info("Resolving variable seed URLs from Search service for crawl", {
          query,
          searchMax,
        });
        const searchResult = await this.searchService.search(query, { maxResults: searchMax });
        const resolved = searchResult.results.map((r) => r.url);
        if (resolved.length === 0) {
          throw new Error(`No search results found for query: '${query}'`);
        }
        if (multiDomain) {
          const seedCap = options.seedLimit ?? resolved.length;
          seedUrls = resolved.slice(0, seedCap);
        } else {
          seedUrls = [resolved[0]!];
        }
      }
    }

    if (seedUrls.length === 0) {
      throw new Error("Either 'url', 'urls', or 'query' must be provided for crawl.");
    }

    logger.info("Starting deep crawl with variable seed URLs", {
      seedUrlsCount: seedUrls.length,
      seedUrls,
      limit,
      maxDepth,
      multiDomain,
      allowExternal,
    });

    const crawlResult = await this.crawlerEngine.crawl({
      urls: seedUrls,
      url: seedUrls[0],
      limit,
      maxDepth,
      multiDomain,
      allowExternal,
      enablePlaywrightFallback: options.enablePlaywrightFallback ?? false,
    });

    const tookMs = Math.round(performance.now() - startTime);
    return {
      query: options.query,
      seedUrl: seedUrls[0],
      seedUrls,
      totalSearchUrlsFound: seedUrls.length,
      multiDomain,
      storageInfo: crawlResult.storageInfo,
      markdownFiles: {
        combined: crawlResult.storageInfo?.combinedMarkdownPath,
        latest: crawlResult.storageInfo?.latestMarkdownPath,
        directory: crawlResult.storageInfo?.crawlDir,
        pages: crawlResult.storageInfo?.files ?? [],
      },
      crawl: crawlResult,
      tookMs,
    };
  }

  /**
   * Benchmarks crawling performance across single or multiple parameter combinations.
   * Dynamically seeds from all variable URLs returned by searching or passed by user.
   */
  public async runBenchmark(options: {
    url?: string | undefined;
    urls?: string[] | undefined;
    query?: string | undefined;
    searchLimit?: number | undefined;
    seedLimit?: number | undefined;
    multiDomain?: boolean | undefined;
    allowExternal?: boolean | undefined;
    combinations?: Array<{ maxUrl: number; maxDepth: number }>;
  }) {
    const rawUrl = options.url?.trim();
    let query = options.query?.trim();
    let searchTookMs = 0;
    let resolvedUrls: string[] = [];
    let seedUrls: string[] = [];

    const multiDomain = options.multiDomain !== false;
    const allowExternal = options.allowExternal ?? multiDomain;

    if (options.urls && options.urls.length > 0) {
      seedUrls = [...options.urls];
    } else if (rawUrl && rawUrl.includes(",")) {
      seedUrls = rawUrl
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s));
    } else if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
      seedUrls = [rawUrl];
    } else if (rawUrl) {
      query = rawUrl;
    }

    const combos = options.combinations?.length
      ? options.combinations
      : [
          { maxUrl: 5, maxDepth: 5 },
          { maxUrl: 10, maxDepth: 5 },
          { maxUrl: 15, maxDepth: 10 },
        ];

    // Resolve variable URLs from Search Service if query is provided
    if (seedUrls.length === 0 && query) {
      if (/^https?:\/\//i.test(query)) {
        seedUrls = [query];
      } else {
        const highestMaxUrl = Math.max(...combos.map((c) => c.maxUrl), 10);
        const searchMax = options.searchLimit ?? Math.max(highestMaxUrl, 10);
        logger.info("Resolving variable seed URLs from Search service for benchmark", {
          query,
          searchMax,
        });
        const searchStart = performance.now();
        try {
          const searchResult = await this.searchService.search(query, { maxResults: searchMax });
          searchTookMs = Math.round(performance.now() - searchStart);
          resolvedUrls = searchResult.results.map((r) => r.url);
          if (multiDomain) {
            const seedCap = options.seedLimit ?? resolvedUrls.length;
            seedUrls = resolvedUrls.slice(0, seedCap);
          } else {
            seedUrls = resolvedUrls.slice(0, 1);
          }
        } catch (err: unknown) {
          throw new Error(
            `Failed to reach SearXNG search service for query '${query}': ${
              err instanceof Error ? err.message : String(err)
            }. Tip: If SearXNG is offline, pass direct URLs like url=https://en.wikipedia.org/wiki/Large_language_model`,
            { cause: err },
          );
        }

        if (seedUrls.length === 0) {
          throw new Error(`No search results returned from search service for query: '${query}'`);
        }
      }
    }

    if (seedUrls.length === 0) {
      seedUrls = ["https://example.com"];
    }

    const allDiscoveredDomains = new Set<string>();
    for (const u of seedUrls) {
      try {
        allDiscoveredDomains.add(new URL(u).hostname);
      } catch {
        // ignore invalid url
      }
    }

    logger.info("Executing crawler benchmark matrix with variable seed URLs", {
      seedUrlsCount: seedUrls.length,
      seedUrls,
      domains: Array.from(allDiscoveredDomains),
      query,
      multiDomain,
      allowExternal,
      searchTookMs,
      totalCombinations: combos.length,
    });
    const results = [];

    for (const combo of combos) {
      const start = performance.now();
      // Dynamically use variable seed URLs up to combo.maxUrl, ensuring all search URLs are crawled
      const comboSeedUrls = multiDomain
        ? seedUrls.slice(0, Math.min(seedUrls.length, combo.maxUrl))
        : [seedUrls[0]!];

      const crawlRes = await this.crawlerEngine.crawl({
        urls: comboSeedUrls,
        url: comboSeedUrls[0],
        limit: combo.maxUrl,
        maxDepth: combo.maxDepth,
        multiDomain,
        allowExternal,
      });
      const durationMs = Math.round(performance.now() - start);

      const crawledDomains = Array.from(
        new Set(
          crawlRes.pages
            .map((p) => {
              try {
                return new URL(p.url).hostname;
              } catch {
                return "";
              }
            })
            .filter(Boolean),
        ),
      );
      for (const d of crawledDomains) allDiscoveredDomains.add(d);

      results.push({
        combination: `max_url = ${combo.maxUrl} & max_depth = ${combo.maxDepth}`,
        maxUrl: combo.maxUrl,
        maxDepth: combo.maxDepth,
        durationMs,
        durationSec: (durationMs / 1000).toFixed(2),
        seedUrlsUsed: comboSeedUrls.length,
        pagesCrawled: crawlRes.stats.totalCrawled,
        pagesDiscovered: crawlRes.stats.totalDiscovered,
        domainsCrawledCount: crawledDomains.length,
        domainsCrawled: crawledDomains,
        totalBytes: crawlRes.stats.totalBytes,
        avgPerPageMs:
          crawlRes.stats.totalCrawled > 0
            ? Math.round(durationMs / crawlRes.stats.totalCrawled)
            : durationMs,
        crawlId: crawlRes.crawlId,
      });
    }

    return {
      query: query ?? undefined,
      totalSearchUrlsFound: resolvedUrls.length > 0 ? resolvedUrls.length : seedUrls.length,
      targetUrls: seedUrls,
      targetUrl: seedUrls[0] || "",
      multiDomain,
      allDomainsCrawled: Array.from(allDiscoveredDomains),
      resolvedUrls: resolvedUrls.length > 0 ? resolvedUrls : undefined,
      searchTookMs: searchTookMs > 0 ? searchTookMs : undefined,
      totalCombinationsTested: combos.length,
      results,
    };
  }
}
