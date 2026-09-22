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

  it('rejects a pre-payment command when its accounting is already corrupted', async () => {
    await resetFixture();
    await pool.query(
      'UPDATE orders SET shipping_released_satang = 1 WHERE id = $1',
      [orderId]
    );

    await expect(handleCommand({
      type: 'courier_pickup',
      orderId,
      eventKey: 'pickup-corrupt-pre-payment',
      chargedFee: 4500
    }, {})).rejects.toThrow('pre-payment order');
    expect(await pool.query(
      'SELECT count(*)::text AS count FROM processed_events WHERE event_key = $1',
      ['pickup-corrupt-pre-payment']
    )).toMatchObject({ rows: [{ count: '0' }] });
  });

  it('retains operations evidence in the durable domain audit event', async () => {
    await resetFixture();
    await pool.query(
      `UPDATE orders
          SET verification_deadline = now() + interval '1 hour',
              dispute_deadline = now() + interval '2 hours'
        WHERE id = $1`,
      [orderId]
    );

    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-evidence' }, {});
    await handleCommand({ type: 'courier_unavailable', orderId, eventKey: 'unavailable-evidence' }, {});
    await expect(handleCommand({
      type: 'operations_verify_fee',
      orderId,
      eventKey: 'verify-evidence',
      chargedFee: 4500,
      evidenceRef: 'ops-proof/pickup-1'
    }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'PartiallyReleased' }
    });

    const event = await pool.query<{ payload: { evidenceRef?: string } }>(
      `SELECT payload
         FROM domain_events
        WHERE order_id = $1 AND event_name = 'operations_verify_fee'
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
      [orderId]
    );
    expect(event.rows[0]?.payload.evidenceRef).toBe('ops-proof/pickup-1');
    expect(await pool.query<{ kind: string }>(
      'SELECT kind FROM timers WHERE order_id = $1 ORDER BY kind',
      [orderId]
    )).toMatchObject({ rows: [{ kind: 'auto_release_expired' }, { kind: 'verification_expired' }] });
    expect(await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger_entries WHERE order_id = $1',
      [orderId]
    )).toMatchObject({ rows: [{ count: '4' }] });
    for (const table of ['processed_events', 'domain_events', 'outbox_events']) {
      expect(await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE order_id = $1`,
        [orderId]
      )).toMatchObject({ rows: [{ count: '3' }] });
    }
  });

  it('writes correlated command boundary logs without operational evidence', async () => {
    await resetFixture();
    const logs: Record<string, unknown>[] = [];
    const logger = {
      info(fields: Record<string, unknown>): void {
        logs.push(fields);
      },
      error(fields: Record<string, unknown>): void {
        logs.push(fields);
      }
    };
    const context = { traceId: 'trace-command-1', requestId: 'request-command-1', logger };

    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-log' }, context);
    await handleCommand({ type: 'courier_unavailable', orderId, eventKey: 'unavailable-log' }, context);
    await handleCommand({
      type: 'operations_verify_fee',
      orderId,
      eventKey: 'verify-log',
      chargedFee: 4500,
      evidenceRef: 'ops-proof/should-not-be-logged'
    }, context);
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-log' }, context);

    expect(logs.map((log) => log.event)).toEqual(expect.arrayContaining([
      'command_received',
      'order_lock_acquired',
      'ledger_posted',
      'invariant_passed',
      'command_committed',
      'command_deduplicated'
    ]));
    for (const log of logs) {
      expect(log.trace_id).toBe('trace-command-1');
      expect(log.request_id).toBe('request-command-1');
      expect(log.order_id).toBe(orderId);
      expect(['fund-log', 'unavailable-log', 'verify-log']).toContain(log.event_key);
    }
    expect(JSON.stringify(logs)).not.toContain('ops-proof/should-not-be-logged');
  });

  it('executes each remaining payment command through the locked state machine', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-confirm' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-confirm', chargedFee: 4500 }, {});
    await expect(handleCommand({ type: 'buyer_confirmed', orderId, eventKey: 'confirm-1' }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Released', product_released_satang: '129000' }
    });

    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-auto' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-auto', chargedFee: 4500 }, {});
    await expect(handleCommand({ type: 'auto_release_expired', orderId, eventKey: 'auto-1' }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Released' }
    });

    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-refund' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-refund', chargedFee: 4500 }, {});
    await handleCommand({ type: 'buyer_disputed', orderId, eventKey: 'dispute-refund' }, {});
    await expect(handleCommand({
      type: 'operations_resolve_refund',
      orderId,
      eventKey: 'resolve-refund',
      evidenceRef: 'ops-proof/refund'
    }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Refunded', refunded_satang: '129000' }
    });

    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-release' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-release', chargedFee: 4500 }, {});
    await handleCommand({ type: 'buyer_disputed', orderId, eventKey: 'dispute-release' }, {});
    await expect(handleCommand({
      type: 'operations_resolve_release',
      orderId,
      eventKey: 'resolve-release',
      evidenceRef: 'ops-proof/release'
    }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Released' }
    });

    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-verify-expiry' }, {});
    await handleCommand({ type: 'courier_unavailable', orderId, eventKey: 'unavailable-expiry' }, {});
    await expect(handleCommand({ type: 'verification_expired', orderId, eventKey: 'verification-expiry' }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Refunded' }
    });
  });
});
