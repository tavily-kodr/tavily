import net from "node:net";
import {
  isValidUrlSyntax,
  canonicalizeUrl as scrapingCanonicalizeUrl,
  isBlockedHostname as scrapingIsBlockedHostname,
  checkIpAddress,
} from "@tavily/scraping";

export function isValidUrl(value: unknown): value is string {
  return isValidUrlSyntax(value);
}

export function canonicalizeUrl(urlStr: string): string {
  return scrapingCanonicalizeUrl(urlStr);
}

export function isBlockedHostname(hostname: string): boolean {
  if (net.isIP(hostname)) {
    return checkIpAddress(hostname).isBlocked;
  }
  return scrapingIsBlockedHostname(hostname).blocked;
}
