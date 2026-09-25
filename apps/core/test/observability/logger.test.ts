import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('structured HTTP logs', () => {
  it('redacts credentials, PINs, and query values', async () => {
    const chunks: string[] = [];
    const app = buildServer({ logger: true, loggerStream: { write: (message) => { chunks.push(message); } } });
    await app.inject({ method: 'GET', url: '/health?pin=123456', headers: { authorization: 'Bearer secret' } });
    await app.close();
    const logs = chunks.join('');
    expect(logs).not.toContain('123456');
    expect(logs).not.toContain('Bearer secret');
    expect(logs).toContain('reqId');
  });
});
