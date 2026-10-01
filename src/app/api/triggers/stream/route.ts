/**
 * GET /api/triggers/stream
 * Server-Sent Events (SSE) stream for real-time trigger change events
 */

import { NextRequest } from 'next/server';
import { eventBus } from '@/search/services/event-bus.service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to Tavily live trigger stream' })}\n\n`)
      );

      // Listen for SEARCH_UPDATE events
      unsubscribe = eventBus.subscribe('SEARCH_UPDATE', (data) => {
        try {
          const payload = `event: SEARCH_UPDATE\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Stream might be closed
        }
      });
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
