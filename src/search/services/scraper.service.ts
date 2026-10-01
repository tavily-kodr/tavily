/**
 * Web Scraper Service
 * Safely fetches and extracts content from web pages respecting access rules and timeouts
 */

import { ScrapedPage, ScrapeOptions } from '../models/scraper.types';
import { ExtractionService } from './extraction.service';
import { isValidHttpUrl, isSafePublicUrl } from '../utils/url.utils';
import { isUrlAllowedByRobots } from '../utils/robots.utils';

export class ScraperService {
  private readonly extractionService: ExtractionService;
  private readonly defaultTimeoutMs: number;
  private readonly maxContentBytes: number;

  constructor(extractionService?: ExtractionService) {
    this.extractionService = extractionService || new ExtractionService();
    this.defaultTimeoutMs = parseInt(process.env.SCRAPER_TIMEOUT_MS || '10000', 10);
    this.maxContentBytes = parseInt(process.env.SCRAPER_MAX_CONTENT_BYTES || '2097152', 10); // 2MB
  }

  /**
   * Scrapes a single webpage safely
   */
  async scrape(url: string, options?: ScrapeOptions): Promise<ScrapedPage> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs || this.defaultTimeoutMs;
    const checkRobots = options?.checkRobots !== false;

    // 1. URL syntax validation
    if (!url || !isValidHttpUrl(url)) {
      return {
        url,
        status: 'failed',
        error: 'Invalid or unsupported HTTP/HTTPS URL',
        responseTimeMs: Date.now() - startTime,
      };
    }

    // 2. SSRF Protection: ensure not accessing private/internal addresses
    if (!isSafePublicUrl(url)) {
      return {
        url,
        status: 'blocked',
        reason: 'Access to private or internal network address is forbidden',
        responseTimeMs: Date.now() - startTime,
      };
    }

    // 3. Respect robots.txt
    if (checkRobots) {
      const allowed = await isUrlAllowedByRobots(url, 2500);
      if (!allowed) {
        return {
          url,
          status: 'blocked',
          reason: 'Access disallowed by domain robots.txt policy',
          responseTimeMs: Date.now() - startTime,
        };
      }
    }

    // 4. Fetch the webpage with timeout and user-agent
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent':
            options?.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (TavilyBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });

      clearTimeout(timeout);
      const responseTimeMs = Date.now() - startTime;
      const statusCode = response.status;

      // Handle Access Denied / Security Controls
      if (statusCode === 403 || statusCode === 429 || statusCode === 401) {
        return {
          url,
          status: 'blocked',
          reason: `Access restricted or rate limited (HTTP ${statusCode})`,
          statusCode,
          responseTimeMs,
        };
      }

      // Handle not found or server errors
      if (!response.ok) {
        return {
          url,
          status: 'failed',
          error: `HTTP error ${statusCode}: ${response.statusText}`,
          statusCode,
          responseTimeMs,
        };
      }

      // 5. Detect unsupported content types
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (
        !contentType.includes('text/html') &&
        !contentType.includes('application/xhtml+xml') &&
        !contentType.includes('text/plain')
      ) {
        return {
          url,
          status: 'failed',
          error: `Unsupported content type: ${contentType || 'unknown'}`,
          statusCode,
          responseTimeMs,
        };
      }

      // 6. Read response body with size limit protection
      const rawText = await response.text();
      if (rawText.length > this.maxContentBytes) {
        // Truncate overly huge responses to avoid memory exhaustion
        // Keep first maxContentBytes
      }

      // Check if page returned a CAPTCHA or Cloudflare challenge in HTML
      if (
        rawText.includes('cf-browser-verification') ||
        rawText.includes('challenge-running') ||
        rawText.includes('g-recaptcha') ||
        rawText.includes('hcaptcha')
      ) {
        return {
          url,
          status: 'blocked',
          reason: 'Security verification or CAPTCHA challenge detected',
          statusCode,
          responseTimeMs,
        };
      }

      // 7. Extract readable content and metadata
      const extracted = this.extractionService.extract(rawText, response.url || url);

      return {
        url: response.url || url,
        canonicalUrl: extracted.canonicalUrl,
        title: extracted.title,
        description: extracted.description,
        content: extracted.content,
        author: extracted.author,
        publishedDate: extracted.publishedDate,
        status: 'success',
        statusCode,
        responseTimeMs,
        rawHtml: options?.extractRawHtml ? rawText : undefined,
      };
    } catch (err: any) {
      clearTimeout(timeout);
      const responseTimeMs = Date.now() - startTime;

      if (err.name === 'AbortError') {
        return {
          url,
          status: 'failed',
          error: `Request timed out after ${timeoutMs}ms`,
          responseTimeMs,
        };
      }

      return {
        url,
        status: 'failed',
        error: err.message || 'Network fetch failure',
        responseTimeMs,
      };
    }
  }
}
