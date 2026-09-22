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
  await execFileAsync(process.execPath, ['scripts/migrate.mjs'], { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: databaseUrl } });
  await execFileAsync(process.execPath, ['scripts/reset-fixture.mjs'], { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: databaseUrl } });
}

describe('Payment Core idempotency', () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => { await ensureTestDatabase(); await resetFixture(); });
  afterAll(async () => { await closePool(); await pool.end(); });

  it('returns the original result when a pickup command is replayed', async () => {
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-1' }, {});
    const command = { type: 'courier_pickup', orderId, eventKey: 'pickup-1', chargedFee: 4500 } as const;
    const [first, second] = await Promise.all([handleCommand(command, {}), handleCommand(command, {})]);
    expect(first).toEqual(second);
    expect(await pool.query('SELECT count(DISTINCT transaction_id)::text AS count FROM ledger_entries WHERE order_id = $1', [orderId])).toMatchObject({ rows: [{ count: '2' }] });
    expect(await pool.query('SELECT count(*)::text AS count FROM processed_events WHERE event_key = $1', ['pickup-1'])).toMatchObject({ rows: [{ count: '1' }] });
  });

  it('requires evidence for operations commands', async () => {
    await expect(handleCommand({ type: 'operations_verify_fee', orderId, eventKey: 'verify-1', chargedFee: 4500, evidenceRef: ' ' }, {})).rejects.toThrow('evidenceRef');
  });
});
