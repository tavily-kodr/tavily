import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import { ScraperService } from "./scraper.service.js";
import { HttpFetcher } from "../clients/http-fetcher.js";
import {
  validateUrlForScraping,
  isValidUrlSyntax,
  canonicalizeUrl,
} from "../utils/url-validator.js";
import { RobotsPolicy } from "../utils/robots-parser.js";
import type {
  CrawlOptions,
  CrawlResult,
  CrawledPageItem,
  CrawlFailedItem,
} from "../types/crawl.types.js";
import type { ScrapedPageResult } from "../types/scraping.types.js";

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_SAME_DOMAIN_ONLY = true;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 10;
const DEFAULT_MAX_QUEUE_SIZE = 1000;

interface QueueItem {
  url: string;
  depth: number;
}

/**
 * Origin-level rate limiter to ensure politeness across concurrent crawler workers.
 * Sequentializes requests targeting the same origin hostname and spaces them by crawlDelayMs.
 */
class OriginRateLimiter {
  private readonly lastRequestTimes = new Map<string, number>();
  private readonly originLocks = new Map<string, Promise<void>>();

  async throttle(origin: string, delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) return;
    if (signal?.aborted) {
      throw new AppError("Crawl was aborted", { code: "CRAWL_ABORTED", statusCode: 499 });
    }

    // Wait for any existing in-flight request lock on this origin to release
    while (this.originLocks.has(origin)) {
      const lockPromise = this.originLocks.get(origin)!;
      await Promise.race([
        lockPromise,
        new Promise<void>((_, reject) => {
          if (signal) {
            const onAbort = () => {
              reject(new AppError("Crawl was aborted", { code: "CRAWL_ABORTED", statusCode: 499 }));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
      if (signal?.aborted) {
        throw new AppError("Crawl was aborted", { code: "CRAWL_ABORTED", statusCode: 499 });
      }
    }

    let releaseLock: () => void = () => {};
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.originLocks.set(origin, currentLock);

    try {
      const now = Date.now();
      const lastTime = this.lastRequestTimes.get(origin) ?? 0;
      const elapsed = now - lastTime;
      if (elapsed < delayMs) {
        const waitTime = delayMs - elapsed;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve();
          }, waitTime);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new AppError("Crawl was aborted", { code: "CRAWL_ABORTED", statusCode: 499 }));
          };
          if (signal) signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      this.lastRequestTimes.set(origin, Date.now());
    } finally {
      this.originLocks.delete(origin);
      releaseLock();
    }
  }
}

/**
 * Multi-page crawl orchestrator. Coordinates breadth-first traversal,
 * bounded concurrency, duplicate elimination, queue bounds, per-origin politeness,
 * robots.txt compliance, and SSRF protection on all discovered links.
 */
export class CrawlerService {
  private readonly scraper: ScraperService;
  private readonly fetcher: HttpFetcher;

  constructor(scraper?: ScraperService, fetcher?: HttpFetcher) {
    this.scraper = scraper ?? new ScraperService(fetcher);
    const internalFetcher = (scraper as unknown as { fetcher?: HttpFetcher })?.fetcher;
    this.fetcher = fetcher ?? internalFetcher ?? new HttpFetcher();
  }

  /**
   * Crawls multiple pages starting from a seed URL using breadth-first traversal.
   *
   * @param seedUrl The initial entrypoint URL (depth 0).
   * @param options Crawl bounds, concurrency, politeness, timeout, and fetch settings.
   * @returns Structured crawl results with visited pages, failures, and statistics.
   */
  async crawl(seedUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
    const startTime = performance.now();

    // 1. Validate crawl options
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const sameDomainOnly = options.sameDomainOnly ?? DEFAULT_SAME_DOMAIN_ONLY;
    const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;

    if (maxPages < 1) {
      throw new AppError("maxPages option must be at least 1", {
        code: "INVALID_OPTIONS",
        statusCode: 400,
        details: { maxPages },
      });
    }

    if (maxDepth < 0) {
      throw new AppError("maxDepth option cannot be negative", {
        code: "INVALID_OPTIONS",
        statusCode: 400,
        details: { maxDepth },
      });
    }

    if (maxQueueSize < 1) {
      throw new AppError("maxQueueSize option must be at least 1", {
        code: "INVALID_OPTIONS",
        statusCode: 400,
        details: { maxQueueSize },
      });
    }

    let concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (concurrency < 1) {
      throw new AppError("concurrency option must be at least 1", {
        code: "INVALID_OPTIONS",
        statusCode: 400,
        details: { concurrency },
      });
    }
    if (concurrency > MAX_CONCURRENCY) {
      logger.warn(
        `Requested concurrency ${concurrency} exceeds limit of ${MAX_CONCURRENCY}; clamping to ${MAX_CONCURRENCY}`,
      );
      concurrency = MAX_CONCURRENCY;
    }

    if (options.crawlDelayMs !== undefined && options.crawlDelayMs < 0) {
      throw new AppError("crawlDelayMs option cannot be negative", {
        code: "INVALID_OPTIONS",
        statusCode: 400,
        details: { crawlDelayMs: options.crawlDelayMs },
      });
    }

    if (options.crawlTimeoutMs !== undefined && options.crawlTimeoutMs <= 0) {
      throw new AppError("crawlTimeoutMs option must be greater than 0", {
        code: "INVALID_OPTIONS",
        statusCode: 400,
        details: { crawlTimeoutMs: options.crawlTimeoutMs },
      });
    }

    // 2. Setup cancellation and timeout signals
    let effectiveSignal: AbortSignal;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let timeoutController: AbortController | undefined;
    let isTimedOut = false;

    if (options.crawlTimeoutMs !== undefined) {
      timeoutController = new AbortController();
      timeoutTimer = setTimeout(() => {
        isTimedOut = true;
        timeoutController?.abort();
      }, options.crawlTimeoutMs);
    }

    if (options.signal && timeoutController) {
      effectiveSignal = AbortSignal.any([options.signal, timeoutController.signal]);
    } else if (options.signal) {
      effectiveSignal = options.signal;
    } else if (timeoutController) {
      effectiveSignal = timeoutController.signal;
    } else {
      effectiveSignal = new AbortController().signal;
    }

    if (effectiveSignal.aborted) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (isTimedOut) {
        throw new AppError(`Crawl exceeded overall timeout of ${options.crawlTimeoutMs}ms`, {
          code: "CRAWL_TIMEOUT",
          statusCode: 504,
        });
      }
      throw new AppError("Crawl was aborted", { code: "CRAWL_ABORTED", statusCode: 499 });
    }

    logger.info("Starting multi-page crawl", {
      seedUrl,
      maxPages,
      maxDepth,
      concurrency,
      sameDomainOnly,
      maxQueueSize,
    });

    try {
      // 3. Validate seed URL with SSRF protection upfront.
      // Seed failure crashes the crawl immediately.
      const validatedSeed = await validateUrlForScraping(seedUrl, {
        dnsLookup: options.dnsLookup,
        allowPrivateNetworks: options.allowPrivateNetworks,
        allowedProtocols: options.allowedProtocols,
      });

      const seedHostname = validatedSeed.parsedUrl.hostname.toLowerCase();
      const seedOrigin = `${validatedSeed.parsedUrl.protocol}//${validatedSeed.parsedUrl.host}`;

      // 4. Handle robots.txt policy if requested
      let robotsPolicy: RobotsPolicy | null = null;
      let effectiveCrawlDelayMs = options.crawlDelayMs ?? 0;

      if (options.respectRobotsTxt) {
        const { policy, delayMs } = await this.loadRobotsPolicy(
          seedOrigin,
          options,
          effectiveSignal,
        );
        robotsPolicy = policy;

        if (options.crawlDelayMs === undefined && delayMs !== undefined && delayMs > 0) {
          effectiveCrawlDelayMs = delayMs;
        }

        if (!robotsPolicy.isAllowed(validatedSeed.parsedUrl)) {
          throw new AppError(`Crawl seed URL '${seedUrl}' is disallowed by robots.txt policy`, {
            code: "ROBOTS_DISALLOWED",
            statusCode: 403,
            details: { seedUrl },
          });
        }
      }

      // 5. FIFO Queue, tracking sets, and result metrics
      const queue: QueueItem[] = [];
      const seenCanonicalUrls = new Set<string>();
      const pages: CrawledPageItem[] = [];
      const failedPages: CrawlFailedItem[] = [];
      let totalDiscovered = 1; // Seed is discovered
      let totalVisited = 0;
      let queueLimitReached = false;
      let discardedDueToQueueLimit = 0;
      let robotsBlockedCount = 0;

      seenCanonicalUrls.add(validatedSeed.canonicalUrl);
      queue.push({ url: validatedSeed.canonicalUrl, depth: 0 });

      // 6. Worker coordination
      const originRateLimiter = new OriginRateLimiter();
      let activeFetches = 0;
      let seedError: unknown = null;

      let queueResolvers: Array<() => void> = [];
      const notifyQueue = () => {
        const currentResolvers = queueResolvers;
        queueResolvers = [];
        for (const resolve of currentResolvers) {
          resolve();
        }
      };

      const waitForQueueOrStop = (): Promise<void> => {
        return new Promise<void>((resolve) => {
          queueResolvers.push(resolve);
        });
      };

      const onAbort = () => {
        notifyQueue();
      };
      effectiveSignal.addEventListener("abort", onAbort, { once: true });

      // Worker task processing an individual queue item
      const processItem = async (item: QueueItem) => {
        if (effectiveSignal.aborted || seedError) return;

        let itemOrigin: string;
        try {
          itemOrigin = new URL(item.url).origin;
        } catch {
          itemOrigin = seedOrigin;
        }

        // Apply per-origin politeness throttling
        if (effectiveCrawlDelayMs > 0) {
          await originRateLimiter.throttle(itemOrigin, effectiveCrawlDelayMs, effectiveSignal);
        }

        if (effectiveSignal.aborted || seedError) return;

        let scraped: ScrapedPageResult;
        try {
          scraped = await this.scraper.scrape(item.url, {
            ...options,
            signal: effectiveSignal,
          });
        } catch (err: unknown) {
          if (effectiveSignal.aborted) return;

          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof AppError ? err.code : "FETCH_ERROR";
          const statusCode = err instanceof AppError ? err.statusCode : 500;

          // If the seed page fails to fetch, fail the entire crawl immediately
          if (item.depth === 0) {
            throw new AppError(`Failed to fetch crawl seed URL '${item.url}': ${message}`, {
              code: "SEED_FETCH_FAILED",
              statusCode,
              cause: err,
              details: { seedUrl: item.url, error: message },
            });
          }

          // Non-seed page failure is recorded and crawl continues
          logger.warn("Crawl page fetch failed", {
            url: item.url,
            depth: item.depth,
            error: message,
          });
          failedPages.push({
            url: item.url,
            depth: item.depth,
            error: message,
            code,
            statusCode,
          });
          return;
        }

        if (effectiveSignal.aborted || seedError) return;

        // Successfully scraped page
        pages.push({
          url: item.url,
          finalUrl: scraped.finalUrl,
          depth: item.depth,
          statusCode: scraped.statusCode,
          title: scraped.title,
          description: scraped.description,
          canonicalUrl: scraped.canonicalUrl,
          language: scraped.language,
          text: scraped.text,
          links: scraped.links,
          tookMs: scraped.tookMs,
          resolvedIp: scraped.resolvedIp,
        });

        // Stop discovering links if maxPages reached or current page is at maxDepth
        if (pages.length >= maxPages || item.depth >= maxDepth) {
          return;
        }

        // Discover and validate outgoing links
        for (const rawLink of scraped.links) {
          totalDiscovered++;

          if (!isValidUrlSyntax(rawLink)) {
            failedPages.push({
              url: rawLink,
              depth: item.depth + 1,
              error: `Invalid URL syntax: '${rawLink}'`,
              code: "INVALID_URL",
              statusCode: 400,
            });
            continue;
          }

          const canonicalLink = canonicalizeUrl(rawLink);
          if (seenCanonicalUrls.has(canonicalLink)) {
            continue;
          }
          // Mark seen immediately so concurrent workers do not schedule the same URL
          seenCanonicalUrls.add(canonicalLink);

          let parsedLink: URL;
          try {
            parsedLink = new URL(rawLink);
          } catch {
            continue;
          }

          // Apply domain boundary filter
          if (sameDomainOnly && parsedLink.hostname.toLowerCase() !== seedHostname) {
            continue;
          }

          // Evaluate robots.txt policy if active
          if (robotsPolicy && !robotsPolicy.isAllowed(parsedLink)) {
            robotsBlockedCount++;
            continue;
          }

          // Check maximum queue bound before expensive DNS/SSRF validation
          if (queue.length >= maxQueueSize) {
            queueLimitReached = true;
            discardedDueToQueueLimit++;
            continue;
          }

          // Validate discovered URL with SSRF protection and DNS resolution BEFORE adding to queue
          try {
            const validatedLink = await validateUrlForScraping(rawLink, {
              dnsLookup: options.dnsLookup,
              allowPrivateNetworks: options.allowPrivateNetworks,
              allowedProtocols: options.allowedProtocols,
            });

            if (
              seenCanonicalUrls.has(validatedLink.canonicalUrl) &&
              validatedLink.canonicalUrl !== canonicalLink
            ) {
              continue;
            }
            seenCanonicalUrls.add(validatedLink.canonicalUrl);

            // Re-check queue limit in case queue grew during async validation
            if (queue.length >= maxQueueSize) {
              queueLimitReached = true;
              discardedDueToQueueLimit++;
              continue;
            }

            queue.push({
              url: validatedLink.canonicalUrl,
              depth: item.depth + 1,
            });
            notifyQueue(); // Wake up any worker waiting for an item
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const code = err instanceof AppError ? err.code : "SSRF_BLOCKED";
            const statusCode = err instanceof AppError ? err.statusCode : 400;

            logger.warn("Discovered link rejected by SSRF guard", {
              url: rawLink,
              depth: item.depth + 1,
              error: message,
            });

            failedPages.push({
              url: rawLink,
              depth: item.depth + 1,
              error: message,
              code,
              statusCode,
            });
          }
        }
      };

      // Worker runner function
      const runWorker = async () => {
        while (true) {
          if (effectiveSignal.aborted || seedError) {
            break;
          }

          if (pages.length >= maxPages) {
            break;
          }

          // When queue is empty or in-flight fetches are sufficient to reach maxPages
          if (queue.length === 0 || pages.length + activeFetches >= maxPages) {
            if (activeFetches === 0) {
              notifyQueue();
              break;
            }
            await waitForQueueOrStop();
            continue;
          }

          const item = queue.shift()!;
          activeFetches++;
          totalVisited++;

          try {
            await processItem(item);
          } catch (err: unknown) {
            if (item.depth === 0) {
              seedError = err;
              notifyQueue();
              break;
            }
          } finally {
            activeFetches--;
            notifyQueue();
          }
        }
      };

      // Launch bounded worker pool
      const workerPromises: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i++) {
        workerPromises.push(runWorker());
      }

      await Promise.all(workerPromises);
      effectiveSignal.removeEventListener("abort", onAbort);

      if (seedError) {
        throw seedError;
      }

      if (effectiveSignal.aborted) {
        if (isTimedOut) {
          throw new AppError(`Crawl exceeded overall timeout of ${options.crawlTimeoutMs}ms`, {
            code: "CRAWL_TIMEOUT",
            statusCode: 504,
            details: { crawlTimeoutMs: options.crawlTimeoutMs },
          });
        }
        throw new AppError("Crawl was aborted", {
          code: "CRAWL_ABORTED",
          statusCode: 499,
        });
      }

      const tookMs = Math.round(performance.now() - startTime);

      logger.info("Multi-page crawl completed", {
        seedUrl,
        pagesCount: pages.length,
        failedPagesCount: failedPages.length,
        totalDiscovered,
        totalVisited,
        queueLimitReached,
        discardedDueToQueueLimit,
        robotsBlockedCount,
        tookMs,
      });

      return {
        seedUrl,
        canonicalSeedUrl: validatedSeed.canonicalUrl,
        pages,
        failedPages,
        totalDiscovered,
        totalVisited,
        tookMs,
        queueLimitReached,
        discardedDueToQueueLimit,
        robotsBlockedCount,
      };
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }
  }

  /**
   * Fetches and parses robots.txt for the specified origin.
   * On 404 or connection failure, defaults to RFC 9309 allow-all policy.
   */
  private async loadRobotsPolicy(
    seedOrigin: string,
    options: CrawlOptions,
    signal?: AbortSignal,
  ): Promise<{ policy: RobotsPolicy; delayMs?: number | undefined }> {
    const robotsUrl = `${seedOrigin}/robots.txt`;
    const userAgent = options.userAgent ?? "TavilyScraper";

    try {
      const fetchRes = await this.fetcher.fetch(robotsUrl, {
        ...options,
        signal,
        timeoutMs: Math.min(options.timeoutMs ?? 5000, 5000),
        maxSizeBytes: 512 * 1024,
        allowedContentTypes: [
          "text/plain",
          "text/html",
          "application/xhtml+xml",
          "text/markdown",
          "*/*",
        ],
      });

      if (fetchRes.statusCode >= 200 && fetchRes.statusCode < 300) {
        const policy = new RobotsPolicy(fetchRes.body, userAgent);
        return { policy, delayMs: policy.getCrawlDelayMs() };
      }
      return { policy: RobotsPolicy.allowAll() };
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw err;
      }
      logger.debug("Robots.txt unavailable or fetch failed; defaulting to allow-all", {
        robotsUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return { policy: RobotsPolicy.allowAll() };
    }
  }
}
