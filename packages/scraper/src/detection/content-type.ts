import type { ScrapeMode, PageDocument } from '../core/types.js';

/**
 * Determines whether a fetched document should be treated as JSON or HTML.
 *
 * When `requested` is 'auto' (the default), the function inspects the
 * Content-Type header first, then falls back to sniffing the body.
 */
export function detectMode(
  document: Pick<PageDocument, 'contentType' | 'body'>,
  requested: ScrapeMode = 'auto',
): 'json' | 'html' {
  if (requested !== 'auto') return requested;

  const contentType = document.contentType.toLowerCase();

  // Explicit JSON content type wins immediately.
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    return 'json';
  }

  // Heuristic: if the body looks like JSON, try to parse it.
  const trimmed = document.body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON – fall through to HTML.
    }
  }

  return 'html';
}
