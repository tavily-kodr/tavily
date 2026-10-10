import type { Request, Response } from "express";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import { CrawlerService } from "../services/crawler.service.js";
import { validateCrawlRequest } from "../validation/crawl.schema.js";
import type { CrawlSuccessResponse, CrawlErrorResponse } from "../types/crawl-api.types.js";
import { saveCrawlReport } from "../output/index.js";

/**
 * Controller for crawl API endpoint. Coordinates request body validation,
 * bounds enforcement, client cancellation linking, and safe structured responses.
 */
export class CrawlController {
  private readonly crawler: CrawlerService;

  constructor(crawler?: CrawlerService) {
    this.crawler = crawler ?? new CrawlerService();
  }

  handleCrawl = async (
    req: Request,
    res: Response<CrawlSuccessResponse | CrawlErrorResponse>,
  ): Promise<Response> => {
    const startTime = performance.now();
    const abortController = new AbortController();

    const onClose = () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    };
    res.on("close", onClose);

    try {
      // 1. Validate request body and enforce server-side safety bounds
      const { seedUrl, options } = validateCrawlRequest(req.body);

      logger.info("Crawl API request accepted", {
        seedUrl,
        maxPages: options.maxPages,
        maxDepth: options.maxDepth,
        concurrency: options.concurrency,
        sameDomainOnly: options.sameDomainOnly,
      });

      // 2. Execute crawl using bounded CrawlerService
      const result = await this.crawler.crawl(seedUrl, {
        ...options,
        signal: abortController.signal,
      });

      const took_ms = Math.round(performance.now() - startTime);

      logger.info("Crawl API request completed successfully", {
        seedUrl: result.seedUrl,
        pagesCrawled: result.pages.length,
        failedPagesCount: result.failedPages.length,
        took_ms,
      });

      // Save JSON and Markdown crawl reports
      const completedAt = new Date().toISOString();
      const startedAt = new Date(Date.now() - took_ms).toISOString();
      try {
        await saveCrawlReport({
          seedUrl,
          crawlResult: result,
          startedAt,
          completedAt,
          totalDurationMs: took_ms,
        });
      } catch (err: unknown) {
        logger.error("Failed to save crawl query reports", {
          seedUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 3. Return structured crawl data
      return res.status(200).json({
        success: true,
        data: {
          seed_url: result.seedUrl,
          canonical_seed_url: result.canonicalSeedUrl,
          pages: result.pages.map((p) => ({
            url: p.url,
            final_url: p.finalUrl,
            depth: p.depth,
            status_code: p.statusCode,
            title: p.title,
            description: p.description,
            canonical_url: p.canonicalUrl,
            language: p.language,
            text: p.text,
            links: p.links,
            took_ms: p.tookMs,
            resolved_ip: p.resolvedIp,
          })),
          failed_pages: result.failedPages.map((f) => ({
            url: f.url,
            depth: f.depth,
            error: f.error,
            code: f.code,
            status_code: f.statusCode,
          })),
          metrics: {
            total_discovered: result.totalDiscovered,
            total_visited: result.totalVisited,
            queue_limit_reached: result.queueLimitReached,
            discarded_due_to_queue_limit: result.discardedDueToQueueLimit,
            robots_blocked_count: result.robotsBlockedCount,
          },
          took_ms,
        },
      });
    } catch (err: unknown) {
      const took_ms = Math.round(performance.now() - startTime);

      if (err instanceof AppError) {
        logger.warn("Crawl API request failed", {
          code: err.code,
          statusCode: err.statusCode,
          message: err.message,
          took_ms,
        });

        return res.status(err.statusCode).json({
          success: false,
          error: {
            code: err.code,
            message: err.message,
          },
        });
      }

      const rawMessage = err instanceof Error ? err.message : "An unexpected error occurred";
      logger.error("Crawl API unexpected internal error", {
        error: rawMessage,
        took_ms,
      });

      // Never expose raw stack traces or internal implementation details
      return res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred while processing the crawl",
        },
      });
    } finally {
      res.off("close", onClose);
    }
  };
}
