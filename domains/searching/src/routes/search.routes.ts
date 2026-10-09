import { Router } from "express";
import { SearchController } from "../controllers/search.controller.js";

export function createSearchRouter(controller?: SearchController): Router {
  const router = Router();
  const searchController = controller ?? new SearchController();

  // POST /search with JSON body { "query": "..." }
  router.post("/", searchController.handleSearch);

  // Path-style search: /search/:query (e.g. GET /search/sheiryans)
  router.get("/:query", searchController.handleSearch);
  router.post("/:query", searchController.handleSearch);

  return router;
}

export const searchRouter = createSearchRouter();
