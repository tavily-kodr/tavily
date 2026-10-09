import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { OrchestratorService } from "../services/orchestrator.service.js";

const searchRequestSchema = z.object({
  query: z.string().trim().min(1, "Query is required"),
  max_results: z.coerce.number().int().min(1).max(20).optional(),
  include_images: z.boolean().default(false),
  fallback_to_playwright: z.boolean().default(false),
});

const crawlRequestSchema = z
  .object({
    url: z.string().url().optional(),
    query: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(20),
    max_depth: z.coerce.number().int().min(1).max(10).default(2),
    fallback_to_playwright: z.boolean().default(false),
  })
  .refine((data) => Boolean(data.url || data.query), {
    message: "Either 'url' or 'query' must be provided",
    path: ["url"],
  });

export class ApiController {
  constructor(private readonly orchestrator = new OrchestratorService()) {}

  public handleSearch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawPayload = {
        query: req.body?.query ?? req.query?.["query"] ?? req.params?.["query"],
        max_results: req.body?.max_results ?? req.query?.["max_results"],
        include_images: req.body?.include_images ?? req.query?.["include_images"] === "true",
        fallback_to_playwright:
          req.body?.fallback_to_playwright ?? req.query?.["fallback_to_playwright"] === "true",
      };

      const parsed = searchRequestSchema.parse(rawPayload);

      const data = await this.orchestrator.searchAndScrape({
        query: parsed.query,
        maxResults: parsed.max_results,
        includeImages: parsed.include_images,
        fallbackToPlaywright: parsed.fallback_to_playwright,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  };

  public handleCrawl = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawPayload = {
        url: req.body?.url ?? req.query?.["url"],
        query: req.body?.query ?? req.query?.["query"],
        limit: req.body?.limit ?? req.query?.["limit"],
        max_depth: req.body?.max_depth ?? req.query?.["max_depth"],
        fallback_to_playwright:
          req.body?.fallback_to_playwright ?? req.query?.["fallback_to_playwright"] === "true",
      };

      const parsed = crawlRequestSchema.parse(rawPayload);

      const data = await this.orchestrator.searchAndCrawl({
        url: parsed.url,
        query: parsed.query,
        limit: parsed.limit,
        maxDepth: parsed.max_depth,
        enablePlaywrightFallback: parsed.fallback_to_playwright,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  };
}
