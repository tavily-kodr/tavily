/**
 * Custom Next.js + WebSocket Server
 * Enables simultaneous Next.js request handling and native WebSockets for real-time triggers
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { eventBus } from './search/services/event-bus.service';
import { defaultTriggerService } from './search/services/trigger.service';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function bootstrap() {
  await app.prepare();

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error handling request:', err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  // Attach WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Tavily Search Engine WebSocket Connected' }));

    ws.on('message', (message: string) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
        }
      } catch {
        // ignore non-json messages
      }
    });
  });

  // Broadcast search trigger changes to all connected WebSocket clients
  eventBus.subscribe('SEARCH_UPDATE', (data) => {
    const payload = JSON.stringify({ type: 'SEARCH_UPDATE', ...data });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  });

  // Start real-time trigger scheduler
  defaultTriggerService.startScheduler(60000);

  server.listen(port, () => {
    console.log(`> Tavily Search Engine ready on http://${hostname}:${port}`);
    console.log(`> WebSockets ready on ws://${hostname}:${port}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
