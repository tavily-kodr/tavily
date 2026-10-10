import type { CheerioAPI } from "cheerio";
import { resolveAndNormalizeUrl } from "../url/normalizer.js";

/**
 * Extracts and normalizes all outbound hyperlinks from the document BEFORE DOM cleanup.
 */
export function extractOutboundLinks($: CheerioAPI, baseUrl: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  $("a[href]").each((_, elem) => {
    const rawHref = $(elem).attr("href");
    if (!rawHref) return;

    const normalized = resolveAndNormalizeUrl(rawHref, baseUrl);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  });

  return results;
}
