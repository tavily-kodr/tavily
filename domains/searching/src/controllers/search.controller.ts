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

      const { query, results } = await this.searchService.search(rawQuery);
      const took_ms = elapsedMs(startTime);

      logger.info("Search completed", {
        query,
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
    }
  };
}
