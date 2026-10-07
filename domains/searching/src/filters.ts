import type { SearchResult } from "./types.js";

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeDomains(domains: readonly string[]): string[] {
  return domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
}

function matchesDomain(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Drops results whose hostname equals, or is a subdomain of, a blocked domain.
 */
export function filterBlockedDomains<T extends SearchResult>(
  results: T[],
  blockedDomains: readonly string[],
): T[] {
  const blocked = normalizeDomains(blockedDomains);
  if (blocked.length === 0) return results;

  return results.filter((r) => {
    const host = hostnameOf(r.url);
    return host !== undefined && !matchesDomain(host, blocked);
  });
}

/**
 * Keeps only results on one of the given domains (or their subdomains).
 * An empty list keeps everything.
 */
export function filterIncludeDomains<T extends SearchResult>(
  results: T[],
  includeDomains: readonly string[],
): T[] {
  const included = normalizeDomains(includeDomains);
  if (included.length === 0) return results;

  return results.filter((r) => {
    const host = hostnameOf(r.url);
    return host !== undefined && matchesDomain(host, included);
  });
}

const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

export function hasNonLatinLetters(text: string): boolean {
  return NON_LATIN_LETTER.test(text);
}

// Hostname keywords that mark adult sites missing from the explicit blocklist.
const ADULT_HOST_HINT = /porn|xxx|hentai|nsfw|xvideo|camgirl|sexcam|sextube|sexvideo/i;

/** Hard-drops results whose hostname looks like an adult site. */
export function filterAdultResults<T extends SearchResult>(results: T[]): T[] {
  return results.filter((r) => {
    const host = hostnameOf(r.url);
    return host !== undefined && !ADULT_HOST_HINT.test(host);
  });
}
