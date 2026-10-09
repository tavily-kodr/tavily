export { createSearchApp, app } from "./app.js";
export { createSearchRouter, searchRouter } from "./routes/search.routes.js";
export { SearchController } from "./controllers/search.controller.js";
export {
  SearchService,
  type SearchServiceOptions,
  type SearchExecutionResult,
} from "./services/search.service.js";
export { SearxngClient, type SearxngClientOptions } from "./clients/searxng.client.js";
export { getSearchConfig } from "./config.js";
export { isValidUrl, canonicalizeUrl, startTimer, elapsedMs } from "./utils/index.js";
export * from "./types/index.js";
