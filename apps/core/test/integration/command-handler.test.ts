import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { handleCommand } from '../../src/application/command-handler.js';
import { closePool } from '../../src/db/pool.js';
import { databaseUrl, ensureTestDatabase } from './database.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;
const orderId = '00000000-0000-4000-8000-000000000100';

async function resetFixture(): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
  await execFileAsync(process.execPath, ['scripts/reset-fixture.mjs'], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
}

describe('Payment Core command handler', () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    await ensureTestDatabase();
    await resetFixture();
  });

  afterAll(async () => {
    await closePool();
    await pool.end();
  });

  it('funds an accepted order and releases the capped courier fee on pickup', async () => {
    await expect(handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-1' }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Reserved' }
    });

    await expect(handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-1', chargedFee: 5000 }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'PartiallyReleased', shipping_released_satang: '4500' }
    });

    const ledger = await pool.query<{ account: string; amount: string }>(
      'SELECT account, amount_satang::text AS amount FROM ledger_entries WHERE order_id = $1 ORDER BY created_at, id',
      [orderId]
    );
    expect(ledger.rows).toHaveLength(4);
    expect(ledger.rows.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(0);
  });

  it('records an invalid courier transition without changing the order', async () => {
    const result = await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-before-fund', chargedFee: 4500 }, {});
    expect(result).toMatchObject({ outcome: 'rejected-invalid-transition' });
    expect(await pool.query('SELECT state FROM orders WHERE id = $1', [orderId])).toMatchObject({ rows: [{ state: 'PartiallyReleased' }] });
  });

  it('retains an invalid courier event on a fresh pre-payment fixture', async () => {
    await resetFixture();
    const command = { type: 'courier_pickup', orderId, eventKey: 'pickup-before-fund-fresh', chargedFee: 4500 } as const;
    const beforeOrder = await pool.query(
      `SELECT state, shipping_released_satang::text AS shipping, product_released_satang::text AS product,
              refunded_satang::text AS refunded
         FROM orders WHERE id = $1`,
      [orderId]
    );
    const beforeLedger = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger_entries WHERE order_id = $1',
      [orderId]
    );

    await expect(handleCommand(command, {})).resolves.toMatchObject({
      outcome: 'rejected-invalid-transition',
      order: { state: 'pre_payment' }
    });

    const processed = await pool.query<{ event_key: string; outcome: string }>(
      'SELECT event_key, outcome FROM processed_events WHERE event_key = $1',
      [command.eventKey]
    );
    expect(processed.rows).toEqual([
      { event_key: command.eventKey, outcome: 'rejected-invalid-transition' }
    ]);
    expect(await pool.query(
      `SELECT state, shipping_released_satang::text AS shipping, product_released_satang::text AS product,
              refunded_satang::text AS refunded
         FROM orders WHERE id = $1`,
      [orderId]
    )).toEqual(beforeOrder);
    expect(await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger_entries WHERE order_id = $1',
      [orderId]
    )).toEqual(beforeLedger);

    await expect(handleCommand(command, {})).resolves.toMatchObject({
      outcome: 'duplicate-ignored',
      order: { state: 'pre_payment' }
    });
    expect(await pool.query(
      'SELECT count(*)::text AS count FROM processed_events WHERE event_key = $1',
      [command.eventKey]
    )).toMatchObject({ rows: [{ count: '1' }] });
  });
});
