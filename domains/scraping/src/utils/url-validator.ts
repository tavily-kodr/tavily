import { AppError } from "@tavily/errors";
import type { UrlValidationOptions, ValidatedUrl } from "../types/url.types.js";
import { resolveAndValidateHostname } from "./ssrf-guard.js";

const DEFAULT_ALLOWED_PROTOCOLS: Array<"http:" | "https:"> = ["http:", "https:"];

/**
 * Checks whether an unknown value is a valid HTTP or HTTPS URL string syntax.
 * Does not perform DNS resolution.
 */
export function isValidUrlSyntax(value: unknown): value is string {
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

/**
 * Canonicalizes a URL string:
 * - Lowercases protocol and hostname
 * - Removes default ports (80 for http, 443 for https)
 * - Strips trailing slashes on pathname (except root '/')
 * - Removes URL hash fragments
 */
export function canonicalizeUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr.trim());

    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();

    // Remove default ports
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }

    // Strip hash fragment
    parsed.hash = "";

    // Strip trailing slashes on pathname
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }

    return parsed.toString();
  } catch {
    return urlStr.trim();
  }
}

/**
 * Validates a URL for web scraping:
 * 1. Validates syntax and requires HTTP/HTTPS protocols
 * 2. Prohibits embedded credentials (user:password@host)
 * 3. Prohibits localhost and private naming schemes (.local, .internal, etc.)
 * 4. Resolves DNS and validates EVERY returned IP against private, loopback,
 *    link-local, cloud metadata, and unsafe ranges (SSRF protection)
 * 5. Returns canonicalized URL, parsed URL, and the array of verified safe IPs.
 */
export async function validateUrlForScraping(
  urlInput: unknown,
  options: UrlValidationOptions = {},
): Promise<ValidatedUrl> {
  if (typeof urlInput !== "string" || !urlInput.trim()) {
    throw new AppError("URL must be a non-empty string", {
      code: "INVALID_URL",
      statusCode: 400,
    });
  }

  const rawUrl = urlInput.trim();
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch (err: unknown) {
    throw new AppError(`Invalid URL syntax: '${rawUrl}'`, {
      code: "INVALID_URL",
      statusCode: 400,
      cause: err,
    });
  }

  // Enforce allowed protocols
  const allowedProtocols = options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
  const protocol = parsed.protocol.toLowerCase() as "http:" | "https:";

  if (!allowedProtocols.includes(protocol)) {
    throw new AppError(
      `Protocol '${parsed.protocol}' is not allowed. Permitted protocols: ${allowedProtocols.join(", ")}`,
      {
        code: "INVALID_URL",
        statusCode: 400,
        details: { protocol: parsed.protocol, allowedProtocols },
      },
    );
  }

  if (!parsed.hostname) {
    throw new AppError("URL hostname cannot be empty", {
      code: "INVALID_URL",
      statusCode: 400,
    });
  }

  // Reject credentials in URL to avoid URL parsing confusion and credentials leakage
  if (parsed.username || parsed.password) {
    throw new AppError("Credentials in URLs are not permitted", {
      code: "INVALID_URL",
      statusCode: 400,
      details: { hostname: parsed.hostname },
    });
  }

  // SSRF check & IP resolution: resolve and validate hostname and all returned IP addresses
  const resolvedIps = await resolveAndValidateHostname(parsed.hostname, options.dnsLookup, {
    allowPrivateNetworks: options.allowPrivateNetworks,
  });

  const canonicalUrl = canonicalizeUrl(parsed.toString());

  return {
    originalUrl: rawUrl,
    canonicalUrl,
    parsedUrl: parsed,
    resolvedIps,
  };
}

/**
 * Re-validates a redirect destination URL before following it.
 * Supports both relative redirects (resolved against currentUrl) and absolute redirects.
 * Strict SSRF protection is enforced on the resolved destination.
 */
export async function revalidateRedirectUrl(
  redirectLocation: string,
  currentUrl: string,
  options: UrlValidationOptions = {},
): Promise<ValidatedUrl> {
  if (typeof redirectLocation !== "string" || !redirectLocation.trim()) {
    throw new AppError("Redirect location must be a non-empty string", {
      code: "INVALID_REDIRECT",
      statusCode: 400,
    });
  }

  let resolvedTarget: URL;
  try {
    resolvedTarget = new URL(redirectLocation.trim(), currentUrl);
  } catch (err: unknown) {
    throw new AppError(
      `Failed to resolve redirect target '${redirectLocation}' against '${currentUrl}'`,
      {
        code: "INVALID_REDIRECT",
        statusCode: 400,
        cause: err,
      },
    );
  }

  return validateUrlForScraping(resolvedTarget.toString(), options);
}
