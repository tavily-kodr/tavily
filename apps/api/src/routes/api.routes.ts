import { Router } from "express";
import { ApiController } from "../controllers/api.controller.js";

export function createApiRouter(controller = new ApiController()): Router {
  const router = Router();

  // POST /search with JSON payload: { query, max_results, include_images }
  router.post("/search", controller.handleSearch);

  // GET /search?query=...
  router.get("/search", controller.handleSearch);

  // GET /search/:query path-style
  router.get("/search/:query", controller.handleSearch);

  // POST /crawl with JSON payload: { url, query, limit, max_depth }
  router.post("/crawl", controller.handleCrawl);
  router.get("/crawl", controller.handleCrawl);

  return router;
}

export const apiRouter = createApiRouter();
