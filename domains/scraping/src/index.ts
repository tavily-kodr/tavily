export { buildScrapingApp } from "./app.js";
export { getScrapingConfig, type ScrapingConfig } from "./config.js";

// Core Engine
export { CrawlerEngine, type CrawlerEngineOptions } from "./core/engine.js";
export { RobotsManager } from "./core/robots.js";
export { SitemapParser } from "./core/sitemap.js";
export { InMemoryFrontier } from "./core/frontier.js";
export { CrawlScheduler } from "./core/scheduler.js";
export { Deduplicator } from "./core/deduplicator.js";

// Extractor
export { HtmlExtractor, type ExtractOptions } from "./extractor/engine.js";
export { extractMetadata } from "./extractor/metadata.js";
export { extractOutboundLinks } from "./extractor/links.js";
export { sanitizeDom } from "./extractor/sanitizer.js";
export { selectDenseContent } from "./extractor/density.js";
export { isSpaPage } from "./extractor/spa.js";
export { htmlToMarkdown, computeContentHash } from "./extractor/markdown.js";

// Fetcher
export { HttpFetcher } from "./fetcher/client.js";
export type { FetchOptions, FetchResponse } from "./fetcher/types.js";

// URL Utils & SSRF
export { normalizeUrl, resolveAndNormalizeUrl } from "./url/normalizer.js";
export { matchesPathRules, matchesDomainRules, matchesPattern } from "./url/filter.js";
export { validateSsrf, isPrivateIpv4, isPrivateIpv6 } from "./url/ssrf.js";

// Storage
export { type CrawlStorage } from "./storage/interface.js";
export { InMemoryStorage } from "./storage/memory.storage.js";
export {
  FileSystemStorage,
  sanitizePathComponent,
  buildFrontmatter,
} from "./storage/file.storage.js";

// Clients
export { SearchServiceClient } from "./clients/search.client.js";

// Types, Schemas, & Errors
export * from "./types/index.js";
