import type { Request, Response } from "express";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import { SearchService } from "../services/search.service.js";
import { startTimer, elapsedMs } from "../utils/timing.js";
import type { SearchSuccessResponse, SearchErrorResponse } from "../types/search.types.js";

export class SearchController {
  private readonly searchService: SearchService;

  constructor(searchService?: SearchService) {
    this.searchService = searchService ?? new SearchService();
  }

  handleSearch = async (
    req: Request,
    res: Response<SearchSuccessResponse | SearchErrorResponse>,
  ): Promise<Response> => {
    const startTime = startTimer();
    const abortController = new AbortController();

    const onClose = () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    };
    res.on("close", onClose);

    let queryCandidate: string | undefined;

    // 1. Request body { "query": "..." }
    if (
      req.body &&
      typeof req.body === "object" &&
      "query" in req.body &&
      typeof req.body.query === "string"
    ) {
      queryCandidate = req.body.query;
    }
    // 2. Path parameter /search/:query
    else if (typeof req.params.query === "string") {
      queryCandidate = req.params.query;
    }

    try {
      if (typeof queryCandidate !== "string" || !queryCandidate.trim()) {
        throw new AppError("Search query is required", {
          code: "INVALID_QUERY",
          statusCode: 400,
        });
      }

      const rawQuery = queryCandidate.trim();
      logger.info("Search started", { query: rawQuery });

      // Parse optional search and crawl parameters
      const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<
        string,
        unknown
      >;

      let crawlOption: boolean | undefined;
      if (typeof bodyObj.crawl === "boolean") {
        crawlOption = bodyObj.crawl;
      } else if (req.query?.crawl !== undefined) {
        crawlOption = req.query.crawl !== "false" && req.query.crawl !== "0";
      }

      const rawMaxResults = bodyObj.max_results ?? bodyObj.maxResults ?? req.query?.max_results;
      const maxResults =
        typeof rawMaxResults === "number" && rawMaxResults > 0
          ? Math.floor(rawMaxResults)
          : undefined;

      const rawCrawlDepth = bodyObj.crawl_depth ?? bodyObj.crawlDepth;
      const crawlDepth =
        typeof rawCrawlDepth === "number" && rawCrawlDepth >= 0
          ? Math.floor(rawCrawlDepth)
          : undefined;

      const includeRawContent =
        bodyObj.include_raw_content === true || bodyObj.includeRawContent === true;

      const { query, results } = await this.searchService.search(rawQuery, {
        crawl: crawlOption,
        maxResults,
        crawlDepth,
        includeRawContent,
        signal: abortController.signal,
      });
      const took_ms = elapsedMs(startTime);

      logger.info("Search completed", {
        resultsCount: results.length,
        took_ms,
      });

      return res.status(200).json({
        success: true,
        data: {
          query,
          results,
          took_ms,
        },
      });
    } catch (err: unknown) {
      const took_ms = elapsedMs(startTime);

      if (err instanceof AppError) {
        logger.error("Search failed", {
          code: err.code,
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

      const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
      logger.error("Search failed with unexpected error", {
        error: errorMessage,
        took_ms,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      });
    } finally {
      res.off("close", onClose);
    }
  };
}
