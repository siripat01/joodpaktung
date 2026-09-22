import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { handleCommand } from '../../src/application/command-handler.js';
import { reconcile } from '../../src/application/reconciliation.js';
import { closePool } from '../../src/db/pool.js';
import { databaseUrl, ensureTestDatabase } from './database.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;
const orderId = '00000000-0000-4000-8000-000000000100';

async function resetFixture(): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/migrate.mjs'], { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: databaseUrl } });
  await execFileAsync(process.execPath, ['scripts/reset-fixture.mjs'], { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: databaseUrl } });
}

describe('Payment Core reconciliation', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  beforeAll(async () => { await ensureTestDatabase(); await resetFixture(); });
  afterAll(async () => { await closePool(); await pool.end(); });

  it('accepts a fresh pre-payment intent without a hold or ledger entry', async () => {
    await resetFixture();
    await expect(reconcile()).resolves.toMatchObject({ ok: true, violations: [] });
  });

  it('keeps terminal accounting equal to order total', async () => {
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-1' }, {});
    await handleCommand({ type: 'ship_by_expired', orderId, eventKey: 'timer-1' }, {});
    await expect(reconcile()).resolves.toMatchObject({ ok: true, violations: [] });
  });

  it('reports a tampered ledger as a reconciliation violation', async () => {
    await pool.query('UPDATE orders SET refunded_satang = refunded_satang - 1 WHERE id = $1', [orderId]);
    await expect(reconcile()).resolves.toMatchObject({ ok: false });
  });
});
