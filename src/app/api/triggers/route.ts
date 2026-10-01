/**
 * /api/triggers (and /triggers via rewrites)
 * GET: Lists active search monitoring triggers
 * POST: Creates a new search monitor trigger
 */

import { NextRequest, NextResponse } from 'next/server';
import { defaultTriggerService } from '@/search/services/trigger.service';

export const dynamic = 'force-dynamic';

export async function GET() {
  const triggers = defaultTriggerService.listTriggers();
  return NextResponse.json(
    { triggers, total: triggers.length },
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}

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

    const { query, frequency, interval_minutes, search_depth } = body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json(
        { status: 'error', message: 'The "query" field is required.' },
        { status: 400 }
      );
    }

    const trigger = defaultTriggerService.createTrigger({
      query: query.trim(),
      frequency,
      interval_minutes,
      search_depth,
    });

    // Execute first run immediately in the background so it captures an initial baseline
    defaultTriggerService.executeTrigger(trigger.id).catch(() => {});

    return NextResponse.json(trigger, {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { status: 'error', message: err.message || 'Failed to create trigger' },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
