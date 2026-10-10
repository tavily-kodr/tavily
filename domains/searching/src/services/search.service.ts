import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import {
  ScraperService,
  CrawlerService,
  HttpFetcher,
  saveSearchScrapeReport,
} from "@tavily/scraping";
import { SearxngClient } from "../clients/searxng.client.js";
import { isValidUrl, canonicalizeUrl, isBlockedHostname } from "../utils/url-validator.js";
import type { NormalizedSearchResult, SearchQueryOptions } from "../types/search.types.js";
import { getSearchConfig } from "../config.js";

export interface SearchServiceOptions {
  client?: SearxngClient;
  scraper?: ScraperService;
  crawler?: CrawlerService;
  fetcher?: HttpFetcher;
  maxResults?: number;
  crawlCandidates?: boolean;
  maxCrawlResults?: number;
  crawlConcurrency?: number;
  crawlTimeoutMs?: number;
  respectRobotsTxt?: boolean;
  outputDir?: string;
  enableReportOutput?: boolean;
}

export interface SearchExecutionResult {
  query: string;
  results: NormalizedSearchResult[];
}

/**
 * Computes a transparent, deterministic baseline relevance score when
 * the upstream search engine score is 0 or unavailable.
 */
function computeRelevanceScore(
  query: string,
  title: string,
  content: string,
  rankIndex: number,
  originalScore?: number,
): number {
  if (typeof originalScore === "number" && originalScore > 0) {
    return originalScore;
  }

  // Base score inversely proportional to candidate rank position
  const rankWeight = 1 / (rankIndex + 1);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) {
    return Math.round(rankWeight * 1000) / 1000;
  }

  const lowerTitle = title.toLowerCase();
  const lowerContent = content.toLowerCase();

  let termMatches = 0;
  for (const term of terms) {
    if (lowerTitle.includes(term)) termMatches += 2;
    if (lowerContent.includes(term)) termMatches += 1;
  }

  const maxPossible = terms.length * 3;
  const matchRatio = Math.min(termMatches / maxPossible, 1);
  const combined = rankWeight * 0.6 + matchRatio * 0.4;

  return Math.round(combined * 1000) / 1000;
}

/**
 * Executes async tasks with bounded concurrency.
 */
async function runWithBoundedConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex]!, currentIndex);
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

export class SearchService {
  private readonly client: SearxngClient;
  private readonly scraper: ScraperService;
  private readonly crawler: CrawlerService;
  private readonly maxResults: number | undefined;
  private readonly crawlCandidates: boolean;
  private readonly maxCrawlResults: number;
  private readonly crawlConcurrency: number;
  private readonly crawlTimeoutMs: number;
  private readonly respectRobotsTxt: boolean;
  private readonly outputDir?: string | undefined;
  private readonly enableReportOutput: boolean;

  constructor(options: SearchServiceOptions = {}) {
    const config = getSearchConfig();
    const fetcher = options.fetcher ?? new HttpFetcher();

    this.client = options.client ?? new SearxngClient();
    this.scraper = options.scraper ?? new ScraperService(fetcher);
    this.crawler = options.crawler ?? new CrawlerService(this.scraper, fetcher);
    this.maxResults = options.maxResults;
    this.crawlCandidates = options.crawlCandidates ?? config.crawlCandidates;
    this.maxCrawlResults = options.maxCrawlResults ?? config.maxCrawlResults;
    this.crawlConcurrency = options.crawlConcurrency ?? config.crawlConcurrency;
    this.crawlTimeoutMs = options.crawlTimeoutMs ?? config.crawlTimeoutMs;
    this.respectRobotsTxt = options.respectRobotsTxt ?? config.respectRobotsTxt;
    this.outputDir = options.outputDir;
    this.enableReportOutput = options.enableReportOutput ?? true;
  }

  async search(rawQuery: unknown, options?: SearchQueryOptions): Promise<SearchExecutionResult> {
    if (typeof rawQuery !== "string" || !rawQuery.trim()) {
      throw new AppError("Search query is required", {
        code: "INVALID_QUERY",
        statusCode: 400,
      });
    }

    const query = rawQuery.trim();
    const startedAt = new Date().toISOString();
    const startTime = performance.now();
    logger.info("Retrieving search candidates from provider", { query });
    const rawData = await this.client.search(query);

    const maxResults = options?.maxResults ?? this.maxResults ?? getSearchConfig().maxResults;
    const candidateItems: Array<{
      title: string;
      url: string;
      content: string;
      score: number;
      canonicalUrl: string;
    }> = [];
    const seenUrls = new Set<string>();

    for (const item of rawData.results) {
      if (!isValidUrl(item.url)) {
        continue;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(item.url);
      } catch {
        continue;
      }

      // Enforce SSRF protection: reject obvious blocked hostnames upfront
      if (isBlockedHostname(parsedUrl.hostname)) {
        logger.warn("Candidate URL skipped due to blocked hostname", { url: item.url });
        continue;
      }

      const canonical = canonicalizeUrl(item.url);
      if (seenUrls.has(canonical)) {
        continue;
      }
      seenUrls.add(canonical);

      const title = typeof item.title === "string" ? item.title.trim() : "";
      const content = typeof item.content === "string" ? item.content.trim() : "";
      const score = typeof item.score === "number" && !Number.isNaN(item.score) ? item.score : 0;

      candidateItems.push({
        title,
        url: item.url,
        content,
        score,
        canonicalUrl: canonical,
      });

      if (candidateItems.length >= maxResults) {
        break;
      }
    }

    const shouldCrawl = options?.crawl ?? this.crawlCandidates;

    // If crawling is disabled or no candidates found, return normalized candidates
    if (!shouldCrawl || candidateItems.length === 0) {
      const results: NormalizedSearchResult[] = candidateItems.map((c, idx) => ({
        title: c.title,
        url: c.url,
        content: c.content,
        score:
          c.score > 0 ? c.score : computeRelevanceScore(query, c.title, c.content, idx, c.score),
      }));

      return {
        query,
        results,
      };
    }

    // Bounded candidate content fetching
    const candidatesToCrawlCount = Math.min(candidateItems.length, this.maxCrawlResults);
    const crawlTimeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      logger.warn("Crawl timeout exceeded for candidate fetching; aborting pending requests", {
        timeoutMs: this.crawlTimeoutMs,
      });
      crawlTimeoutController.abort();
    }, this.crawlTimeoutMs);

    const effectiveSignal = options?.signal
      ? AbortSignal.any([options.signal, crawlTimeoutController.signal])
      : crawlTimeoutController.signal;

    type CrawledResult = {
      title?: string | undefined;
      text?: string | undefined;
      canonicalUrl?: string | undefined;
      finalUrl?: string | undefined;
      statusCode?: number | undefined;
      tookMs?: number | undefined;
      error?: string | undefined;
    };

    let scrapedResults: Array<CrawledResult | null>;
    const crawlStartTime = performance.now();

    try {
      const crawlDepth = options?.crawlDepth ?? 0;

      scrapedResults = await runWithBoundedConcurrency(
        candidateItems.slice(0, candidatesToCrawlCount),
        this.crawlConcurrency,
        async (candidate) => {
          if (effectiveSignal.aborted) {
            return {
              error: "Crawl request aborted",
            };
          }

          const fetchStartTime = performance.now();
          try {
            if (crawlDepth > 0 || this.respectRobotsTxt) {
              const crawlRes = await this.crawler.crawl(candidate.url, {
                maxDepth: crawlDepth,
                maxPages: crawlDepth > 0 ? 3 : 1,
                sameDomainOnly: true,
                signal: effectiveSignal,
                respectRobotsTxt: this.respectRobotsTxt,
              });
              const rootPage = crawlRes.pages[0];
              if (rootPage) {
                return {
                  title: rootPage.title,
                  text: rootPage.text,
                  canonicalUrl: rootPage.canonicalUrl,
                  finalUrl: rootPage.finalUrl,
                  statusCode: rootPage.statusCode,
                  tookMs: rootPage.tookMs ?? Math.round(performance.now() - fetchStartTime),
                };
              }
              const failed = crawlRes.failedPages[0];
              return {
                error: failed?.error ?? "No crawled pages returned",
                statusCode: failed?.statusCode,
                tookMs: Math.round(performance.now() - fetchStartTime),
              };
            } else {
              const page = await this.scraper.scrape(candidate.url, {
                signal: effectiveSignal,
              });
              return {
                title: page.title,
                text: page.text,
                canonicalUrl: page.canonicalUrl,
                finalUrl: page.finalUrl,
                statusCode: page.statusCode,
                tookMs: page.tookMs,
              };
            }
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.warn("Candidate content fetch failed; falling back to search snippet", {
              url: candidate.url,
              error: errorMsg,
            });
            return {
              error: errorMsg,
              tookMs: Math.round(performance.now() - fetchStartTime),
            };
          }
        },
      );
    } finally {
      clearTimeout(timeoutTimer);
    }
    const crawlDurationMs = Math.round(performance.now() - crawlStartTime);

    // Enrich results with extracted titles, cleaned text, snippets, and canonical URLs
    const enrichedResults: NormalizedSearchResult[] = [];

    for (let i = 0; i < candidateItems.length; i++) {
      const candidate = candidateItems[i]!;
      const scraped = scrapedResults[i];

      if (scraped && scraped.text && scraped.text.length > 0) {
        const enriched: NormalizedSearchResult = {
          title: scraped.title && scraped.title.trim() ? scraped.title.trim() : candidate.title,
          url: scraped.finalUrl || candidate.url,
          content: scraped.text.trim(),
          score: candidate.score,
          snippet: candidate.content,
          canonicalUrl: scraped.canonicalUrl || scraped.finalUrl || candidate.canonicalUrl,
          sourceUrl: candidate.url,
        };

        if (options?.includeRawContent) {
          enriched.rawContent = scraped.text;
        }

        enrichedResults.push(enriched);
      } else {
        enrichedResults.push({
          title: candidate.title,
          url: candidate.url,
          content: candidate.content,
          score: candidate.score,
          snippet: candidate.content,
          canonicalUrl: candidate.canonicalUrl,
          sourceUrl: candidate.url,
        });
      }
    }

    // Deduplicate redirect destinations and identical content
    const seenFinalUrls = new Set<string>();
    const seenContentSnippets = new Set<string>();
    const dedupedResults: NormalizedSearchResult[] = [];

    for (const res of enrichedResults) {
      const canonicalTarget = res.canonicalUrl
        ? canonicalizeUrl(res.canonicalUrl)
        : canonicalizeUrl(res.url);

      if (seenFinalUrls.has(canonicalTarget)) {
        continue;
      }
      seenFinalUrls.add(canonicalTarget);

      const contentPrefix = res.content.slice(0, 150).trim();
      if (contentPrefix && seenContentSnippets.has(contentPrefix)) {
        continue;
      }
      if (contentPrefix) {
        seenContentSnippets.add(contentPrefix);
      }

      dedupedResults.push(res);
    }

    // Compute baseline relevance score where needed and sort
    const finalResults = dedupedResults.map((r, idx) => ({
      ...r,
      score: r.score > 0 ? r.score : computeRelevanceScore(query, r.title, r.content, idx, r.score),
    }));

    const responseResults = finalResults.slice(0, maxResults);

    // Save JSON and Markdown reports when crawling produced scraped results
    if (shouldCrawl && this.enableReportOutput && responseResults.length > 0) {
      const completedAt = new Date().toISOString();
      const totalDurationMs = performance.now() - startTime;
      try {
        await saveSearchScrapeReport({
          query,
          startedAt,
          completedAt,
          totalDurationMs,
          crawlDurationMs,
          results: responseResults,
          scrapedResults,
          outputDir: this.outputDir,
        });
      } catch (err: unknown) {
        logger.error("Failed to save search scraping query reports", {
          query,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      query,
      results: responseResults,
    };
  }
}
