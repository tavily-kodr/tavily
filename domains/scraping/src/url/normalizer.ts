import { InvalidUrlError } from "../types/error.types.js";

const TRACKING_QUERY_PREFIXES = [
  "utm_",
  "ga_",
  "ref_",
  "fbadid",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "wickedid",
  "yclid",
  "_openstat",
];

const TRACKING_QUERY_EXACT = new Set([
  "fb_action_ids",
  "fb_action_types",
  "fb_source",
  "fb_ref",
  "action_object_map",
  "action_type_map",
  "action_ref_map",
  "spm",
]);

function isTrackingParam(key: string): boolean {
  const lowerKey = key.toLowerCase();
  if (TRACKING_QUERY_EXACT.has(lowerKey)) return true;
  return TRACKING_QUERY_PREFIXES.some((prefix) => lowerKey.startsWith(prefix));
}

/**
 * Normalizes a URL:
 * - Validates HTTP/HTTPS protocol
 * - Lowercases hostname
 * - Strips default ports (:80, :443)
 * - Strips fragments (#)
 * - Strips tracking query parameters (utm_*, gclid, fbclid, etc.)
 * - Alphabetically sorts remaining query parameters
 * - Strips trailing slash on paths (except root /)
 */
export function normalizeUrl(rawUrl: string, baseUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new InvalidUrlError(String(rawUrl), "URL cannot be empty");
  }

  let parsed: URL;
  try {
    parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch (err: unknown) {
    throw new InvalidUrlError(rawUrl, err instanceof Error ? err.message : "Malformed URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidUrlError(rawUrl, `Unsupported protocol '${parsed.protocol}'`);
  }

  // 1. Lowercase hostname
  parsed.hostname = parsed.hostname.toLowerCase();

  // 2. Strip default ports
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }

  // 3. Remove fragment / hash
  parsed.hash = "";

  // 4. Strip tracking parameters and sort remaining queries
  const cleanParams = new URLSearchParams();
  const sortedKeys = Array.from(parsed.searchParams.keys()).sort();

  for (const key of sortedKeys) {
    if (!isTrackingParam(key)) {
      const values = parsed.searchParams.getAll(key).sort();
      for (const val of values) {
        cleanParams.append(key, val);
      }
    }
  }

  // 5. Normalize pathname: remove duplicate slashes, strip trailing slash except root '/'
  let pathname = parsed.pathname.replace(/\/+/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  const queryPart = cleanParams.toString();
  return `${parsed.protocol}//${parsed.host}${pathname}${queryPart ? `?${queryPart}` : ""}`;
}

const IGNORED_SCHEMES = [
  "javascript:",
  "mailto:",
  "tel:",
  "sms:",
  "data:",
  "ftp:",
  "file:",
  "blob:",
  "whatsapp:",
  "#",
];

/**
 * Resolves a relative or candidate link against a base URL and normalizes it.
 * Discards non-HTTP schemes safely and returns null on failure.
 */
export function resolveAndNormalizeUrl(candidate: string, baseUrl: string): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  for (const scheme of IGNORED_SCHEMES) {
    if (lower.startsWith(scheme)) return null;
  }

  try {
    return normalizeUrl(trimmed, baseUrl);
  } catch {
    return null;
  }
}
