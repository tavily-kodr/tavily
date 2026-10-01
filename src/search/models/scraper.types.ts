/**
 * Scraper Models and Interfaces
 */

export type ScrapeStatus = 'success' | 'failed' | 'blocked';

export interface ScrapedPage {
  url: string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  content?: string;
  author?: string;
  publishedDate?: string | null;
  status: ScrapeStatus;
  error?: string;
  reason?: string;
  statusCode?: number;
  responseTimeMs?: number;
  rawHtml?: string;
}

export interface ScrapeOptions {
  timeoutMs?: number;
  maxContentBytes?: number;
  checkRobots?: boolean;
  userAgent?: string;
  extractRawHtml?: boolean;
}
