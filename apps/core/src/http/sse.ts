import { gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDatabase } from '../db/pool.js';
import { domainEvents } from '../db/schema.js';

export type CommittedEvent = {
  id: number;
  orderId: string;
  eventName: string;
  payload: Record<string, unknown>;
};

export function parseEventCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('invalid event cursor');
  }
  return Number(value);
}

export function formatSseEvent(event: CommittedEvent): string {
  return `id: ${event.id}\nevent: order.updated\ndata: ${JSON.stringify({
    eventId: event.id, orderId: event.orderId, name: event.eventName, outcome: event.payload.outcome
  })}\n\n`;
}

export async function eventsAfter(cursor: number): Promise<CommittedEvent[]> {
  const rows = await getDatabase().select({
    id: domainEvents.sequence,
    orderId: domainEvents.orderId,
    eventName: domainEvents.eventName,
    payload: domainEvents.payload
  }).from(domainEvents).where(gt(domainEvents.sequence, cursor)).orderBy(domainEvents.sequence).limit(200);
  return rows;
}

export function registerSseRoute(app: FastifyInstance, readEvents = eventsAfter): void {
  app.get('/events', async (request, reply) => {
    let cursor: number;
    try {
      cursor = parseEventCursor(request.headers['last-event-id'] ?? (request.query as Record<string, unknown>).after);
    } catch {
      return reply.code(400).send({ error: 'invalid_event_cursor' });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    let busy = false;
    const poll = async () => {
      if (busy || reply.raw.destroyed) return;
      busy = true;
      try {
        for (const event of await readEvents(cursor)) {
          reply.raw.write(formatSseEvent(event));
          cursor = event.id;
        }
      } catch (error) {
        request.log.error({ event: 'sse_poll_failed', request_id: request.id, error_type: error instanceof Error ? error.name : 'unknown' });
        reply.raw.end();
      } finally {
        busy = false;
      }
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, 500);
    reply.raw.on('close', () => clearInterval(interval));
  });
}
