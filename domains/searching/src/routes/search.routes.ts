import { Router } from "express";
import { SearchController } from "../controllers/search.controller.js";

export function createSearchRouter(controller?: SearchController): Router {
  const router = Router();
  const searchController = controller ?? new SearchController();

  // GET /search?q=... and GET /search (validated in controller)
  router.get("/", searchController.handleSearch);

  // POST /search with JSON body { "query": "..." }
  router.post("/", searchController.handleSearch);

  // Path-style search: GET /search/:query (e.g. GET /search/shariyans)
  router.get("/:query", searchController.handleSearch);

  return router;
}

export const searchRouter = createSearchRouter();
