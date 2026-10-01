/**
 * /api/triggers/[id]
 * GET: Retrieve trigger status
 * POST: Manually trigger an immediate check
 * DELETE: Delete a trigger
 */

import { NextRequest, NextResponse } from 'next/server';
import { defaultTriggerService } from '@/search/services/trigger.service';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: { id: string };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const trigger = defaultTriggerService.getTrigger(params.id);
  if (!trigger) {
    return NextResponse.json({ status: 'error', message: 'Trigger not found' }, { status: 404 });
  }
  return NextResponse.json(trigger);
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const result = await defaultTriggerService.executeTrigger(params.id);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { status: 'error', message: err.message || 'Failed to execute trigger' },
      { status: err.message?.includes('not found') ? 404 : 500 }
    );
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const success = defaultTriggerService.deleteTrigger(params.id);
  if (!success) {
    return NextResponse.json({ status: 'error', message: 'Trigger not found' }, { status: 404 });
  }
  return NextResponse.json({ status: 'success', message: `Trigger ${params.id} deleted` });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
