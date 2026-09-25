import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { buildServer } from '../../src/server.js';
import { databaseUrl, ensureTestDatabase } from '../integration/database.js';

const execFileAsync = promisify(execFile);
const root = new URL('../../../../', import.meta.url).pathname;
const orderId = '00000000-0000-4000-8000-000000000100';

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let value = '';
  while (!value.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('SSE ended before an event');
    value += decoder.decode(chunk.value, { stream: true });
  }
  return value;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let value = '';
  while (!value.includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`SSE ended before ${marker}`);
    value += decoder.decode(chunk.value, { stream: true });
  }
  return value;
}

describe('committed SSE', () => {
  beforeAll(async () => {
    await ensureTestDatabase();
    await execFileAsync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl } });
  });
  beforeEach(async () => {
    await execFileAsync(process.execPath, ['scripts/reset-fixture.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl } });
  });
  afterAll(closePool);

  it('streams after commit and replays after Last-Event-ID', async () => {
    const logs: string[] = [];
    const app = buildServer({ logger: true, loggerStream: { write: (line) => logs.push(line) } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    const stream = await fetch(`${address}/events`, { signal: abort.signal });
    const reader = stream.body!.getReader();
    await fetch(`${address}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      type: 'seller_accepted_and_funded', orderId, eventKey: 'sse-fund'
    }) });
    const first = await nextEvent(reader);
    expect(first).toContain('event: order.updated');
    expect(first).toContain('"state":"Reserved"');
    const id = /^id: (.+)$/m.exec(first)?.[1];
    expect(id).toBeTruthy();
    abort.abort();

    await fetch(`${address}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      type: 'buyer_disputed', orderId, eventKey: 'sse-dispute'
    }) });
    const replayAbort = new AbortController();
    const replay = await fetch(`${address}/events`, { headers: { 'last-event-id': id! }, signal: replayAbort.signal });
    const replayReader = replay.body!.getReader();
    const replayed = await nextEvent(replayReader);
    expect(replayed).toContain('sse-dispute');
    expect(replayed).toContain('"state":"Disputed"');
    expect(replayed).not.toContain('sse-fund');

    await fetch(`${address}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      type: 'operations_resolve_refund', orderId, eventKey: 'sse-future', evidenceRef: 'ops-case-1'
    }) });
    const future = await nextEvent(replayReader);
    expect(future).toContain('sse-future');
    replayAbort.abort();

    const historyAbort = new AbortController();
    const history = await fetch(`${address}/events`, { signal: historyAbort.signal });
    const historical = await readUntil(history.body!.getReader(), 'sse-future');
    expect(historical).toContain('"state":"Reserved"');
    expect(historical).toContain('"state":"Disputed"');
    expect(historical).toContain('"state":"Refunded"');
    historyAbort.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();

    const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.some((record) => record.event === 'sse_connected')).toBe(true);
    expect(records.some((record) => record.event === 'sse_reconnected' && record.last_event_id === id)).toBe(true);
    expect(records.some((record) => record.event === 'sse_event_delivered' && record.event_id === id && record.order_id === orderId)).toBe(true);
    expect(records.some((record) => record.event === 'sse_closed')).toBe(true);
    const sseTraceIds = records.filter((record) => String(record.event).startsWith('sse_') && record.event !== 'sse_connection_rejected').map((record) => record.trace_id);
    expect(sseTraceIds.every((traceId) => typeof traceId === 'string')).toBe(true);
  });

  it('rejects malformed and unknown cursors before opening a stream', async () => {
    const logs: string[] = [];
    const app = buildServer({ logger: true, loggerStream: { write: (line) => logs.push(line) } });
    const malformed = await app.inject({ method: 'GET', url: '/events', headers: { 'last-event-id': 'not-a-uuid' } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: 'invalid_last_event_id' });
    const unknown = await app.inject({ method: 'GET', url: '/events', headers: {
      'last-event-id': '00000000-0000-4000-8000-000000000999'
    } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown_last_event_id' });
    await app.close();
    const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.event === 'sse_connection_rejected').map((record) => record.outcome))
      .toEqual(['invalid_cursor', 'unknown_cursor']);
  });
});
