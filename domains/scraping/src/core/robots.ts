import { logger } from "@tavily/logger";
import type { HttpFetcher } from "../fetcher/client.js";

interface Rule {
  path: string;
  allow: boolean;
}

interface ParsedRobots {
  rules: Rule[];
  sitemaps: string[];
  crawlDelayMs?: number | undefined;
}

export class RobotsManager {
  private readonly cache = new Map<string, ParsedRobots>();

  constructor(private readonly fetcher: HttpFetcher) {}

  /**
   * Fetches and parses robots.txt for the given origin.
   */
  public async getRobotsForUrl(targetUrl: string, userAgent = "*"): Promise<ParsedRobots> {
    const origin = new URL(targetUrl).origin;
    const cacheKey = `${origin}::${userAgent}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const robotsUrl = `${origin}/robots.txt`;
    try {
      const response = await this.fetcher.fetch(robotsUrl, {
        timeoutMs: 250,
        maxBytes: 512 * 1024, // 512KB max
        maxRetries: 0,
      });

      const parsed = this.parseRobotsTxt(response.body, userAgent);
      this.cache.set(cacheKey, parsed);
      return parsed;
    } catch (err: unknown) {
      logger.debug("robots.txt not found or unavailable, allowing access", {
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
      // Permissive fallback when robots.txt is missing or 404
      const fallback: ParsedRobots = { rules: [], sitemaps: [] };
      this.cache.set(cacheKey, fallback);
      return fallback;
    }
  }

  /**
   * Checks whether crawling is allowed for a given URL using longest-prefix match logic.
   */
  public async isAllowed(targetUrl: string, userAgent = "*"): Promise<boolean> {
    const robots = await this.getRobotsForUrl(targetUrl, userAgent);
    if (robots.rules.length === 0) return true;

    const pathname = new URL(targetUrl).pathname;

    let bestMatch: Rule | null = null;
    let longestLength = -1;

    for (const rule of robots.rules) {
      if (this.matchesRule(pathname, rule.path)) {
        if (rule.path.length > longestLength) {
          longestLength = rule.path.length;
          bestMatch = rule;
        } else if (rule.path.length === longestLength && rule.allow) {
          // Allow wins ties
          bestMatch = rule;
        }
      }
    }

    if (!bestMatch) return true;
    return bestMatch.allow;
  }

  /**
   * Returns discovered sitemaps from robots.txt.
   */
  public async getSitemaps(targetUrl: string): Promise<string[]> {
    const robots = await this.getRobotsForUrl(targetUrl);
    return robots.sitemaps;
  }

  private matchesRule(pathname: string, rulePath: string): boolean {
    if (!rulePath || rulePath === "/") return true;

    // Wildcard support: * and $ (end of URL)
    let pattern = rulePath.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

    if (pattern.endsWith("\\$")) {
      pattern = pattern.slice(0, -2) + "$";
    } else {
      pattern = "^" + pattern;
    }

    try {
      const rx = new RegExp(pattern);
      return rx.test(pathname);
    } catch {
      return pathname.startsWith(rulePath);
    }
  }

  private parseRobotsTxt(content: string, targetAgent = "*"): ParsedRobots {
    const lines = content.split(/\r?\n/);
    const rules: Rule[] = [];
    const sitemaps: string[] = [];
    let crawlDelayMs: number | undefined;

    let currentApplies = false;

    for (let rawLine of lines) {
      // Strip comments
      const hashIndex = rawLine.indexOf("#");
      if (hashIndex !== -1) {
        rawLine = rawLine.substring(0, hashIndex);
      }
      const line = rawLine.trim();
      if (!line) continue;

      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;

      const directive = line.substring(0, colonIndex).trim().toLowerCase();
      const value = line.substring(colonIndex + 1).trim();

      if (directive === "user-agent") {
        const agent = value.toLowerCase();
        currentApplies =
          agent === "*" || agent === targetAgent.toLowerCase() || agent.includes("tavily");
      } else if (directive === "sitemap" && value) {
        try {
          sitemaps.push(new URL(value).toString());
        } catch {
          // Ignore invalid sitemap URL
        }
      } else if (currentApplies) {
        if (directive === "disallow" && value) {
          rules.push({ path: value, allow: false });
        } else if (directive === "allow" && value) {
          rules.push({ path: value, allow: true });
        } else if (directive === "crawl-delay" && value) {
          const delaySec = parseFloat(value);
          if (!isNaN(delaySec)) {
            crawlDelayMs = Math.round(delaySec * 1000);
          }
        }
      }
    }

    return { rules, sitemaps, crawlDelayMs };
  }
}
