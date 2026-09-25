import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('command HTTP boundary', () => {
  it('rejects malformed commands before calling the payment core', async () => {
    const execute = vi.fn();
    const app = buildServer({ logger: false, executeCommand: execute });
    const response = await app.inject({ method: 'POST', url: '/commands', payload: { type: 'courier_pickup', orderId: 'x', eventKey: 'x', chargedFee: -1 } });
    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not expose the mock PIN in HTTP responses', async () => {
    const execute = vi.fn().mockResolvedValue({ outcome: 'processed', order: { state: 'Reserved' } });
    const app = buildServer({ logger: false, executeCommand: execute });
    const response = await app.inject({ method: 'POST', url: '/commands', payload: {
      type: 'seller_accepted_and_funded', orderId: 'ba29a9d4-6d37-4fce-b7aa-21010d735706', eventKey: 'fund-1', pin: '123456'
    } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('123456');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'seller_accepted_and_funded' }), expect.anything());
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('pin');
    await app.close();
  });
});
