import type { CheerioAPI } from "cheerio";

export interface RawMetadata {
  title: string;
  description?: string | undefined;
  canonicalUrl?: string | undefined;
  language?: string | undefined;
  openGraph: Record<string, string>;
}

/**
 * Extracts OpenGraph, Twitter, and HTML metadata BEFORE modifying the DOM.
 */
export function extractMetadata($: CheerioAPI, defaultUrl?: string): RawMetadata {
  // Title resolution (og:title -> <title> -> twitter:title -> "")
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
  const docTitle = $("title").first().text()?.trim();
  const twitterTitle = $('meta[name="twitter:title"]').attr("content")?.trim();
  const h1Title = $("h1").first().text()?.trim();
  const title = ogTitle || docTitle || twitterTitle || h1Title || "";

  // Description resolution
  const ogDescription = $('meta[property="og:description"]').attr("content")?.trim();
  const metaDescription = $('meta[name="description"]').attr("content")?.trim();
  const twitterDescription = $('meta[name="twitter:description"]').attr("content")?.trim();
  const description = ogDescription || metaDescription || twitterDescription;

  // Canonical URL
  const canonicalUrl =
    $('link[rel="canonical"]').attr("href")?.trim() ||
    $('meta[property="og:url"]').attr("content")?.trim() ||
    defaultUrl;

  // Language
  const language =
    $("html").attr("lang")?.trim() ||
    $('meta[http-equiv="content-language"]').attr("content")?.trim();

  // All OpenGraph attributes
  const openGraph: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, elem) => {
    const prop = $(elem).attr("property");
    const content = $(elem).attr("content");
    if (prop && content) {
      openGraph[prop] = content.trim();
    }
  });

  return {
    title,
    description: description || undefined,
    canonicalUrl: canonicalUrl || undefined,
    language: language || undefined,
    openGraph,
  };
}
