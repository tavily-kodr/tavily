import { XMLParser } from "fast-xml-parser";
import { logger } from "@tavily/logger";
import type { HttpFetcher } from "../fetcher/client.js";
import { normalizeUrl } from "../url/normalizer.js";

export class SitemapParser {
  private readonly parser: XMLParser;

  constructor(private readonly fetcher: HttpFetcher) {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      trimValues: true,
    });
  }

  /**
   * Fetches and parses an XML sitemap, recursively traversing sitemap indexes up to maxDepth (default 5).
   * Returns a deduplicated list of discovered page URLs.
   */
  public async parseSitemap(
    sitemapUrl: string,
    maxDepth = 5,
    currentDepth = 1,
    seenSitemaps = new Set<string>(),
  ): Promise<string[]> {
    if (currentDepth > maxDepth) {
      logger.debug("Sitemap recursion depth limit reached", { sitemapUrl, maxDepth });
      return [];
    }

    if (seenSitemaps.has(sitemapUrl)) {
      return [];
    }
    seenSitemaps.add(sitemapUrl);

    logger.info("Fetching XML sitemap", { sitemapUrl, currentDepth });

    let rawXml: string;
    try {
      const response = await this.fetcher.fetch(sitemapUrl, {
        timeoutMs: 10000,
        maxBytes: 10 * 1024 * 1024, // 10MB
        maxRetries: 1,
      });
      rawXml = response.body;
    } catch (err: unknown) {
      logger.warn("Failed to fetch sitemap", {
        sitemapUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = this.parser.parse(rawXml);
    } catch (err: unknown) {
      logger.warn("Failed to parse sitemap XML", {
        sitemapUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const discoveredUrls: string[] = [];

    // 1. Check for <sitemapindex>
    if (parsed["sitemapindex"]) {
      const indexObj = parsed["sitemapindex"] as Record<string, unknown>;
      const sitemaps = this.ensureArray(indexObj["sitemap"]);

      for (const sitemapEntry of sitemaps) {
        const loc =
          typeof sitemapEntry === "object" && sitemapEntry !== null
            ? (sitemapEntry as Record<string, unknown>)["loc"]
            : undefined;
        if (typeof loc === "string" && loc.trim()) {
          try {
            const subSitemapUrl = normalizeUrl(loc.trim());
            const subUrls = await this.parseSitemap(
              subSitemapUrl,
              maxDepth,
              currentDepth + 1,
              seenSitemaps,
            );
            discoveredUrls.push(...subUrls);
          } catch {
            // Ignore invalid sitemap loc
          }
        }
      }
    }

    // 2. Check for <urlset>
    if (parsed["urlset"]) {
      const urlsetObj = parsed["urlset"] as Record<string, unknown>;
      const urlEntries = this.ensureArray(urlsetObj["url"]);

      for (const entry of urlEntries) {
        const loc =
          typeof entry === "object" && entry !== null
            ? (entry as Record<string, unknown>)["loc"]
            : undefined;
        if (typeof loc === "string" && loc.trim()) {
          try {
            const normalized = normalizeUrl(loc.trim());
            discoveredUrls.push(normalized);
          } catch {
            // Ignore invalid URL
          }
        }
      }
    }

    return Array.from(new Set(discoveredUrls));
  }

  private ensureArray<T>(item: unknown): T[] {
    if (!item) return [];
    if (Array.isArray(item)) return item as T[];
    return [item as T];
  }
}
