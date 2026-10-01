/**
 * HTML Content Extraction Service
 * Cleans HTML noise and extracts readable text and structured metadata
 */

import * as cheerio from 'cheerio';
import { parseDateSafe } from '../utils/text.utils';

export interface ExtractedPageContent {
  title: string;
  description: string;
  content: string;
  author?: string;
  publishedDate: string | null;
  canonicalUrl?: string;
}

export class ExtractionService {
  /**
   * Extracts clean, readable text and structured metadata from raw HTML
   */
  extract(html: string, pageUrl: string): ExtractedPageContent {
    if (!html || !html.trim()) {
      return {
        title: '',
        description: '',
        content: '',
        publishedDate: null,
      };
    }

    const $ = cheerio.load(html);

    // 1. Extract metadata before removing elements
    const metadata = this.extractMetadata($, pageUrl);

    // 2. Remove non-content elements and boilerplate noise
    $(
      'script, style, noscript, iframe, svg, canvas, embed, object, ' +
      'nav, header, footer, aside, ' +
      '[role="banner"], [role="navigation"], [role="contentinfo"], ' +
      '.nav, .navbar, .menu, .footer, .header, .sidebar, ' +
      '.ad, .ads, .advertisement, .cookie, .cookie-banner, .modal, .popup, ' +
      '.newsletter, .subscribe, .social-share, .share-buttons, .comments'
    ).remove();

    // 3. Locate the primary content container if one exists
    let contentContainer = $('article, main, [role="main"], #content, .post-content, .article-content, .entry-content').first();
    if (!contentContainer.length) {
      contentContainer = $('body');
    }

    // 4. Transform structured elements into readable formatted text
    const blocks: string[] = [];

    contentContainer.find('h1, h2, h3, h4, h5, h6, p, ul, ol, dl, blockquote, pre, table').each((_, elem) => {
      const tag = elem.tagName.toLowerCase();
      const el = $(elem);

      // Skip elements that are nested inside already processed block elements (e.g., p inside blockquote)
      if (el.parents('p, ul, ol, dl, blockquote, pre, table').length > 0) {
        return;
      }

      if (/^h[1-6]$/.test(tag)) {
        const text = el.text().trim();
        if (text) {
          const level = parseInt(tag[1], 10);
          blocks.push(`${'#'.repeat(level)} ${text}`);
        }
      } else if (tag === 'p') {
        const text = el.text().trim();
        if (text.length > 10) {
          blocks.push(text);
        }
      } else if (tag === 'ul' || tag === 'ol') {
        const listItems: string[] = [];
        el.find('li').each((_, li) => {
          const itemText = $(li).text().trim();
          if (itemText) {
            listItems.push(`• ${itemText}`);
          }
        });
        if (listItems.length > 0) {
          blocks.push(listItems.join('\n'));
        }
      } else if (tag === 'table') {
        const rows: string[] = [];
        el.find('tr').each((_, tr) => {
          const cells: string[] = [];
          $(tr).find('th, td').each((_, cell) => {
            const cellText = $(cell).text().trim();
            if (cellText) cells.push(cellText);
          });
          if (cells.length > 0) {
            rows.push(cells.join(' | '));
          }
        });
        if (rows.length > 0) {
          blocks.push(rows.join('\n'));
        }
      } else if (tag === 'blockquote' || tag === 'pre') {
        const text = el.text().trim();
        if (text) {
          blocks.push(text);
        }
      }
    });

    let mainContent = blocks.join('\n\n');

    // Fallback: if block extraction yielded very little content, grab cleaned body text
    if (mainContent.length < 100) {
      mainContent = contentContainer.text().replace(/\s+/g, ' ').trim();
    }

    // Clean excessive blank lines and spaces
    mainContent = mainContent
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    return {
      title: metadata.title,
      description: metadata.description,
      content: mainContent,
      author: metadata.author,
      publishedDate: metadata.publishedDate,
      canonicalUrl: metadata.canonicalUrl,
    };
  }

  /**
   * Extracts page metadata from OpenGraph, Twitter cards, meta tags, and JSON-LD
   */
  private extractMetadata($: cheerio.CheerioAPI, pageUrl: string) {
    // Title
    const ogTitle = $('meta[property="og:title"]').attr('content');
    const twitterTitle = $('meta[name="twitter:title"]').attr('content');
    const docTitle = $('title').text().trim();
    const h1Title = $('h1').first().text().trim();
    const title = (ogTitle || twitterTitle || docTitle || h1Title || '').trim();

    // Description
    const metaDesc = $('meta[name="description"]').attr('content');
    const ogDesc = $('meta[property="og:description"]').attr('content');
    const twitterDesc = $('meta[name="twitter:description"]').attr('content');
    const description = (metaDesc || ogDesc || twitterDesc || '').trim();

    // Author
    const metaAuthor = $('meta[name="author"]').attr('content');
    const articleAuthor = $('meta[property="article:author"]').attr('content');
    const author = (metaAuthor || articleAuthor || '').trim() || undefined;

    // Canonical URL
    const canonical = $('link[rel="canonical"]').attr('href');
    const ogUrl = $('meta[property="og:url"]').attr('content');
    let canonicalUrl: string | undefined;
    try {
      const rawCanonical = canonical || ogUrl;
      if (rawCanonical) {
        canonicalUrl = new URL(rawCanonical, pageUrl).toString();
      }
    } catch {
      // ignore
    }

    // Published Date
    const metaDate =
      $('meta[property="article:published_time"]').attr('content') ||
      $('meta[name="publication_date"]').attr('content') ||
      $('meta[name="date"]').attr('content') ||
      $('meta[name="dc.date"]').attr('content') ||
      $('time[datetime]').first().attr('datetime');

    let publishedDate = parseDateSafe(metaDate);

    // If still null, try searching Schema.org JSON-LD
    if (!publishedDate) {
      $('script[type="application/ld+json"]').each((_, elem) => {
        if (publishedDate) return;
        try {
          const jsonText = $(elem).html() || '{}';
          const ld = JSON.parse(jsonText);
          const candidates = [ld.datePublished, ld.dateModified, ld.dateCreated];
          if (Array.isArray(ld['@graph'])) {
            for (const item of ld['@graph']) {
              if (item.datePublished) candidates.push(item.datePublished);
            }
          }
          for (const cand of candidates) {
            const parsed = parseDateSafe(cand);
            if (parsed) {
              publishedDate = parsed;
              break;
            }
          }
        } catch {
          // ignore malformed JSON-LD
        }
      });
    }

    return {
      title,
      description,
      author,
      canonicalUrl,
      publishedDate,
    };
  }
}
