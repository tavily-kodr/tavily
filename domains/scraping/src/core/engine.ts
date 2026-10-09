import crypto from "node:crypto";
import { logger } from "@tavily/logger";
import { HttpFetcher } from "../fetcher/client.js";
import { HtmlExtractor } from "../extractor/engine.js";
import { RobotsManager } from "./robots.js";
import { SitemapParser } from "./sitemap.js";
import { InMemoryFrontier } from "./frontier.js";
import { CrawlScheduler } from "./scheduler.js";
import { Deduplicator } from "./deduplicator.js";
import { normalizeUrl } from "../url/normalizer.js";
import { matchesPathRules, matchesDomainRules } from "../url/filter.js";
import { SearchServiceClient } from "../clients/search.client.js";
import type { CrawlStorage } from "../storage/interface.js";
import { InMemoryStorage } from "../storage/memory.storage.js";
import {
  ExtractRequestSchema,
  MapRequestSchema,
  CrawlRequestSchema,
  type ExtractRequestInput,
  type ExtractResponse,
  type ExtractResult,
  type MapRequestInput,
  type MapResponse,
  type CrawlRequestInput,
  type CrawlResponse,
  type PageRecord,
  type CrawlStats,
} from "../types/index.js";

export interface CrawlerEngineOptions {
  fetcher?: HttpFetcher;
  extractor?: HtmlExtractor;
  storage?: CrawlStorage;
  searchClient?: SearchServiceClient;
  globalConcurrency?: number;
  perDomainConcurrency?: number;
}

export class CrawlerEngine {
  private readonly fetcher: HttpFetcher;
  private readonly extractor: HtmlExtractor;
  private readonly storage: CrawlStorage;
  private readonly robots: RobotsManager;
  private readonly sitemaps: SitemapParser;
  private readonly scheduler: CrawlScheduler;
  private readonly searchClient: SearchServiceClient;

  constructor(options: CrawlerEngineOptions = {}) {
    this.fetcher = options.fetcher ?? new HttpFetcher();
    this.extractor = options.extractor ?? new HtmlExtractor();
    this.storage = options.storage ?? new InMemoryStorage();
    this.robots = new RobotsManager(this.fetcher);
    this.sitemaps = new SitemapParser(this.fetcher);
    this.searchClient = options.searchClient ?? new SearchServiceClient();
    this.scheduler = new CrawlScheduler({
      globalConcurrency: options.globalConcurrency ?? 8,
      perDomainConcurrency: options.perDomainConcurrency ?? 2,
    });
  }

  /**
   * Scrapes a batch of URLs (or resolves them via Search query) and extracts high-fidelity markdown.
   */
  public async extract(input: ExtractRequestInput): Promise<ExtractResponse> {
    const request = ExtractRequestSchema.parse(input);
    const startTime = performance.now();
    let targetUrls: string[] = request.urls ?? [];

    // If query provided and urls empty, resolve URLs from upstream Search service
    if (targetUrls.length === 0 && request.query) {
      targetUrls = await this.searchClient.searchUrls(request.query);
      if (targetUrls.length === 0) {
        logger.warn("Search returned no URLs for query", { query: request.query });
      }
    }

    const results: ExtractResult[] = [];
    const errors: Array<{ url: string; code: string; message: string }> = [];

    const tasks = targetUrls.map((rawUrl) =>
      this.scheduler.schedule(rawUrl, async () => {
        let normalized: string;
        try {
          normalized = normalizeUrl(rawUrl);
        } catch (err: unknown) {
          errors.push({
            url: rawUrl,
            code: "INVALID_URL",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        try {
          const fetchRes = await this.fetcher.fetch(normalized);
          const extractRes = await this.extractor.extract(fetchRes.body, fetchRes.url, {
            includeImages: request.includeImages,
            fallbackToPlaywright: request.fallbackToPlaywright,
          });
          results.push(extractRes);
        } catch (err: unknown) {
          errors.push({
            url: normalized,
            code: (err as { code?: string })?.code ?? "EXTRACT_ERROR",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    await Promise.all(tasks);

    const tookMs = Math.max(0, Math.round(performance.now() - startTime));
    return {
      success: errors.length === 0 || results.length > 0,
      total: results.length,
      results,
      errors,
      tookMs,
    };
  }

  /**
   * Discovers URLs from a root domain using sitemaps and shallow BFS without downloading heavy payloads.
   */
  public async map(input: MapRequestInput): Promise<MapResponse> {
    const request = MapRequestSchema.parse(input);
    const startTime = performance.now();
    const rootUrl = normalizeUrl(request.url);
    const rootHostname = new URL(rootUrl).hostname.toLowerCase();

    const discoveredUrls = new Set<string>();
    const deduplicator = new Deduplicator();
    discoveredUrls.add(rootUrl);
    deduplicator.markUrlSeen(rootUrl);

    // 1. Try discovering URLs via XML Sitemaps
    try {
      const sitemapUrls = await this.robots.getSitemaps(rootUrl);
      const candidates =
        sitemapUrls.length > 0 ? sitemapUrls : [`${new URL(rootUrl).origin}/sitemap.xml`];

      for (const smUrl of candidates) {
        if (discoveredUrls.size >= request.limit) break;
        const sitemapEntries = await this.sitemaps.parseSitemap(smUrl);
        for (const entry of sitemapEntries) {
          if (discoveredUrls.size >= request.limit) break;
          const urlHost = new URL(entry).hostname.toLowerCase();
          const isInternal = urlHost === rootHostname || urlHost.endsWith(`.${rootHostname}`);

          if ((request.allowExternal || isInternal) && !deduplicator.isUrlSeen(entry)) {
            const path = new URL(entry).pathname;
            if (matchesPathRules(path, request.selectPaths, request.excludePaths)) {
              deduplicator.markUrlSeen(entry);
              discoveredUrls.add(entry);
            }
          }
        }
      }
    } catch {
      // Continue to shallow BFS if sitemaps fail
    }

    // 2. Shallow BFS to discover remaining links if limit not reached
    if (discoveredUrls.size < request.limit) {
      const frontier = new InMemoryFrontier({
        maxDepth: request.maxDepth,
        maxBreadth: request.maxBreadth,
      });

      frontier.enqueue({ url: rootUrl, normalizedUrl: rootUrl, depth: 0 });

      while (!frontier.isEmpty() && discoveredUrls.size < request.limit) {
        const item = frontier.dequeue();
        if (!item) break;

        try {
          const fetchRes = await this.fetcher.fetch(item.normalizedUrl, {
            maxBytes: 1024 * 1024, // 1MB for mapping
          });
          const extractRes = await this.extractor.extract(fetchRes.body, fetchRes.url);

          for (const link of extractRes.outboundLinks) {
            if (discoveredUrls.size >= request.limit) break;

            const linkHost = new URL(link).hostname.toLowerCase();
            const isInternal = linkHost === rootHostname || linkHost.endsWith(`.${rootHostname}`);

            if (
              (request.allowExternal || isInternal) &&
              matchesPathRules(new URL(link).pathname, request.selectPaths, request.excludePaths) &&
              !deduplicator.isUrlSeen(link)
            ) {
              deduplicator.markUrlSeen(link);
              discoveredUrls.add(link);
              if (item.depth + 1 <= request.maxDepth) {
                frontier.enqueue({ url: link, normalizedUrl: link, depth: item.depth + 1 });
              }
            }
          }
        } catch {
          // Skip mapping fetch failure
        }
      }
    }

    const durationMs = Math.max(0, Math.round(performance.now() - startTime));
    return {
      success: true,
      rootUrl,
      totalUrls: discoveredUrls.size,
      urls: Array.from(discoveredUrls),
      durationMs,
    };
  }

  /**
   * Executes a full, deep BFS crawl with rate-limiting, deduplication, robots checks, and storage persistence.
   */
  public async crawl(input: CrawlRequestInput): Promise<CrawlResponse> {
    const request = CrawlRequestSchema.parse(input);
    const startTime = performance.now();
    const crawlId = `crawl_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const rootUrl = normalizeUrl(request.url);
    const rootHostname = new URL(rootUrl).hostname.toLowerCase();

    logger.info("Starting crawler run", {
      crawlId,
      rootUrl,
      limit: request.limit,
      maxDepth: request.maxDepth,
    });

    const frontier = new InMemoryFrontier({
      maxDepth: request.maxDepth,
      maxBreadth: request.maxBreadth,
    });
    const deduplicator = new Deduplicator();

    const pages: PageRecord[] = [];
    let totalBytes = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    // Seed frontier
    frontier.enqueue({ url: rootUrl, normalizedUrl: rootUrl, depth: 0 });
    deduplicator.markUrlSeen(rootUrl);

    // Seed with sitemaps if robots allows
    if (!request.ignoreRobots) {
      try {
        const sitemaps = await this.robots.getSitemaps(rootUrl);
        for (const smUrl of sitemaps) {
          const entries = await this.sitemaps.parseSitemap(smUrl);
          for (const entry of entries) {
            if (!deduplicator.isUrlSeen(entry) && frontier.size() < request.limit * 2) {
              deduplicator.markUrlSeen(entry);
              frontier.enqueue({ url: entry, normalizedUrl: entry, depth: 1 });
            }
          }
        }
      } catch {
        // Continue if sitemaps fail
      }
    }

    while (!frontier.isEmpty() && pages.length < request.limit) {
      // Check timeout
      if (performance.now() - startTime > request.crawlTimeoutMs) {
        logger.warn("Crawl timeout exceeded, finalizing results", {
          crawlId,
          durationMs: performance.now() - startTime,
        });
        break;
      }

      const item = frontier.dequeue();
      if (!item) break;

      // Check robots.txt
      if (!request.ignoreRobots) {
        const isAllowed = await this.robots.isAllowed(item.normalizedUrl);
        if (!isAllowed) {
          totalSkipped++;
          continue;
        }
      }

      await this.scheduler.schedule(item.normalizedUrl, async () => {
        if (pages.length >= request.limit) return;

        const pageStartTime = performance.now();
        try {
          const fetchRes = await this.fetcher.fetch(item.normalizedUrl);
          totalBytes += fetchRes.byteLength;

          const extractRes = await this.extractor.extract(fetchRes.body, fetchRes.url, {
            fallbackToPlaywright: request.enablePlaywrightFallback,
          });

          // Content hash deduplication check
          const isDuplicateContent = deduplicator.isContentSeen(extractRes.metadata.contentHash);
          deduplicator.markContentSeen(extractRes.metadata.contentHash);

          if (isDuplicateContent) {
            totalSkipped++;
          }

          const pageTookMs = Math.max(0, Math.round(performance.now() - pageStartTime));
          const pageRecord: PageRecord = {
            url: item.url,
            normalizedUrl: item.normalizedUrl,
            state: "COMPLETED",
            depth: item.depth,
            statusCode: fetchRes.statusCode,
            metadata: extractRes.metadata,
            markdown: extractRes.markdown,
            outboundLinks: extractRes.outboundLinks,
            tookMs: pageTookMs,
            timestamp: new Date().toISOString(),
          };

          pages.push(pageRecord);
          await this.storage.savePage(crawlId, pageRecord, pages.length);

          // Link Discovery for subsequent BFS levels
          if (item.depth < request.maxDepth && pages.length < request.limit) {
            for (const link of extractRes.outboundLinks) {
              const linkHost = new URL(link).hostname.toLowerCase();
              const isInternal = linkHost === rootHostname || linkHost.endsWith(`.${rootHostname}`);

              const domainAllowed =
                (request.allowExternal || isInternal) &&
                matchesDomainRules(linkHost, request.selectDomains, request.excludeDomains);

              const pathAllowed = matchesPathRules(
                new URL(link).pathname,
                request.selectPaths,
                request.excludePaths,
              );

              if (domainAllowed && pathAllowed && !deduplicator.isUrlSeen(link)) {
                deduplicator.markUrlSeen(link);
                frontier.enqueue({ url: link, normalizedUrl: link, depth: item.depth + 1 });
              }
            }
          }
        } catch (err: unknown) {
          totalFailed++;
          const pageTookMs = Math.max(0, Math.round(performance.now() - pageStartTime));
          const failedRecord: PageRecord = {
            url: item.url,
            normalizedUrl: item.normalizedUrl,
            state: "PERMANENT_FAILURE",
            depth: item.depth,
            metadata: {
              title: "Error",
              contentHash: "",
              byteSize: 0,
              isSpa: false,
              usedPlaywright: false,
            },
            markdown: "",
            outboundLinks: [],
            error: {
              code: (err as { code?: string })?.code ?? "CRAWL_FETCH_ERROR",
              message: err instanceof Error ? err.message : String(err),
            },
            tookMs: pageTookMs,
            timestamp: new Date().toISOString(),
          };
          pages.push(failedRecord);
          await this.storage.savePage(crawlId, failedRecord, pages.length);
        }
      });
    }

    const durationMs = Math.max(0, Math.round(performance.now() - startTime));
    const stats: CrawlStats = {
      totalDiscovered: deduplicator.urlCount,
      totalCrawled: pages.filter((p) => p.state === "COMPLETED").length,
      totalFailed,
      totalSkipped,
      totalBytes,
      durationMs,
    };

    const crawlResponse: CrawlResponse = {
      success: true,
      crawlId,
      stats,
      pages,
    };

    await this.storage.saveCrawl(crawlResponse);
    logger.info("Crawl completed successfully", { crawlId, stats });

    return crawlResponse;
  }
}
