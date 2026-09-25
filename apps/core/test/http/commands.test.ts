import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { buildServer } from '../../src/server.js';
import { databaseUrl, ensureTestDatabase } from '../integration/database.js';

const execFileAsync = promisify(execFile);
const root = new URL('../../../../', import.meta.url).pathname;
const orderId = '00000000-0000-4000-8000-000000000100';

describe('Core command and committed projections', () => {
  beforeAll(async () => {
    await ensureTestDatabase();
    await execFileAsync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl } });
  });
  beforeEach(async () => {
    await execFileAsync(process.execPath, ['scripts/reset-fixture.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl } });
  });
  afterAll(closePool);

  it('validates and executes commands then exposes only committed facts', async () => {
    const app = buildServer({ logger: false });
    const response = await app.inject({ method: 'POST', url: '/commands', payload: {
      type: 'seller_accepted_and_funded', orderId, eventKey: 'http-fund-1'
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'processed', order: { state: 'Reserved' } });

    const order = await app.inject({ method: 'GET', url: `/orders/${orderId}` });
    expect(order.json()).toMatchObject({
      order: { state: 'Reserved', total_satang: '133500' },
      ledger: expect.arrayContaining([{ account: 'hold_suspense', amount_satang: '133500' }]),
      events: [{ name: 'seller_accepted_and_funded' }]
    });
    const consoleProjection = (await app.inject({ method: 'GET', url: '/console' })).json();
    expect(consoleProjection).toMatchObject({ invariants: { ok: true, violations: [] } });
    await app.close();
  });

  it('returns a clean rejection for malformed commands without writing an event', async () => {
    const app = buildServer({ logger: false });
    const response = await app.inject({ method: 'POST', url: '/commands', payload: {
      type: 'courier_pickup', orderId, eventKey: 'bad', chargedFee: -1, pin: '123456'
    } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_command' });
    expect((await app.inject({ method: 'GET', url: `/orders/${orderId}` })).json().events).toEqual([]);
    await app.close();
  });

  it('records the current committed state when an older command key is retried', async () => {
    const app = buildServer({ logger: false });
    const fund = { type: 'seller_accepted_and_funded', orderId, eventKey: 'old-funding-key' };
    expect((await app.inject({ method: 'POST', url: '/commands', payload: fund })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/commands', payload: {
      type: 'courier_pickup', orderId, eventKey: 'later-pickup-key', chargedFee: 3000
    } })).json()).toMatchObject({ order: { state: 'Shipped' } });

    expect((await app.inject({ method: 'POST', url: '/commands', payload: fund })).json())
      .toMatchObject({ outcome: 'duplicate-ignored' });
    const projection = (await app.inject({ method: 'GET', url: `/orders/${orderId}` })).json();
    expect(projection.events.at(-1)).toMatchObject({
      name: 'duplicate-ignored',
      payload: { eventKey: 'old-funding-key', originalOutcome: 'processed', resultingState: 'Shipped' }
    });
    await app.close();
  });
});
