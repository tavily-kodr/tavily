/**
 * Minimal RFC 9309-compliant robots.txt parser.
 * Supports User-agent matching (specific name with fallback to '*'),
 * prefix-based Allow / Disallow rules with longest-match precedence,
 * and Crawl-delay parsing.
 */

export interface RobotsPathRule {
  path: string;
  allow: boolean;
}

interface UserAgentGroup {
  agents: string[];
  rules: RobotsPathRule[];
  crawlDelayMs?: number | undefined;
}

export class RobotsPolicy {
  private readonly rules: RobotsPathRule[];
  private readonly crawlDelayMs?: number | undefined;

  constructor(content: string, userAgent = "TavilyScraper") {
    const { rules, crawlDelayMs } = RobotsPolicy.parse(content, userAgent);
    this.rules = rules;
    this.crawlDelayMs = crawlDelayMs;
  }

  /**
   * Evaluates whether a given URL or pathname is permitted according to the parsed rules.
   */
  isAllowed(urlOrPath: string | URL): boolean {
    let pathname: string;
    if (typeof urlOrPath === "string") {
      try {
        pathname = new URL(urlOrPath).pathname;
      } catch {
        pathname = urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
      }
    } else {
      pathname = urlOrPath.pathname;
    }

    if (!pathname) {
      pathname = "/";
    }

    // Longest-match rule evaluation (RFC 9309 § 2.2.2)
    let bestMatch: RobotsPathRule | null = null;

    for (const rule of this.rules) {
      if (!rule.path) {
        // Empty Disallow: means allow all
        continue;
      }

      if (pathname.startsWith(rule.path)) {
        if (!bestMatch || rule.path.length > bestMatch.path.length) {
          bestMatch = rule;
        } else if (rule.path.length === bestMatch.path.length && rule.allow) {
          // If equal length, Allow takes precedence over Disallow
          bestMatch = rule;
        }
      }
    }

    if (bestMatch) {
      return bestMatch.allow;
    }

    // Default policy when no rule matches is ALLOW
    return true;
  }

  /**
   * Returns the parsed crawl-delay in milliseconds, if any.
   */
  getCrawlDelayMs(): number | undefined {
    return this.crawlDelayMs;
  }

  /**
   * Returns a permissive policy that allows all paths.
   */
  static allowAll(): RobotsPolicy {
    return new RobotsPolicy("");
  }

  /**
   * Parses raw robots.txt file contents for the target user-agent.
   */
  private static parse(
    content: string,
    targetAgent: string,
  ): { rules: RobotsPathRule[]; crawlDelayMs?: number | undefined } {
    const normalizedTarget = targetAgent.toLowerCase();
    const lines = content.split(/\r?\n/);

    const groups: UserAgentGroup[] = [];
    let currentGroup: UserAgentGroup | null = null;

    for (const rawLine of lines) {
      // Strip comments and leading/trailing whitespace
      const line = rawLine.split("#")[0]?.trim() ?? "";
      if (!line) continue;

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const directive = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();

      if (directive === "user-agent") {
        const agent = value.toLowerCase();
        // If current group already had rules, start a new group
        if (!currentGroup || currentGroup.rules.length > 0) {
          currentGroup = { agents: [agent], rules: [] };
          groups.push(currentGroup);
        } else {
          // Multiple User-agent lines preceding rules apply to the same group
          currentGroup.agents.push(agent);
        }
      } else if (directive === "disallow" || directive === "allow") {
        if (!currentGroup) continue;

        const isAllow = directive === "allow";
        if (!value && !isAllow) {
          // "Disallow:" with empty value means allow everything
          currentGroup.rules.push({ path: "", allow: true });
        } else if (value) {
          currentGroup.rules.push({ path: value, allow: isAllow });
        }
      } else if (directive === "crawl-delay") {
        if (!currentGroup) continue;
        const seconds = parseFloat(value);
        if (!Number.isNaN(seconds) && seconds >= 0) {
          currentGroup.crawlDelayMs = Math.round(seconds * 1000);
        }
      }
    }

    // Find the most specific matching group:
    // 1. Group specifically matching targetAgent
    // 2. Wildcard group "*"
    // 3. Fallback: empty rules (allow all)
    let selectedGroup: UserAgentGroup | undefined = groups.find((g) =>
      g.agents.some((a) => a === normalizedTarget || normalizedTarget.includes(a)),
    );

    if (!selectedGroup) {
      selectedGroup = groups.find((g) => g.agents.includes("*"));
    }

    return {
      rules: selectedGroup?.rules ?? [],
      crawlDelayMs: selectedGroup?.crawlDelayMs,
    };
  }
}
