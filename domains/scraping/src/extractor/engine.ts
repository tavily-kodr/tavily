import { load } from "cheerio";
import { extractMetadata } from "./metadata.js";
import { extractOutboundLinks } from "./links.js";
import { sanitizeDom } from "./sanitizer.js";
import { selectDenseContent } from "./density.js";
import { isSpaPage } from "./spa.js";
import { renderWithPlaywright } from "./playwright.js";
import { htmlToMarkdown, computeContentHash } from "./markdown.js";
import type { ExtractResult, PageMetadata } from "../types/output.types.js";

export interface ExtractOptions {
  includeImages?: boolean;
  fallbackToPlaywright?: boolean;
  defaultUrl?: string;
  timeoutMs?: number;
}

export class HtmlExtractor {
  /**
   * Processes raw HTML, extracting metadata, discovering outbound links,
   * detecting SPAs with dynamic Playwright fallback, isolating content by text density,
   * converting to GFM markdown, and computing deterministic SHA-256 content hashes.
   */
  public async extract(
    rawHtml: string,
    url: string,
    options: ExtractOptions = {},
  ): Promise<ExtractResult> {
    const startTime = performance.now();
    let currentHtml = rawHtml;
    let usedPlaywright = false;

    let $ = load(currentHtml);

    // 1. Extract metadata BEFORE any DOM manipulation
    let rawMeta = extractMetadata($, url);

    // 2. Extract all outbound links BEFORE DOM cleanup
    let outboundLinks = extractOutboundLinks($, url);

    // 3. Initial density/text check to detect SPAs
    const initialSelection = selectDenseContent($);
    const isSpa = isSpaPage($, initialSelection.text.length);

    // 4. Dynamic Playwright Fallback if SPA detected
    if (isSpa && options.fallbackToPlaywright) {
      const rendered = await renderWithPlaywright(url, options.timeoutMs ?? 15000);
      if (rendered) {
        currentHtml = rendered;
        usedPlaywright = true;
        // Reload DOM with rendered HTML
        $ = load(currentHtml);
        rawMeta = extractMetadata($, url);
        outboundLinks = extractOutboundLinks($, url);
      }
    }

    // 5. Sanitize DOM noise (scripts, styles, ads, cookie banners)
    sanitizeDom($);

    // 6. Content density selection
    const denseContent = selectDenseContent($);

    // 7. HTML to Markdown conversion
    const markdown = htmlToMarkdown(denseContent.html, options.includeImages ?? false);

    // 8. Deterministic SHA-256 content hash
    const contentHash = computeContentHash(markdown);
    const tookMs = Math.max(0, Math.round(performance.now() - startTime));

    const metadata: PageMetadata = {
      title: rawMeta.title,
      description: rawMeta.description,
      canonicalUrl: rawMeta.canonicalUrl,
      language: rawMeta.language,
      openGraph: rawMeta.openGraph,
      contentHash,
      byteSize: Buffer.byteLength(currentHtml, "utf-8"),
      isSpa,
      usedPlaywright,
    };

    return {
      url,
      normalizedUrl: url,
      title: metadata.title,
      markdown,
      metadata,
      outboundLinks,
      tookMs,
    };
  }
}
