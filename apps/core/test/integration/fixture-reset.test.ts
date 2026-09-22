import { execFile } from 'node:child_process';
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
  });
});
