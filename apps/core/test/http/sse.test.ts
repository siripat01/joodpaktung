import { describe, expect, it } from 'vitest';
import { formatSseEvent, parseEventCursor } from '../../src/http/sse.js';
import { buildServer } from '../../src/server.js';

describe('committed SSE replay', () => {
  it('formats a committed event with a replayable ID', () => {
    expect(formatSseEvent({ id: 42, orderId: 'order-1', eventName: 'courier_pickup', payload: { outcome: 'processed' } }))
      .toBe('id: 42\nevent: order.updated\ndata: {"eventId":42,"orderId":"order-1","name":"courier_pickup","outcome":"processed"}\n\n');
  });

  it('accepts only nonnegative integer replay cursors', () => {
    expect(parseEventCursor('42')).toBe(42);
    expect(() => parseEventCursor('42x')).toThrow();
    expect(() => parseEventCursor('-1')).toThrow();
  });

  it('replays committed events after Last-Event-ID and advances the cursor', async () => {
    const cursors: number[] = [];
    const app = buildServer({ logger: false, readEvents: async (cursor) => {
      cursors.push(cursor);
      return cursor < 42 ? [{ id: 42, orderId: 'order-1', eventName: 'courier_pickup', payload: { outcome: 'processed' } }] : [];
    } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(`${address}/events`, { headers: { 'Last-Event-ID': '41' }, signal: controller.signal });
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain('id: 42');
      expect(cursors[0]).toBe(41);
    } finally {
      controller.abort();
      await app.close();
    }
  });
});
