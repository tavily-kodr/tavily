import type { CheerioAPI } from "cheerio";

const CANDIDATE_SELECTORS = [
  "main",
  "article",
  "[role='main']",
  "#content",
  ".content",
  "#main-content",
  ".main-content",
  "#main",
  ".post-content",
  ".article-content",
  ".entry-content",
];

export interface DensitySelection {
  html: string;
  text: string;
  selectedSelector: string;
}

/**
 * Finds the primary content container using text-to-HTML density analysis.
 * If a candidate container has text length > 200 chars, the one with highest density is selected.
 * Otherwise, falls back to the cleaned <body>.
 */
export function selectDenseContent($: CheerioAPI): DensitySelection {
  let bestDensity = -1;
  let bestCandidate: { html: string; text: string; selector: string } | null = null;

  for (const selector of CANDIDATE_SELECTORS) {
    const el = $(selector).first();
    if (el.length > 0) {
      const text = el.text().trim();
      const html = el.html() || "";

      if (text.length > 200) {
        // Density = text length / total HTML length (higher means more text, fewer wrappers/tags)
        const density = text.length / Math.max(1, html.length);
        if (density > bestDensity) {
          bestDensity = density;
          bestCandidate = { html, text, selector };
        }
      }
    }
  }

  if (bestCandidate) {
    return {
      html: bestCandidate.html,
      text: bestCandidate.text,
      selectedSelector: bestCandidate.selector,
    };
  }

  // Fallback to body
  const body = $("body");
  const fallbackHtml = body.length > 0 ? body.html() || "" : $.html();
  const fallbackText = body.length > 0 ? body.text().trim() : $.root().text().trim();

  return {
    html: fallbackHtml,
    text: fallbackText,
    selectedSelector: "body",
  };
}
