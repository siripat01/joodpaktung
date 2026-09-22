import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('Core health', () => {
  it('reports the Core health contract', async () => {
    const app = buildServer({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'payment-core', status: 'ok' });
    await app.close();
  });
});
