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

  it('does not log query-string secrets when request logging is enabled', async () => {
    const logs: string[] = [];
    const app = buildServer({
      logger: true,
      loggerStream: { write: (message: string) => logs.push(message) }
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health?token=core-secret&secret=core-hmac'
    });
    await app.close();

    const logOutput = logs.join('');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'payment-core', status: 'ok' });
    expect(logOutput).toContain('"url":"/health"');
    expect(logOutput).not.toContain('core-secret');
    expect(logOutput).not.toContain('core-hmac');
    expect(logOutput).not.toContain('?token=');
  });
});
