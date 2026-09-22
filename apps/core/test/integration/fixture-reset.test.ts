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
    await runScript('scripts/reset-fixture.mjs');

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
    const clock = await pool.query('SELECT singleton FROM clock_state');
    expect(clock.rows).toEqual([{ singleton: true }]);
  });
});
