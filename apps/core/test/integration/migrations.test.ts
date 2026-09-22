import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { databaseUrl, ensureTestDatabase } from './database.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;

async function runScript(script: string): Promise<void> {
  await execFileAsync(process.execPath, [script], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
}

describe('PostgreSQL migrations', () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    await ensureTestDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates durable financial tables and a mutation-proof ledger', async () => {
    await runScript('scripts/migrate.mjs');

    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'orders',
        'ledger_entries',
        'processed_events',
        'timers',
        'outbox_events',
        'domain_events',
        'clock_state'
      ])
    );

    const orderId = randomUUID();
    const entryId = randomUUID();
    const transactionId = randomUUID();
    const shipmentToken = `migration-test-${randomUUID()}`;
    await pool.query(
      'INSERT INTO orders (id, shipment_token, state, product_satang, shipping_cap_satang, total_satang) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
      [orderId, shipmentToken, 'pre_payment', 129000, 4500, 133500]
    );
    await pool.query(
      'INSERT INTO ledger_entries (id, order_id, transaction_id, account, amount_satang) VALUES ($1, $2, $3, $4, $5)',
      [entryId, orderId, transactionId, 'hold_suspense', 1]
    );

    await expect(
      pool.query('UPDATE ledger_entries SET amount_satang = 2 WHERE id = $1', [entryId])
    ).rejects.toThrow('ledger_entries are append-only');
    await expect(pool.query('DELETE FROM ledger_entries WHERE id = $1', [entryId])).rejects.toThrow(
      'ledger_entries are append-only'
    );
  });
});
