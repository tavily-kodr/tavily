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
import { FileSystemStorage } from "../storage/file.storage.js";
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
  public readonly storage: CrawlStorage;
  private readonly robots: RobotsManager;
  private readonly sitemaps: SitemapParser;
  private readonly scheduler: CrawlScheduler;
  private readonly searchClient: SearchServiceClient;

  constructor(options: CrawlerEngineOptions = {}) {
    this.fetcher = options.fetcher ?? new HttpFetcher();
    this.extractor = options.extractor ?? new HtmlExtractor();
    this.storage = options.storage ?? new FileSystemStorage("./storage");
    this.robots = new RobotsManager(this.fetcher);
    this.sitemaps = new SitemapParser(this.fetcher);
    this.searchClient = options.searchClient ?? new SearchServiceClient();
    this.scheduler = new CrawlScheduler({
      globalConcurrency: options.globalConcurrency ?? 16,
      perDomainConcurrency: options.perDomainConcurrency ?? 8,
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

    const seedUrls: string[] = [];
    if (request.urls && request.urls.length > 0) {
      seedUrls.push(...request.urls.map((u) => normalizeUrl(u)));
    } else if (request.url) {
      seedUrls.push(normalizeUrl(request.url));
    }

    const rootHostnames = new Set<string>();
    for (const u of seedUrls) {
      try {
        rootHostnames.add(new URL(u).hostname.toLowerCase());
      } catch {
        // ignore
      }
    }

    logger.info("Starting crawler run", {
      crawlId,
      seedUrlsCount: seedUrls.length,
      domains: Array.from(rootHostnames),
      limit: request.limit,
      maxDepth: request.maxDepth,
      allowExternal: request.allowExternal,
      multiDomain: request.multiDomain,
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

    // Seed frontier with all seed URLs across domains
    for (const sUrl of seedUrls) {
      frontier.enqueue({ url: sUrl, normalizedUrl: sUrl, depth: 0 });
      deduplicator.markUrlSeen(sUrl);
    }

    // Seed with sitemaps only if frontier has not reached request.limit and this is a single-domain direct crawl
    if (
      !request.ignoreRobots &&
      frontier.size() < request.limit &&
      !request.multiDomain &&
      !request.urls
    ) {
      for (const sUrl of seedUrls) {
        if (frontier.size() >= request.limit) break;
        try {
          const sitemaps = await this.robots.getSitemaps(sUrl);
          for (const smUrl of sitemaps.slice(0, 1)) {
            if (frontier.size() >= request.limit) break;
            const entries = await this.sitemaps.parseSitemap(smUrl);
            for (const entry of entries) {
              if (frontier.size() >= request.limit) break;
              if (!deduplicator.isUrlSeen(entry)) {
                deduplicator.markUrlSeen(entry);
                frontier.enqueue({ url: entry, normalizedUrl: entry, depth: 1 });
              }
            }
          }
        } catch {
          // Continue if sitemaps fail
        }
      }
    }

    const crawlAbortController = new AbortController();

    // Pre-warm robots cache concurrently across all seed URLs (bounded to 250ms)
    if (!request.ignoreRobots && seedUrls.length > 0) {
      const robotsPromise = Promise.allSettled(seedUrls.map((sUrl) => this.robots.isAllowed(sUrl)));
      await Promise.race([robotsPromise, new Promise((r) => setTimeout(r, 250))]);
    }

    // Parallel worker pool:
    // Concurrency dynamically sized to request.limit (up to 16 concurrent workers)
    const concurrency = Math.min(Math.max(request.limit, 12), 16);
    let activeWorkers = 0;
    let stopRequested = false;
    const waitQueue: Array<() => void> = [];

    const notifyWorkers = () => {
      while (waitQueue.length > 0) {
        const wake = waitQueue.shift();
        if (wake) wake();
      }
    };

    const waitForTask = (): Promise<void> => {
      return new Promise((resolve) => {
        let done = false;
        const timeoutId = setTimeout(() => {
          if (!done) {
            done = true;
            const idx = waitQueue.indexOf(wakeCb);
            if (idx !== -1) waitQueue.splice(idx, 1);
            resolve();
          }
        }, 400);

        const wakeCb = () => {
          if (!done) {
            done = true;
            clearTimeout(timeoutId);
            resolve();
          }
        };
        waitQueue.push(wakeCb);
      });
    };

    const runWorker = async (workerId: number): Promise<void> => {
      while (!stopRequested) {
        if (pages.length >= request.limit) {
          stopRequested = true;
          crawlAbortController.abort();
          notifyWorkers();
          break;
        }

        if (performance.now() - startTime > request.crawlTimeoutMs) {
          logger.warn("Crawl timeout exceeded in worker", { crawlId, workerId });
          stopRequested = true;
          crawlAbortController.abort();
          notifyWorkers();
          break;
        }

        const item = frontier.dequeue();
        if (!item) {
          if (activeWorkers === 0) {
            stopRequested = true;
            crawlAbortController.abort();
            notifyWorkers();
            break;
          }
          await waitForTask();
          continue;
        }

        activeWorkers++;
        try {
          if (!request.ignoreRobots) {
            const isAllowed = await this.robots.isAllowed(item.normalizedUrl);
            if (!isAllowed) {
              totalSkipped++;
              continue;
            }
          }

          await this.scheduler.schedule(item.normalizedUrl, async () => {
            if (pages.length >= request.limit || stopRequested) return;

            const pageStartTime = performance.now();
            try {
              const fetchRes = await this.fetcher.fetch(item.normalizedUrl, {
                timeoutMs: 1400,
                maxRetries: 0,
                signal: crawlAbortController.signal,
              });
              totalBytes += fetchRes.byteLength;

              const extractRes = await this.extractor.extract(fetchRes.body, fetchRes.url, {
                fallbackToPlaywright: request.enablePlaywrightFallback,
              });

              const isDuplicate = deduplicator.isContentSeen(extractRes.metadata.contentHash);
              deduplicator.markContentSeen(extractRes.metadata.contentHash);

              if (isDuplicate) {
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

              if (pages.length < request.limit) {
                pages.push(pageRecord);
                if (pages.length >= request.limit) {
                  stopRequested = true;
                  crawlAbortController.abort();
                  notifyWorkers();
                }
              }

              if (item.depth < request.maxDepth && pages.length < request.limit) {
                const allowMultiDomain = request.allowExternal || request.multiDomain;
                for (const link of extractRes.outboundLinks) {
                  if (frontier.size() >= request.limit * 4) break;
                  let linkHost = "";
                  let linkPath = "";
                  try {
                    const parsed = new URL(link);
                    linkHost = parsed.hostname.toLowerCase();
                    linkPath = parsed.pathname;
                  } catch {
                    continue;
                  }

                  const isInternal =
                    rootHostnames.has(linkHost) ||
                    Array.from(rootHostnames).some((h) => linkHost.endsWith(`.${h}`));

                  const domainAllowed =
                    (allowMultiDomain || isInternal) &&
                    matchesDomainRules(linkHost, request.selectDomains, request.excludeDomains);

                  const pathAllowed = matchesPathRules(
                    linkPath,
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
              if (crawlAbortController.signal.aborted || pages.length >= request.limit) {
                return;
              }
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
              if (pages.length < request.limit) {
                pages.push(failedRecord);
              }
            }
          });
        } finally {
          activeWorkers--;
          if (pages.length >= request.limit || (frontier.isEmpty() && activeWorkers === 0)) {
            stopRequested = true;
          }
          notifyWorkers();
        }
      }
    };

    const workerTasks = Array.from({ length: concurrency }, (_, i) => runWorker(i));
    await Promise.all(workerTasks);

    const durationMs = Math.max(0, Math.round(performance.now() - startTime));
    const stats: CrawlStats = {
      totalDiscovered: deduplicator.urlCount,
      totalCrawled: pages.filter((p) => p.state === "COMPLETED").length,
      totalFailed,
      totalSkipped,
      totalBytes,
      durationMs,
    };

    const paths =
      this.storage instanceof FileSystemStorage ? this.storage.getStoragePaths(crawlId) : undefined;

    const crawlResponse: CrawlResponse = {
      success: true,
      crawlId,
      stats,
      pages,
      storageInfo: paths
        ? {
            rootDir: paths.rootDir,
            crawlDir: paths.crawlDir,
            manifestPath: paths.manifestPath,
            combinedMarkdownPath: paths.combinedMarkdownPath,
            latestMarkdownPath: paths.latestMarkdownPath,
            files: ["latest_crawl.md", "crawl.md"],
          }
        : undefined,
    };

    await this.storage.saveCrawl(crawlResponse);
    logger.info("Crawl completed successfully with parallel worker pool", {
      crawlId,
      concurrency,
      stats,
    });

    return crawlResponse;
  }
}
