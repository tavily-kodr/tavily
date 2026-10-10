import type { CrawlItemState } from "./state.types.js";

export interface PageMetadata {
  title: string;
  description?: string | undefined;
  canonicalUrl?: string | undefined;
  language?: string | undefined;
  openGraph?: Record<string, string> | undefined;
  contentHash: string; // Deterministic SHA-256 of extracted markdown
  byteSize: number;
  isSpa: boolean;
  usedPlaywright: boolean;
}

export interface PageRecord {
  url: string;
  normalizedUrl: string;
  state: CrawlItemState;
  depth: number;
  statusCode?: number | undefined;
  metadata: PageMetadata;
  markdown: string;
  rawHtml?: string | undefined;
  outboundLinks: string[];
  error?:
    | {
        code: string;
        message: string;
        details?: unknown;
      }
    | undefined;
  tookMs: number;
  timestamp: string;
}

export interface ExtractResult {
  url: string;
  normalizedUrl: string;
  title: string;
  markdown: string;
  metadata: PageMetadata;
  outboundLinks: string[];
  tookMs: number;
}

export interface ExtractResponse {
  success: boolean;
  total: number;
  results: ExtractResult[];
  errors: Array<{
    url: string;
    code: string;
    message: string;
  }>;
  tookMs: number;
}

export interface CrawlStats {
  totalDiscovered: number;
  totalCrawled: number;
  totalFailed: number;
  totalSkipped: number;
  totalBytes: number;
  durationMs: number;
}

export interface StorageInfo {
  rootDir: string;
  crawlDir: string;
  manifestPath: string;
  combinedMarkdownPath: string;
  latestMarkdownPath: string;
  files: string[];
}

export interface CrawlResponse {
  success: boolean;
  crawlId: string;
  stats: CrawlStats;
  pages: PageRecord[];
  storageInfo?: StorageInfo | undefined;
}

export interface MapResponse {
  success: boolean;
  rootUrl: string;
  totalUrls: number;
  urls: string[];
  durationMs: number;
}
