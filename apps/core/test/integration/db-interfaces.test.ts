import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { appendLedgerEntries } from '../../src/db/ledger-repository.js';
import { lockOrder } from '../../src/db/order-repository.js';
import { closePool } from '../../src/db/pool.js';
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
      withTransaction(async (transaction) => {
        const backend = await transaction.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        failedBackendPid = backend.rows[0]?.pid;
        await transaction.execute(sql`
          INSERT INTO orders (id, shipment_token, state, product_satang, shipping_cap_satang, total_satang)
          VALUES (${randomUUID()}, ${marker}, ${'pre_payment'}, ${129000}, ${4500}, ${133500})
        `);
        throw new Error('rollback probe');
      })
    ).rejects.toThrow('rollback probe');
    expect(failedBackendPid).toBeTypeOf('number');

    const durableState = await pool.query('SELECT 1 FROM orders WHERE shipment_token = $1', [marker]);
    expect(durableState.rowCount).toBe(0);

    const reusedBackendPid = await withTransaction(async (transaction) => {
      const backend = await transaction.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      return backend.rows[0]?.pid;
    });
    expect(reusedBackendPid).toBe(failedBackendPid);
    await expect(
      withTransaction(async (transaction) => {
        const result = await transaction.execute<{ value: number }>(sql`SELECT 1 AS value`);
        return result.rows[0]?.value;
      })
    ).resolves.toBe(1);
  });

  it('passes a Drizzle transaction executor to repository callbacks', async () => {
    const value = await withTransaction(async (transaction) => {
      const result = await transaction.execute(sql`SELECT 1::int AS value`);
      return result.rows[0]?.value;
    });

    expect(value).toBe(1);
  });

  it('serializes order locks until the first transaction commits', async () => {
    let firstLocked = false;
    let secondLocked = false;
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withTransaction(async (transaction) => {
      await lockOrder(transaction, orderId);
      firstLocked = true;
      await firstReleased;
    });
    while (!firstLocked) await new Promise((resolve) => setTimeout(resolve, 5));

    const second = withTransaction(async (transaction) => {
      await lockOrder(transaction, orderId);
      secondLocked = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondLocked).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondLocked).toBe(true);
  });

  it('requires every transaction batch to balance independently', async () => {
    const transactionA = randomUUID();
    const transactionB = randomUUID();
    await expect(
      withTransaction(async (transaction) =>
        appendLedgerEntries(transaction, [
          { orderId, transactionId: transactionA, posting: { account: 'hold_suspense', amountSatang: 100n } },
          { orderId, transactionId: transactionB, posting: { account: 'hold_suspense', amountSatang: -100n } }
        ])
      )
    ).rejects.toThrow('unbalanced ledger');

    await withTransaction(async (transaction) => {
      await appendLedgerEntries(transaction, [
        { orderId, transactionId: transactionA, posting: { account: 'buyer_available', amountSatang: -100n } },
        { orderId, transactionId: transactionA, posting: { account: 'hold_suspense', amountSatang: 100n } }
      ]);
    });
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger_entries WHERE transaction_id = $1',
      [transactionA]
    );
    expect(result.rows[0]?.count).toBe('2');
  });
});
