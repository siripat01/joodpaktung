import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { appendLedgerEntries } from '../../src/db/ledger-repository.js';
import { lockOrder } from '../../src/db/order-repository.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTransaction } from '../../src/db/transaction.js';
import { databaseUrl, ensureTestDatabase } from './database.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;

async function runMigration(): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
}

describe('database interfaces', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let orderId: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runMigration();
    await pool.query(
      'TRUNCATE domain_events, outbox_events, timers, processed_events, ledger_entries, orders, clock_state RESTART IDENTITY CASCADE'
    );
    orderId = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, state, product_satang, shipping_cap_satang, total_satang)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, 'pre_payment', 129000, 4500, 133500]
    );
  });

  afterAll(async () => {
    await closePool();
    await pool.end();
  });

  it('rolls back failed transactions and releases the client', async () => {
    const marker = randomUUID();
    let failedBackendPid: number | undefined;
    await expect(
      withTransaction(async (client) => {
        const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        failedBackendPid = backend.rows[0]?.pid;
        await client.query(
          `INSERT INTO orders (id, shipment_token, state, product_satang, shipping_cap_satang, total_satang)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), marker, 'pre_payment', 129000, 4500, 133500]
        );
        throw new Error('rollback probe');
      })
    ).rejects.toThrow('rollback probe');
    expect(failedBackendPid).toBeTypeOf('number');

    const durableState = await pool.query('SELECT 1 FROM orders WHERE shipment_token = $1', [marker]);
    expect(durableState.rowCount).toBe(0);

    const reusedBackendPid = await withTransaction(async (client) => {
      const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return backend.rows[0]?.pid;
    });
    expect(reusedBackendPid).toBe(failedBackendPid);
    await expect(
      withTransaction(async (client) => {
        const result = await client.query('SELECT 1 AS value');
        return result.rows[0]?.value;
      })
    ).resolves.toBe(1);
  });

  it('serializes order locks until the first transaction commits', async () => {
    const first = await getPool().connect();
    const second = await getPool().connect();
    try {
      await first.query('BEGIN');
      await lockOrder(first, orderId);
      await second.query('BEGIN');
      let secondLocked = false;
      const waitingLock = lockOrder(second, orderId).then(() => {
        secondLocked = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondLocked).toBe(false);
      await first.query('COMMIT');
      await waitingLock;
      expect(secondLocked).toBe(true);
      await second.query('COMMIT');
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('requires every transaction batch to balance independently', async () => {
    const transactionA = randomUUID();
    const transactionB = randomUUID();
    const client = await pool.connect();
    try {
      await expect(
        appendLedgerEntries(client, [
          { orderId, transactionId: transactionA, posting: { account: 'hold_suspense', amountSatang: 100 } },
          { orderId, transactionId: transactionB, posting: { account: 'hold_suspense', amountSatang: -100 } }
        ])
      ).rejects.toThrow('unbalanced ledger');

      await appendLedgerEntries(client, [
        { orderId, transactionId: transactionA, posting: { account: 'buyer_available', amountSatang: -100 } },
        { orderId, transactionId: transactionA, posting: { account: 'hold_suspense', amountSatang: 100 } }
      ]);
      const result = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ledger_entries WHERE transaction_id = $1',
        [transactionA]
      );
      expect(result.rows[0]?.count).toBe('2');
    } finally {
      client.release();
    }
  });
});
