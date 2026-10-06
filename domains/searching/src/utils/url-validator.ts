export function isValidUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    const parsed = new URL(value.trim());
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      return false;
    }
    return Boolean(parsed.hostname && parsed.hostname.length > 0);
  } catch {
    return false;
  }
}

export function canonicalizeUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr.trim());
    // Lowercase the protocol and host
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.host = parsed.host.toLowerCase();

    // Strip trailing slash if present (e.g. /docs/ -> /docs)
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");

    return parsed.toString();
  } catch {
    return urlStr.trim();
  }
}
