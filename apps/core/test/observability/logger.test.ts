import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('HTTP structured logging', () => {
  it('records correlation metadata without sensitive command or header values', async () => {
    const logs: string[] = [];
    const app = buildServer({ logger: true, loggerStream: { write: (line) => logs.push(line) } });
    await app.inject({ method: 'POST', url: '/commands?token=query-secret', headers: {
      authorization: 'Bearer private-token', 'x-courier-signature': 'raw-signature'
    }, payload: { type: 'unknown', pin: '123456', secret: 'hmac-secret', token: 'access-token' } });
    await app.close();
    const output = logs.join('');
    const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.service === 'payment-core')).toBe(true);
    expect(records.some((record) => record.event === 'command_rejected' && typeof record.trace_id === 'string' && typeof record.request_id === 'string')).toBe(true);
    for (const sensitive of ['query-secret', 'private-token', 'raw-signature', '123456', 'hmac-secret', 'access-token']) {
      expect(output).not.toContain(sensitive);
    }
  });
});
