import type { ExtractionRule, ScrapeMode } from '../core/types.js';
import { getJsonPath, parseJson } from '../parsers/json.js';
import { extractHtml, loadHtml, type CheerioAPI, type HtmlParser } from '../parsers/html.js';

/**
 * A page body parsed exactly once. The scraper builds this after mode
 * detection and hands the same instance to extraction and pagination so a
 * large HTML document or JSON payload is not re-parsed per step.
 */
export type ParsedPage =
  | { mode: 'json'; root: unknown }
  | { mode: 'html'; $: CheerioAPI };

export interface ParseOptions {
  /** HTML parser backend (default: `parse5`). See `HtmlParser`. */
  htmlParser?: HtmlParser;
}

/** Parses a body according to the resolved mode. Throws on invalid JSON. */
export function parsePage(body: string, mode: Exclude<ScrapeMode, 'auto'>, options: ParseOptions = {}): ParsedPage {
  return mode === 'json'
    ? { mode: 'json', root: parseJson(body) }
    : { mode: 'html', $: loadHtml(body, options.htmlParser) };
}

/**
 * Extracts an array of items from an already-parsed page.
 *
 * - JSON mode: follows the optional dot-path; a non-array value becomes a single item.
 * - HTML mode: delegates to `extractHtml`.
 */
export function extractFromPage(page: ParsedPage, rule?: ExtractionRule): unknown[] {
  if (page.mode === 'json') {
    const value = getJsonPath(page.root, rule?.path);

    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  }

  return extractHtml(page.$, rule);
}

/** Convenience: parses `body` and extracts in one step. */
export function extractItems(
  body: string,
  mode: Exclude<ScrapeMode, 'auto'>,
  rule?: ExtractionRule,
  options?: ParseOptions,
): unknown[] {
  return extractFromPage(parsePage(body, mode, options), rule);
}
