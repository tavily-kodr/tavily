import type { ScrapeOptions } from "./scraping.types.js";

export interface CrawlOptions extends ScrapeOptions {
  /**
   * Maximum total number of pages to successfully scrape during the crawl.
   * Default: 10.
   */
  maxPages?: number | undefined;

  /**
   * Maximum link distance / depth from the seed URL.
   * Seed is depth 0. Default: 2.
   */
  maxDepth?: number | undefined;

  /**
   * If true, restricts the crawl strictly to URLs sharing the seed URL's hostname.
   * Prevents uncontrolled crawling across the open web. Default: true.
   */
  sameDomainOnly?: boolean | undefined;

  /**
   * Allowed protocols for crawled URLs. Default: ["http:", "https:"].
   */
  allowedProtocols?: Array<"http:" | "https:"> | undefined;

  /**
   * Maximum number of concurrent page fetches.
   * Clamped between 1 and 10. Default: 2.
   */
  concurrency?: number | undefined;

  /**
   * Maximum number of URLs allowed in the crawl queue simultaneously.
   * Prevents unbounded memory consumption on large or cyclical websites.
   * Default: 1000.
   */
  maxQueueSize?: number | undefined;

  /**
   * Politeness delay in milliseconds between requests to the same origin.
   * Default: 0 (no additional delay).
   */
  crawlDelayMs?: number | undefined;

  /**
   * Overall crawl timeout in milliseconds. If exceeded, in-flight work is aborted
   * and an AppError with code CRAWL_TIMEOUT is thrown.
   */
  crawlTimeoutMs?: number | undefined;

  /**
   * Optional AbortSignal to cancel the crawl. If aborted, in-flight requests are terminated
   * and an AppError with code CRAWL_ABORTED is thrown.
   */
  signal?: AbortSignal | undefined;

  /**
   * If true, attempts to fetch and adhere to /robots.txt directives for the target origin.
   * Disallowed URLs are not queued and are recorded in robotsBlockedCount.
   * Default: false.
   */
  respectRobotsTxt?: boolean | undefined;

  /**
   * User-agent identifier to match against robots.txt directives.
   * Default: "TavilyScraper".
   */
  userAgent?: string | undefined;
}

export interface CrawledPageItem {
  url: string;
  finalUrl: string;
  depth: number;
  statusCode: number;
  title: string;
  description?: string | undefined;
  canonicalUrl?: string | undefined;
  language?: string | undefined;
  text: string;
  links: string[];
  tookMs: number;
  resolvedIp: string;
}

export interface CrawlFailedItem {
  url: string;
  depth: number;
  error: string;
  code?: string | undefined;
  statusCode?: number | undefined;
}

export interface CrawlResult {
  /** The initial entrypoint URL requested for crawling. */
  seedUrl: string;
  /** Canonicalized, validated form of the seed URL. */
  canonicalSeedUrl: string;
  /** List of successfully scraped pages (depth, metadata, cleaned text, links). */
  pages: CrawledPageItem[];
  /** List of failed pages or rejected discovered links. */
  failedPages: CrawlFailedItem[];
  /** Total count of URLs discovered (seed + all outgoing links found). */
  totalDiscovered: number;
  /** Total count of URLs attempted to be visited (dequeued and fetched). */
  totalVisited: number;
  /** Total wall-clock time in milliseconds taken by the crawl. */
  tookMs: number;
  /** Whether the queue reached its maximum capacity (maxQueueSize) during discovery. */
  queueLimitReached: boolean;
  /** Number of discovered links discarded because maxQueueSize was reached. */
  discardedDueToQueueLimit: number;
  /** Number of discovered links blocked by robots.txt policy. */
  robotsBlockedCount: number;
}
