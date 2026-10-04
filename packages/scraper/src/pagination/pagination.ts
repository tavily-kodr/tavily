import { getJsonPath, parseJson } from '../parsers/json.js';
import { extractNextLink } from '../parsers/html.js';
import type { ParsedPage } from '../extraction/extract.js';
import type { PaginationConfig } from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface NextPageInfo {
  nextUrl: string | null;
  nextCursor: string | null;
}

/** Sentinel returned when there is no next page. */
const NO_NEXT: NextPageInfo = { nextUrl: null, nextCursor: null };

/** URL schemes we must never follow as pagination links. */
const IGNORED_SCHEMES = ['javascript:', 'mailto:', 'data:', 'blob:'];

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Normalises the first URL of a paginated target.
 *
 * In `page` mode the start page (and page size, when configured) are made
 * explicit on the first request unless the URL already carries them. Without
 * this, `startPage`/`pageSize` would only take effect from the second page.
 * Other modes return the URL unchanged.
 */
export function getInitialPageUrl(url: string, config?: PaginationConfig): string {
  if (config?.mode !== 'page' && config?.mode !== 'offset') return url;

  const parsed = new URL(url);
  const param = config.mode === 'page' ? (config.pageParam ?? 'page') : (config.offsetParam ?? 'offset');
  const start = config.mode === 'page' ? (config.startPage ?? 1) : (config.startOffset ?? 0);

  if (!parsed.searchParams.has(param)) {
    parsed.searchParams.set(param, String(start));
  }
  if (config.pageSizeParam && config.pageSize !== undefined && !parsed.searchParams.has(config.pageSizeParam)) {
    parsed.searchParams.set(config.pageSizeParam, String(config.pageSize));
  }

  return parsed.toString();
}

/**
 * Determines the next-page URL (if any) based on the pagination strategy.
 *
 * `source` may be the raw body (in which case `contentType` is used to decide
 * between HTML and JSON) or a `ParsedPage` produced by `parsePage`, which
 * avoids re-parsing a document the scraper has already parsed.
 */
export function getNextPageInfo(
  source: string | ParsedPage,
  contentType: string,
  config: PaginationConfig,
  currentUrl: string,
  itemCount = 0,
): NextPageInfo {
  switch (config.mode) {
    case 'none':
      return NO_NEXT;

    case 'page':
      return resolvePagePagination(config, currentUrl, itemCount);

    case 'offset':
      return resolveOffsetPagination(config, currentUrl, itemCount);

    case 'next-link':
      return resolveNextLinkPagination(source, contentType, config, currentUrl);

    case 'cursor':
      return resolveCursorPagination(source, config, currentUrl);
  }
}

// ─── Strategy Implementations ─────────────────────────────────────────

function resolvePagePagination(
  config: PaginationConfig,
  currentUrl: string,
  itemCount: number,
): NextPageInfo {
  if (config.stopWhenEmpty !== false && itemCount === 0) return NO_NEXT;

  const pageParam = config.pageParam ?? 'page';
  const raw = new URL(currentUrl).searchParams.get(pageParam);
  const parsed = raw !== null ? Number(raw) : NaN;
  const currentPage = Number.isFinite(parsed) ? parsed : (config.startPage ?? 1);

  return {
    nextUrl: buildPageUrl(currentUrl, pageParam, currentPage + 1, config.pageSizeParam, config.pageSize),
    nextCursor: null,
  };
}

/**
 * Offset pagination: the next request asks for items starting at
 * `offset + pageSize` (or `offset + itemCount` when no page size is
 * configured). A short page (`itemCount < pageSize`) is treated as the last.
 */
function resolveOffsetPagination(
  config: PaginationConfig,
  currentUrl: string,
  itemCount: number,
): NextPageInfo {
  if (config.stopWhenEmpty !== false && itemCount === 0) return NO_NEXT;
  if (config.pageSize !== undefined && itemCount < config.pageSize) return NO_NEXT;

  const offsetParam = config.offsetParam ?? 'offset';
  const raw = new URL(currentUrl).searchParams.get(offsetParam);
  const parsed = raw !== null ? Number(raw) : NaN;
  const currentOffset = Number.isFinite(parsed) ? parsed : (config.startOffset ?? 0);
  const step = config.pageSize ?? itemCount;
  if (step <= 0) return NO_NEXT;

  return {
    nextUrl: buildPageUrl(currentUrl, offsetParam, currentOffset + step, config.pageSizeParam, config.pageSize),
    nextCursor: null,
  };
}

function resolveNextLinkPagination(
  source: string | ParsedPage,
  contentType: string,
  config: PaginationConfig,
  currentUrl: string,
): NextPageInfo {
  const nextPath = config.nextPath ?? 'next';

  let next: unknown;
  try {
    if (typeof source === 'string') {
      const lowerCt = contentType.toLowerCase();
      const isHtml = lowerCt.includes('html')
        || (!lowerCt.includes('json') && source.trimStart().startsWith('<'));
      next = isHtml ? extractNextLink(source) : getJsonPath(parseJson(source), nextPath);
    } else {
      next = source.mode === 'html' ? extractNextLink(source.$) : getJsonPath(source.root, nextPath);
    }
  } catch {
    return NO_NEXT;
  }

  if (typeof next !== 'string' || next.length === 0) return NO_NEXT;
  if (IGNORED_SCHEMES.some((scheme) => next.startsWith(scheme))) return NO_NEXT;

  try {
    return { nextUrl: new URL(next, currentUrl).toString(), nextCursor: null };
  } catch {
    return NO_NEXT;
  }
}

function resolveCursorPagination(
  source: string | ParsedPage,
  config: PaginationConfig,
  currentUrl: string,
): NextPageInfo {
  let root: unknown;
  if (typeof source === 'string') {
    try {
      root = parseJson(source);
    } catch {
      return NO_NEXT;
    }
  } else if (source.mode === 'json') {
    root = source.root;
  } else {
    // Cursor pagination only makes sense for JSON responses.
    return NO_NEXT;
  }

  const cursor = getJsonPath(root, config.nextCursorPath ?? 'next_cursor');

  // Accept both string and numeric cursors.
  if ((typeof cursor !== 'string' && typeof cursor !== 'number') || String(cursor).length === 0) {
    return NO_NEXT;
  }

  const cursorStr = String(cursor);

  try {
    const url = new URL(currentUrl);
    url.searchParams.set(config.cursorParam ?? 'cursor', cursorStr);
    return { nextUrl: url.toString(), nextCursor: cursorStr };
  } catch {
    return NO_NEXT;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Returns `currentUrl` with the page (and optional page-size) parameter set. */
export function buildPageUrl(
  currentUrl: string,
  pageParam: string,
  page: number,
  sizeParam?: string,
  size?: number,
): string {
  const url = new URL(currentUrl);
  url.searchParams.set(pageParam, String(page));
  if (sizeParam && size !== undefined) {
    url.searchParams.set(sizeParam, String(size));
  }
  return url.toString();
}
