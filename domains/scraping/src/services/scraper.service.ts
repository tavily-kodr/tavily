import { logger } from "@tavily/logger";
import { HttpFetcher } from "../clients/http-fetcher.js";
import { extractHtml } from "../utils/html-extractor.js";
import type { ScrapeOptions, ScrapedPageResult } from "../types/scraping.types.js";

/**
 * Single-page scraper service. Coordinates secure fetching, DNS pinning,
 * and semantic HTML extraction.
 */
export class ScraperService {
  private readonly fetcher: HttpFetcher;

  constructor(fetcher?: HttpFetcher) {
    this.fetcher = fetcher ?? new HttpFetcher();
  }

  /**
   * Scrapes a single webpage at the provided URL.
   *
   * @param url The target HTTP/HTTPS URL.
   * @param options Configuration for timeouts, size limits, redirects, and extraction.
   * @returns Cleaned page text, extracted metadata, discovered links, and HTTP execution stats.
   */
  async scrape(url: string, options?: ScrapeOptions): Promise<ScrapedPageResult> {
    const startTime = performance.now();
    logger.info("Scraping page started", { url });

    const fetchResult = await this.fetcher.fetch(url, options);

    const extracted = extractHtml(fetchResult.body, fetchResult.finalUrl, {
      includeBoilerplate: options?.includeBoilerplate,
    });

    const tookMs = Math.round(performance.now() - startTime);

    logger.info("Scraping page completed", {
      url,
      finalUrl: fetchResult.finalUrl,
      statusCode: fetchResult.statusCode,
      title: extracted.title,
      linksCount: extracted.links.length,
      tookMs,
    });

    return {
      requestedUrl: url,
      finalUrl: fetchResult.finalUrl,
      statusCode: fetchResult.statusCode,
      contentType: fetchResult.contentType,
      title: extracted.title,
      description: extracted.description,
      canonicalUrl: extracted.canonicalUrl,
      language: extracted.language,
      text: extracted.text,
      links: extracted.links,
      tookMs,
      resolvedIp: fetchResult.resolvedIp,
    };
  }
}
