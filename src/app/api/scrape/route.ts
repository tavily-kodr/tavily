/**
 * POST /api/scrape (and /scrape via rewrites)
 * Standalone Web Scraper API endpoint
 */

import { NextRequest, NextResponse } from 'next/server';
import { ScraperService } from '@/search/services/scraper.service';
import { isValidHttpUrl } from '@/search/utils/url.utils';

export const dynamic = 'force-dynamic';

const scraperService = new ScraperService();

export async function POST(req: NextRequest) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { status: 'failed', error: 'Invalid JSON request body.' },
        { status: 400 }
      );
    }

    const { url, extract_raw_html, timeout_ms } = body;

    if (!url || typeof url !== 'string' || !isValidHttpUrl(url)) {
      return NextResponse.json(
        { status: 'failed', error: 'The "url" field is required and must be a valid HTTP/HTTPS URL.' },
        { status: 400 }
      );
    }

    const scraped = await scraperService.scrape(url, {
      extractRawHtml: !!extract_raw_html,
      timeoutMs: typeof timeout_ms === 'number' ? timeout_ms : undefined,
    });

    return NextResponse.json(scraped, {
      status: scraped.status === 'success' ? 200 : scraped.status === 'blocked' ? 403 : 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        status: 'failed',
        error: err.message || 'Internal server error while scraping URL',
      },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
