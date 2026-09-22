import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { databaseUrl, ensureTestDatabase } from './database.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;

async function runScript(script: string): Promise<void> {
  await execFileAsync(process.execPath, [script], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
}

describe('fixture reset', () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    await ensureTestDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('restores one pre-payment seed order with the fixed total', async () => {
    await runScript('scripts/migrate.mjs');
    await runScript('scripts/reset-fixture.mjs');

    const seed = await pool.query<{ id: string }>('SELECT id FROM orders');
    const seedOrderId = seed.rows[0]?.id;
    if (!seedOrderId) throw new Error('seed order missing');
    await pool.query(
      `INSERT INTO domain_events (id, order_id, event_name, payload)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), seedOrderId, 'fixture-test', {}]
    );
    await pool.query(
      `INSERT INTO outbox_events (id, order_id, kind, notification_key, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), seedOrderId, 'fixture-test', `fixture-${randomUUID()}`, {}]
    );
    await pool.query(
      `INSERT INTO timers (id, order_id, kind, due_at, event_key)
       VALUES ($1, $2, $3, now(), $4)`,
      [randomUUID(), seedOrderId, 'fixture-test', `fixture-${randomUUID()}`]
    );
    await pool.query(
      `INSERT INTO processed_events (event_key, order_id, outcome, result)
       VALUES ($1, $2, $3, $4)`,
      [`fixture-${randomUUID()}`, seedOrderId, 'processed', { fixture: true }]
    );
    const ledgerTransactionId = randomUUID();
    await pool.query(
      `INSERT INTO ledger_entries (id, order_id, transaction_id, account, amount_satang)
       VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $7, $8)`,
      [
        randomUUID(),
        seedOrderId,
        ledgerTransactionId,
        'buyer_available',
        -100,
        randomUUID(),
        'hold_suspense',
        100
      ]
    );
    await pool.query("UPDATE clock_state SET now_at = '2000-01-01T00:00:00Z', updated_at = '2000-01-01T00:00:00Z'");
    const resetStartedAt = Date.now();
    await runScript('scripts/reset-fixture.mjs');
    const resetFinishedAt = Date.now();

    const orders = await pool.query<{
      state: string;
      product_satang: string;
      shipping_cap_satang: string;
      total_satang: string;
    }>('SELECT state, product_satang, shipping_cap_satang, total_satang FROM orders');

    expect(orders.rows).toEqual([
      {
        state: 'pre_payment',
        product_satang: '129000',
        shipping_cap_satang: '4500',
        total_satang: '133500'
      }
    ]);
    for (const table of ['domain_events', 'outbox_events', 'timers', 'processed_events', 'ledger_entries']) {
      const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count).toBe('0');
    }
    const clock = await pool.query<{ singleton: boolean; now_at: Date; updated_at: Date }>(
      'SELECT singleton, now_at, updated_at FROM clock_state'
    );
    expect(clock.rows).toHaveLength(1);
    expect(clock.rows[0]?.singleton).toBe(true);
    expect(clock.rows[0]?.now_at.getTime()).toBeGreaterThanOrEqual(resetStartedAt - 1000);
    expect(clock.rows[0]?.now_at.getTime()).toBeLessThanOrEqual(resetFinishedAt + 1000);
    expect(clock.rows[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(resetStartedAt - 1000);
    expect(clock.rows[0]?.updated_at.getTime()).toBeLessThanOrEqual(resetFinishedAt + 1000);
  });
});
