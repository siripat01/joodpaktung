import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { handleCommand } from '../../src/application/command-handler.js';
import { closePool } from '../../src/db/pool.js';
import { buildServer } from '../../src/server.js';
import { HmacCourierProvider } from '../../src/ports/courier-provider.js';
import { databaseUrl, ensureTestDatabase } from '../integration/database.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;
const orderId = '00000000-0000-4000-8000-000000000100';
const shipmentToken = 'seed-shipment-token';
const secret = 'courier-webhook-test-secret';

function signedWebhook(payload: Record<string, unknown>, signatureOverride?: string) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = signatureOverride ?? createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    method: 'POST' as const,
    url: '/webhooks/courier',
    headers: { 'content-type': 'application/json', 'x-courier-signature': signature },
    payload: rawBody
  };
}

describe('signed courier webhook', () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    await ensureTestDatabase();
    await execFileAsync(process.execPath, ['scripts/migrate.mjs'], {
      cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: databaseUrl }
    });
  });

  beforeEach(async () => {
    await execFileAsync(process.execPath, ['scripts/reset-fixture.mjs'], {
      cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: databaseUrl }
    });
  });

  afterAll(async () => {
    await closePool();
    await pool.end();
  });

  function makeApp(logs?: string[]) {
    return buildServer({
      logger: Boolean(logs),
      ...(logs ? { loggerStream: { write: (message: string) => logs.push(message) } } : {}),
      courierProvider: new HmacCourierProvider(secret)
    });
  }

  async function processedOutcome(eventKey: string): Promise<string | undefined> {
    const result = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM processed_events WHERE event_key = $1', [eventKey]
    );
    return result.rows[0]?.outcome;
  }

  it('persists early delivered and ignores its replay', async () => {
    const app = makeApp();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-early-delivered' }, {});
    const webhook = signedWebhook({ id: 'delivered-early', kind: 'delivered', shipmentToken });

    expect((await app.inject(webhook)).statusCode).toBe(202);
    expect(await processedOutcome('delivered-early')).toBe('rejected-invalid-transition');
    const pickup = signedWebhook({ id: 'pickup-1', kind: 'picked_up', shipmentToken, chargedFee: 3000 });
    expect((await app.inject(pickup)).statusCode).toBe(202);
    expect((await app.inject(webhook)).json()).toMatchObject({ outcome: 'duplicate-ignored' });
    expect(await processedOutcome('delivered-early')).toBe('rejected-invalid-transition');
    expect((await pool.query<{ state: string }>('SELECT state FROM orders WHERE id = $1', [orderId])).rows[0]?.state).toBe('Shipped');
    await app.close();
  });

  it('rejects an invalid signature before recording or applying the event', async () => {
    const app = makeApp();
    const response = await app.inject(signedWebhook({
      id: 'unsigned-pickup', kind: 'picked_up', shipmentToken, chargedFee: 3000
    }, 'invalid-signature'));

    expect(response.statusCode).toBe(401);
    expect(await processedOutcome('unsigned-pickup')).toBeUndefined();
    expect((await pool.query<{ state: string }>('SELECT state FROM orders WHERE id = $1', [orderId])).rows[0]?.state).toBe('pre_payment');
    await app.close();
  });

  it('rejects a missing courier signature without recording the event', async () => {
    const app = makeApp();
    const response = await app.inject({ method: 'POST', url: '/webhooks/courier', payload: {
      id: 'missing-signature', kind: 'picked_up', shipmentToken, chargedFee: 3000
    } });

    expect(response.statusCode).toBe(401);
    expect(await processedOutcome('missing-signature')).toBeUndefined();
    await app.close();
  });

  it('routes a signed late charge update through the idempotent Payment Core command', async () => {
    const app = makeApp();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-late-reweigh' }, {});
    await app.inject(signedWebhook({ id: 'pickup-2', kind: 'picked_up', shipmentToken, chargedFee: 3000 }));
    await app.inject(signedWebhook({ id: 'delivered-2', kind: 'delivered', shipmentToken }));
    const reweigh = signedWebhook({ id: 'reweigh-2', kind: 'charge_updated', shipmentToken, chargedFee: 5000, finalized: true });

    expect((await app.inject(reweigh)).json()).toMatchObject({ outcome: 'processed', order: { courier_charge_satang: '5000' } });
    expect((await app.inject(reweigh)).json()).toMatchObject({ outcome: 'duplicate-ignored' });
    const courierRows = await pool.query<{ amount: string }>(
      "SELECT amount_satang::text AS amount FROM ledger_entries WHERE order_id = $1 AND account = 'courier_payable'",
      [orderId]
    );
    expect(courierRows.rows.map((row) => row.amount)).toEqual(['3000', '2000']);
    await app.close();
  });

  it('keeps signatures and shipment tokens out of request and webhook logs', async () => {
    const logs: string[] = [];
    const app = makeApp(logs);
    const webhook = signedWebhook({ id: 'log-pickup', kind: 'picked_up', shipmentToken, chargedFee: 3000 });
    await app.inject(webhook);
    await app.close();

    const output = logs.join('');
    expect(output).toContain('log-pickup');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(webhook.headers['x-courier-signature']);
    expect(output).not.toContain(shipmentToken);
  });
});
