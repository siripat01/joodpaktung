import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db/pool.js';

type CommittedEvent = {
  id: string; order_id: string; event_name: string; payload: Record<string, unknown>;
  occurred_at: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function cursorExists(id: string): Promise<boolean> {
  const result = await getPool().query('SELECT 1 FROM domain_events WHERE id = $1::uuid', [id]);
  return result.rowCount === 1;
}

async function eventsAfter(lastEventId?: string): Promise<CommittedEvent[]> {
  const result = await getPool().query<CommittedEvent>(`
    SELECT e.id::text, e.order_id::text, e.event_name, e.payload, e.occurred_at
      FROM domain_events e
     WHERE $1::uuid IS NULL OR (e.occurred_at, e.id) >
       (SELECT occurred_at, id FROM domain_events WHERE id = $1::uuid)
     ORDER BY e.occurred_at, e.id
     LIMIT 500
  `, [lastEventId ?? null]);
  return result.rows;
}

function encode(event: CommittedEvent): string {
  const data = JSON.stringify({
    orderId: event.order_id,
    state: event.payload.resultingState,
    domainEvent: event.event_name,
    payload: event.payload,
    occurredAt: event.occurred_at.toISOString()
  });
  return `id: ${event.id}\nevent: order.updated\ndata: ${data}\n\n`;
}

export async function startSse(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const traceId = randomUUID();
  const header = request.headers['last-event-id'];
  if (header !== undefined && (typeof header !== 'string' || !UUID.test(header))) {
    request.log.info({ event: 'sse_connection_rejected', trace_id: traceId, request_id: request.id,
      outcome: 'invalid_cursor' });
    await reply.code(400).send({ error: 'invalid_last_event_id' });
    return;
  }
  let cursor = typeof header === 'string' ? header : undefined;
  let knownCursor = true;
  try {
    knownCursor = !cursor || await cursorExists(cursor);
  } catch (error) {
    request.log.error({ event: 'sse_connection_failed', trace_id: traceId, request_id: request.id,
      last_event_id: cursor, outcome: 'failed', error_type: error instanceof Error ? error.name : 'unknown' });
    await reply.code(503).send({ error: 'event_stream_unavailable' });
    return;
  }
  if (!knownCursor) {
    request.log.info({ event: 'sse_connection_rejected', trace_id: traceId, request_id: request.id,
      last_event_id: cursor, outcome: 'unknown_cursor' });
    await reply.code(404).send({ error: 'unknown_last_event_id' });
    return;
  }

  request.log.info({ event: cursor ? 'sse_reconnected' : 'sse_connected', trace_id: traceId,
    request_id: request.id, ...(cursor ? { last_event_id: cursor } : {}), outcome: 'connected' });
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  reply.raw.flushHeaders();

  let busy = false;
  const poll = async () => {
    if (busy || reply.raw.destroyed) return;
    busy = true;
    try {
      for (const event of await eventsAfter(cursor)) {
        reply.raw.write(encode(event));
        cursor = event.id;
        request.log.info({ event: 'sse_event_delivered', trace_id: traceId, request_id: request.id,
          event_id: event.id, order_id: event.order_id, domain_event: event.event_name, outcome: 'delivered' });
      }
    } catch (error) {
      request.log.error({ event: 'sse_delivery_failed', trace_id: traceId, request_id: request.id,
        last_event_id: cursor, outcome: 'failed', error_type: error instanceof Error ? error.name : 'unknown' });
    } finally {
      busy = false;
    }
  };
  await poll();
  const interval = setInterval(() => void poll(), 100);
  const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
  reply.raw.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
    request.log.info({ event: 'sse_closed', trace_id: traceId, request_id: request.id,
      last_event_id: cursor, outcome: 'closed' });
  });
}
