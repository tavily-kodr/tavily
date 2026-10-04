import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { ExtractionRule } from '../core/types.js';

export type { CheerioAPI };

/**
 * HTML parser backend.
 *
 * - `parse5` (default): full HTML5 tree construction, browser-equivalent DOM
 *   (implied `<tbody>`, foster parenting, etc.).
 * - `htmlparser2`: forgiving streaming parser, roughly 25% faster on 10 KB
 *   pages and 2x faster on 200 KB pages in this repo's micro-benchmark, with
 *   lower heap churn. It does not apply HTML5 tree fixes, so selectors that
 *   rely on implied elements (e.g. `table > tbody > tr`) can behave differently.
 */
export type HtmlParser = 'parse5' | 'htmlparser2';

const HTMLPARSER2_OPTIONS = { xml: { xmlMode: false, decodeEntities: true } } as const;

/**
 * Default CSS selector for finding "next page" links.
 *
 * `rel` is a space-separated token list (e.g. `rel="nofollow next"`), so the
 * word-match operator `~=` is used rather than an exact match.
 */
const NEXT_LINK_SELECTOR = [
  'link[rel~="next" i]',
  'a[rel~="next" i]',
  'a.next',
  'a[aria-label*="next" i]',
].join(', ');

/** Parses an HTML body once so the document can be shared by extraction and pagination. */
export function loadHtml(body: string, parser: HtmlParser = 'parse5'): CheerioAPI {
  return parser === 'htmlparser2' ? cheerio.load(body, HTMLPARSER2_OPTIONS) : cheerio.load(body);
}

function toDocument(source: string | CheerioAPI): CheerioAPI {
  return typeof source === 'string' ? cheerio.load(source) : source;
}

/**
 * Extracts structured items from an HTML body (or an already-loaded document).
 *
 * - No selector → returns the full page as `{ html, text }`.
 * - Selector without fields → returns the text content of each match.
 * - Selector with fields → returns an object per match with named values.
 */
export function extractHtml(source: string | CheerioAPI, rule?: ExtractionRule): unknown[] {
  const $ = toDocument(source);

  if (!rule?.selector) {
    return [{ html: $.html(), text: $.root().text().trim() }];
  }

  const nodes = $(rule.selector).toArray();

  if (!rule.fields) {
    return nodes.map((node) => $(node).text().trim());
  }

  return nodes.map((node) => {
    const output: Record<string, unknown> = {};

    for (const [name, field] of Object.entries(rule.fields ?? {})) {
      const target = field.selector
        ? $(node).find(field.selector).first()
        : $(node).first();

      output[name] = field.attribute
        ? (target.attr(field.attribute) ?? null)
        : target.text().trim();
    }

    return output;
  });
}

/**
 * Finds the first "next page" link in an HTML document (or loaded document).
 * Returns the `href` attribute value, or `null` if none is found.
 */
export function extractNextLink(
  source: string | CheerioAPI,
  selector: string = NEXT_LINK_SELECTOR,
): string | null {
  const $ = toDocument(source);
  return $(selector).first().attr('href') ?? null;
}
