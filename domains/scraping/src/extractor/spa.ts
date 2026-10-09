import type { CheerioAPI } from "cheerio";

const SPA_ROOT_SELECTORS = ["#root", "#app", "#__next", "#__nuxt", "#app-root", "[data-reactroot]"];

const JS_REQUIRED_PHRASES = [
  "enable javascript to run this app",
  "enable javascript",
  "javascript is required",
  "please turn on javascript",
  "javascript must be enabled",
];

/**
 * Heuristic detector for Single Page Applications (SPAs) that require client-side JS rendering.
 */
export function isSpaPage($: CheerioAPI, extractedTextLength: number): boolean {
  if (extractedTextLength >= 200) {
    return false;
  }

  const rawHtml = $.html().toLowerCase();

  // Check for phrases indicating JS requirement
  for (const phrase of JS_REQUIRED_PHRASES) {
    if (rawHtml.includes(phrase)) {
      return true;
    }
  }

  // Check for known SPA container tags
  for (const selector of SPA_ROOT_SELECTORS) {
    const el = $(selector);
    if (el.length > 0) {
      const innerText = el.text().trim();
      if (innerText.length < 50) {
        return true;
      }
    }
  }

  return false;
}
