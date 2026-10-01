/**
 * robots.txt compliance checker with caching
 */

interface RobotsRule {
  allow: string[];
  disallow: string[];
}

const ROBOTS_CACHE = new Map<string, { rules: RobotsRule; expiresAt: number }>();
const CACHE_TTL_MS = 3600000; // 1 hour

/**
 * Parses robots.txt content into allow/disallow lists for general/tavily user agents
 */
function parseRobotsTxt(content: string, targetAgent: string = 'TavilyBot'): RobotsRule {
  const lines = content.split('\n');
  let isTargetSection = false;
  let isWildcardSection = false;

  const targetRules: RobotsRule = { allow: [], disallow: [] };
  const wildcardRules: RobotsRule = { allow: [], disallow: [] };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(':');
    if (parts.length < 2) continue;

    const directive = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(':').trim();

    if (directive === 'user-agent') {
      const agent = value.toLowerCase();
      if (agent === targetAgent.toLowerCase()) {
        isTargetSection = true;
        isWildcardSection = false;
      } else if (agent === '*') {
        isTargetSection = false;
        isWildcardSection = true;
      } else {
        isTargetSection = false;
        isWildcardSection = false;
      }
    } else if (directive === 'disallow') {
      if (value) {
        if (isTargetSection) targetRules.disallow.push(value);
        if (isWildcardSection) wildcardRules.disallow.push(value);
      }
    } else if (directive === 'allow') {
      if (value) {
        if (isTargetSection) targetRules.allow.push(value);
        if (isWildcardSection) wildcardRules.allow.push(value);
      }
    }
  }

  // If specific agent rules exist, use those; otherwise use wildcard
  if (targetRules.disallow.length > 0 || targetRules.allow.length > 0) {
    return targetRules;
  }
  return wildcardRules;
}

/**
 * Checks if a path is allowed according to robots rules
 */
function isPathAllowed(path: string, rules: RobotsRule): boolean {
  // Check allows first
  for (const allowPattern of rules.allow) {
    if (path.startsWith(allowPattern)) {
      return true;
    }
  }
  // Check disallows
  for (const disallowPattern of rules.disallow) {
    if (path.startsWith(disallowPattern)) {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether a URL is permitted to be scraped per domain robots.txt
 */
export async function isUrlAllowedByRobots(
  urlString: string,
  timeoutMs: number = 3000
): Promise<boolean> {
  try {
    const parsed = new URL(urlString);
    const domain = parsed.hostname.toLowerCase();
    const origin = parsed.origin;
    const path = parsed.pathname || '/';

    const now = Date.now();
    const cached = ROBOTS_CACHE.get(domain);
    if (cached && cached.expiresAt > now) {
      return isPathAllowed(path, cached.rules);
    }

    const robotsUrl = `${origin}/robots.txt`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TavilyBot/1.0 (+https://tavily.com/bot)' },
      });
      clearTimeout(timer);

      if (resp.status === 404 || resp.status === 410) {
        // If robots.txt doesn't exist, everything is allowed
        const openRule: RobotsRule = { allow: [], disallow: [] };
        ROBOTS_CACHE.set(domain, { rules: openRule, expiresAt: now + CACHE_TTL_MS });
        return true;
      }

      if (resp.ok) {
        const text = await resp.text();
        const rules = parseRobotsTxt(text);
        ROBOTS_CACHE.set(domain, { rules, expiresAt: now + CACHE_TTL_MS });
        return isPathAllowed(path, rules);
      }
    } catch {
      clearTimeout(timer);
      // Network/timeout error accessing robots.txt - fail open to avoid blocking legitimate scraping
      return true;
    }

    return true;
  } catch {
    return true;
  }
}
