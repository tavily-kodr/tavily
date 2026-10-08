import type { SearchResult } from "../types.js";

/**
 * Different engines often return the same page (identical or near-identical
 * URL) with slightly different titles/snippets. This keeps only the first
 * occurrence of each URL, since SearXNG already orders results by its own
 * relevance score, so "first" = "highest ranked" for that URL.
 *
 * Also normalizes URLs lightly (strips trailing slash, ignores http/https
 * difference) so "https://example.com/" and "http://example.com" count as
 * the same result instead of showing up twice.
 */
export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    const normalizedUrl = normalizeUrl(result.url);

    if (seen.has(normalizedUrl)) {
      continue;
    }

    seen.add(normalizedUrl);
    deduped.push(result);
  }

  return deduped;
}

export function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}
