export type DnsLookupFn = (hostname: string) => Promise<string[]>;

export interface UrlValidationOptions {
  dnsLookup?: DnsLookupFn | undefined;
  /**
   * WARNING: Setting this to true disables SSRF protections and permits connections
   * to loopback, private, link-local, and reserved IP ranges.
   * NEVER enable this for untrusted user-supplied URLs.
   */
  allowPrivateNetworks?: boolean | undefined;
  allowedProtocols?: Array<"http:" | "https:"> | undefined;
}

export interface ValidatedUrl {
  originalUrl: string;
  canonicalUrl: string;
  parsedUrl: URL;
  resolvedIps: string[];
}

export interface IpCheckResult {
  isBlocked: boolean;
  reason?: string | undefined;
  ip: string;
  normalizedIp?: string | undefined;
}
