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

  it('does not log query-string secrets when request logging is enabled', async () => {
    const logs: string[] = [];
    const app = buildServer({
      logger: true,
      loggerStream: { write: (message: string) => logs.push(message) }
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health?token=courier-secret&secret=courier-hmac'
    });
    await app.close();

    const logOutput = logs.join('');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'mock-courier', status: 'ok' });
    expect(logOutput).toContain('"url":"/health"');
    expect(logOutput).not.toContain('courier-secret');
    expect(logOutput).not.toContain('courier-hmac');
    expect(logOutput).not.toContain('?token=');
  });
});
