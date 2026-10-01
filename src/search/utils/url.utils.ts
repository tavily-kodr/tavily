/**
 * URL Utilities for Normalization, Validation, and Filtering
 */

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'ref',
  'source',
  'spJobID',
  'spReportId',
  'igshid',
]);

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fe80::/i,
  /^fc00::/i,
];

/**
 * Validates whether a string is a valid HTTP/HTTPS URL
 */
export function isValidHttpUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * SSRF protection: ensures the host is not a private/internal network
 */
export function isSafePublicUrl(urlString: string): boolean {
  if (!isValidHttpUrl(urlString)) return false;
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname;
    for (const pattern of PRIVATE_HOST_PATTERNS) {
      if (pattern.test(hostname)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts and normalizes the domain from a URL (strips www.)
 */
export function extractDomain(urlString: string): string {
  try {
    const parsed = new URL(urlString);
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    return hostname;
  } catch {
    return '';
  }
}

/**
 * Normalizes a URL for deduplication:
 * - standardizes protocol to https where appropriate
 * - lowercases hostname and strips www.
 * - removes tracking query parameters
 * - sorts remaining query parameters
 * - strips trailing slash
 * - removes hash fragment
 */
export function normalizeUrl(urlString: string): string {
  try {
    const parsed = new URL(urlString);
    
    // Lowercase hostname and strip www
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }

    // Clean query parameters
    const cleanParams = new URLSearchParams();
    const sortedKeys = Array.from(parsed.searchParams.keys()).sort();
    
    for (const key of sortedKeys) {
      if (!TRACKING_PARAMS.has(key.toLowerCase())) {
        const values = parsed.searchParams.getAll(key);
        for (const val of values) {
          cleanParams.append(key, val);
        }
      }
    }

    // Clean pathname: normalize trailing slash
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    const search = cleanParams.toString();
    const queryString = search ? `?${search}` : '';

    return `${parsed.protocol}//${hostname}${pathname}${queryString}`;
  } catch {
    return urlString.trim();
  }
}

/**
 * Checks if two URLs point to the same resource
 */
export function isSameUrl(urlA: string, urlB: string): boolean {
  return normalizeUrl(urlA) === normalizeUrl(urlB);
}

/**
 * Matches domain against include and exclude filters
 */
export function matchesDomainFilter(
  urlOrDomain: string,
  includeDomains?: string[],
  excludeDomains?: string[]
): boolean {
  const domain = urlOrDomain.includes('://') ? extractDomain(urlOrDomain) : urlOrDomain.toLowerCase().replace(/^www\./, '');

  if (!domain) return false;

  // Check exclude domains first
  if (excludeDomains && excludeDomains.length > 0) {
    for (const rawExcluded of excludeDomains) {
      const excluded = rawExcluded.toLowerCase().trim().replace(/^www\./, '');
      if (domain === excluded || domain.endsWith(`.${excluded}`)) {
        return false;
      }
    }
  }

  // Check include domains if specified
  if (includeDomains && includeDomains.length > 0) {
    let matched = false;
    for (const rawIncluded of includeDomains) {
      const included = rawIncluded.toLowerCase().trim().replace(/^www\./, '');
      if (domain === included || domain.endsWith(`.${included}`)) {
        matched = true;
        break;
      }
    }
    return matched;
  }

  return true;
}
