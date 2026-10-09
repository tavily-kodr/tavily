import type { CheerioAPI } from "cheerio";

const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "dialog",
  "canvas",
  "template",
  "object",
  "embed",
  "applet",
  // Cookie notices and GDPR banners
  ".cookie-banner",
  "#cookie-banner",
  "[class*='cookie-notice']",
  "[id*='cookie-notice']",
  "[class*='cookie-consent']",
  "[id*='cookie-consent']",
  "[aria-label*='cookie' i]",
  // Advertisements
  "[class*='ad-']",
  "[id*='ad-']",
  "[class*='advertisement']",
  "[id*='advertisement']",
  "[class*='google-ad']",
  // Tracking pixels
  "img[width='1'][height='1']",
  "img[width='0'][height='0']",
];

/**
 * Removes noise tags, scripts, tracking pixels, ads, and cookie banners from Cheerio DOM.
 */
export function sanitizeDom($: CheerioAPI): void {
  for (const selector of NOISE_SELECTORS) {
    try {
      $(selector).remove();
    } catch {
      // Ignore selector errors
    }
  }

  // Remove HTML comments
  $("*")
    .contents()
    .filter((_, el) => el.type === "comment")
    .remove();
}
