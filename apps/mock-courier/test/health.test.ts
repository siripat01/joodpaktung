import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('Mock Courier health', () => {
  it('reports the Mock Courier health contract', async () => {
    const app = buildServer({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'mock-courier', status: 'ok' });
    await app.close();
  });
});
