import type { DnsLookupFn } from "./url.types.js";

export interface ExtractedHtml {
  title: string;
  description: string | undefined;
  canonicalUrl: string | undefined;
  language: string | undefined;
  text: string;
  links: string[];
}

export interface HtmlExtractionOptions {
  /**
   * If true, boilerplate content inside <nav>, <header>, <footer>, and <aside>
   * will be included in the extracted text. Default is false (excluded).
   */
  includeBoilerplate?: boolean | undefined;
}

export type HttpTransportFn = (options: HttpRequestContext) => Promise<FetchedHttpResponse>;

export interface HttpRequestContext {
  url: string;
  parsedUrl: URL;
  pinnedIp: string;
  timeoutMs: number;
  maxSizeBytes: number;
  headers: Record<string, string>;
  signal?: AbortSignal | undefined;
}

export interface HttpFetchOptions {
  /** Maximum time in milliseconds to wait for the request to complete. Default 10000ms. */
  timeoutMs?: number | undefined;
  /** Maximum response body size in bytes while streaming. Default 2MB (2097152 bytes). */
  maxSizeBytes?: number | undefined;
  /** Maximum number of redirects to follow. Default 5. */
  maxRedirects?: number | undefined;
  /** Allowed MIME content types. Default ["text/html", "application/xhtml+xml"]. */
  allowedContentTypes?: string[] | undefined;
  /** Custom DNS lookup function (primarily for mocking / testing). */
  dnsLookup?: DnsLookupFn | undefined;
  /**
   * WARNING: Setting this to true disables SSRF protections and permits connections
   * to loopback, private, link-local, and reserved IP ranges.
   * NEVER enable this for untrusted user-supplied URLs.
   */
  allowPrivateNetworks?: boolean | undefined;
  /** Custom request headers to include. */
  headers?: Record<string, string> | undefined;
  /** Optional custom transport for injected testing. */
  transport?: HttpTransportFn | undefined;
  /** Optional AbortSignal to cancel in-flight HTTP request. */
  signal?: AbortSignal | undefined;
}

export interface FetchedHttpResponse {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  body: string;
  resolvedIp: string;
  headers: Record<string, string>;
}

export interface ScrapeOptions extends HttpFetchOptions {
  /** If true, includes header/footer/nav boilerplate in readable text. Default false. */
  includeBoilerplate?: boolean | undefined;
}

export interface ScrapedPageResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  title: string;
  description: string | undefined;
  canonicalUrl: string | undefined;
  language: string | undefined;
  text: string;
  links: string[];
  tookMs: number;
  resolvedIp: string;
}
