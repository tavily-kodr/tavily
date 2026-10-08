/**
 * POST /api/search
 * Web application search orchestration endpoint
 */

import { NextRequest, NextResponse } from 'next/server';
import { defaultSearchService, SearchOptions } from '@tavily/searching';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { status: 'error', message: 'Invalid JSON request body.' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { status: 'error', message: 'Request body must be a JSON object.' },
        { status: 400 }
      );
    }

    const {
      query,
      search_depth,
      max_results,
      include_domains,
      exclude_domains,
      include_answer,
      include_raw_content,
      time_range,
      topic,
    } = body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json(
        { status: 'error', message: 'The "query" field is required and must be a non-empty string.' },
        { status: 400 }
      );
    }

    if (search_depth && search_depth !== 'basic' && search_depth !== 'advanced') {
      return NextResponse.json(
        { status: 'error', message: 'The "search_depth" field must be either "basic" or "advanced".' },
        { status: 400 }
      );
    }

    if (time_range && !['day', 'week', 'month', 'year'].includes(time_range)) {
      return NextResponse.json(
        { status: 'error', message: 'The "time_range" field must be one of: "day", "week", "month", "year".' },
        { status: 400 }
      );
    }

    const options: Partial<SearchOptions> = {
      query: query.trim(),
      search_depth: search_depth || 'basic',
      max_results: typeof max_results === 'number' ? max_results : 10,
      include_domains: Array.isArray(include_domains) ? include_domains : [],
      exclude_domains: Array.isArray(exclude_domains) ? exclude_domains : [],
      include_answer: include_answer !== undefined ? !!include_answer : true,
      include_raw_content: !!include_raw_content,
      time_range,
      topic: topic || 'general',
    };

    const response = await defaultSearchService.search(options.query!, options);

    return NextResponse.json(response, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Response-Time': `${response.response_time}s`,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        status: 'error',
        message: err.message || 'Internal server error while executing search',
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
