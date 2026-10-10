import { Router } from "express";
import { CrawlController } from "../controllers/crawl.controller.js";

/**
 * Creates an Express router exposing the multi-page crawl endpoint.
 */
export function createCrawlRouter(controller?: CrawlController): Router {
  const router = Router();
  const crawlController = controller ?? new CrawlController();

  // POST /crawl with JSON body
  router.post("/", crawlController.handleCrawl);

  return router;
}

export const crawlRouter = createCrawlRouter();
