import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { handleCommand } from '../../src/application/command-handler.js';
import { reconcile } from '../../src/application/reconciliation.js';
import { closePool } from '../../src/db/pool.js';
import { lockOrder } from '../../src/db/order-repository.js';
import { withTransaction } from '../../src/db/transaction.js';
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

  async function leaseTimer(kind: 'ship_by_expired' | 'verification_expired' | 'auto_release_expired', eventKey: string) {
    const leaseToken = `test-token-${randomUUID()}`;
    await pool.query(`INSERT INTO timers(id,order_id,kind,due_at,status,lease_owner,lease_until,event_key,payload)
      VALUES($1,$2,$3,now(),'leased',$4,now()+interval '1 minute',$5,'{}')`,
      [randomUUID(), orderId, kind, leaseToken, eventKey]);
    return { type: kind, orderId, eventKey, leaseToken } as const;
  }

  beforeAll(async () => {
    await ensureTestDatabase();
    await resetFixture();
  });

  afterAll(async () => {
    await closePool();
    await pool.end();
  });

  it('completes a claimed timer inside the same Core command transaction', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-timer-owner' }, {});
    const claimed = await pool.query<{ event_key: string; lease_owner: string }>(
      `UPDATE timers SET status = 'leased', lease_owner = 'worker-test', lease_until = now() + interval '1 minute'
       WHERE order_id = $1 AND kind = 'ship_by_expired' RETURNING event_key, lease_owner`, [orderId]);
    const eventKey = claimed.rows[0]?.event_key;
    expect(eventKey).toBeTruthy();
    await handleCommand({ type: 'ship_by_expired', orderId, eventKey: eventKey!, leaseToken: claimed.rows[0]!.lease_owner }, {});
    expect(await pool.query('SELECT status, lease_owner, lease_until FROM timers WHERE event_key = $1', [eventKey]))
      .toMatchObject({ rows: [{ status: 'completed', lease_owner: null, lease_until: null }] });
  });

  it('rolls back a timer command when its fencing token is stale', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-stale-timer' }, {});
    const claimed = await pool.query<{ event_key: string }>(
      `UPDATE timers SET status='leased', lease_owner='fresh-token-123456', lease_until=now()+interval '1 minute'
       WHERE order_id=$1 AND kind='ship_by_expired' RETURNING event_key`, [orderId]);
    const eventKey = claimed.rows[0]!.event_key;
    await expect(handleCommand({ type: 'ship_by_expired', orderId, eventKey, leaseToken: 'stale-token-123456' }, {}))
      .rejects.toThrow('timer lease lost');
    expect(await pool.query('SELECT state FROM orders WHERE id=$1', [orderId])).toMatchObject({ rows: [{ state: 'Reserved' }] });
    expect(await pool.query('SELECT count(*)::int AS count FROM processed_events WHERE event_key=$1', [eventKey]))
      .toMatchObject({ rows: [{ count: 0 }] });
    expect(await pool.query('SELECT status,lease_owner FROM timers WHERE event_key=$1', [eventKey]))
      .toMatchObject({ rows: [{ status: 'leased', lease_owner: 'fresh-token-123456' }] });
  });

  it('lets a duplicate timer retry with a fresh lease token complete without a second effect', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-duplicate-timer' }, {});
    const claimed = await pool.query<{ event_key: string; lease_owner: string }>(
      `UPDATE timers SET status='leased', lease_owner='first-token-123456', lease_until=now()+interval '1 minute'
       WHERE order_id=$1 AND kind='ship_by_expired' RETURNING event_key,lease_owner`, [orderId]);
    const eventKey = claimed.rows[0]!.event_key;
    await handleCommand({ type: 'ship_by_expired', orderId, eventKey, leaseToken: claimed.rows[0]!.lease_owner }, {});
    await pool.query(`UPDATE timers SET status='leased',lease_owner='fresh-token-123456',lease_until=now()+interval '1 minute' WHERE event_key=$1`, [eventKey]);
    await expect(handleCommand({ type: 'ship_by_expired', orderId, eventKey, leaseToken: 'fresh-token-123456' }, {}))
      .resolves.toMatchObject({ outcome: 'duplicate-ignored', timerCompleted: true });
    expect(await pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE order_id=$1', [orderId]))
      .toMatchObject({ rows: [{ count: 4 }] });
  });

  it('funds an accepted order and pays the actual courier fee to courier payable', async () => {
    await expect(handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-1' }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Reserved' }
    });

    await expect(handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-1', chargedFee: 3000 }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Shipped', courier_paid_satang: '3000' }
    });

    const ledger = await pool.query<{ account: string; amount: string }>(
      'SELECT account, amount_satang::text AS amount FROM ledger_entries WHERE order_id = $1 ORDER BY created_at, id',
      [orderId]
    );
    expect(ledger.rows).toHaveLength(4);
    expect(ledger.rows).toContainEqual({ account: 'courier_payable', amount: '3000' });
    expect(ledger.rows).not.toContainEqual({ account: 'seller_available', amount: '3000' });
    expect(ledger.rows.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(0);
    const settlementIntent = await pool.query<{ kind: string; payload: { orderId?: string; courierPaidSatang?: string } }>(
      `SELECT kind, payload FROM outbox_events
        WHERE order_id = $1 AND kind = 'courier_settlement_requested'`,
      [orderId]
    );
    expect(settlementIntent.rows).toHaveLength(1);
    expect(settlementIntent.rows[0]?.payload).toMatchObject({ orderId, courierPaidSatang: '3000' });
  });

  it('records an invalid courier transition without changing the order', async () => {
    const result = await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-before-fund', chargedFee: 4500 }, {});
    expect(result).toMatchObject({ outcome: 'rejected-invalid-transition' });
    expect(await pool.query('SELECT state FROM orders WHERE id = $1', [orderId])).toMatchObject({ rows: [{ state: 'Shipped' }] });
  });

  it('retains an invalid courier event on a fresh pre-payment fixture', async () => {
    await resetFixture();
    const command = { type: 'courier_pickup', orderId, eventKey: 'pickup-before-fund-fresh', chargedFee: 4500 } as const;
    const beforeOrder = await pool.query(
      `SELECT state, courier_paid_satang::text AS courier, product_released_satang::text AS product,
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
      `SELECT state, courier_paid_satang::text AS courier, product_released_satang::text AS product,
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
      'UPDATE orders SET courier_paid_satang = 1 WHERE id = $1',
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
      order: { state: 'Shipped' }
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
    for (const table of ['processed_events', 'domain_events']) {
      expect(await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE order_id = $1`,
        [orderId]
      )).toMatchObject({ rows: [{ count: '3' }] });
    }
    expect(await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM outbox_events WHERE order_id = $1',
      [orderId]
    )).toMatchObject({ rows: [{ count: '4' }] });
  });

  it('refunds unused allowance and deducts courier overage from seller product payout', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-allocation' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-allocation', chargedFee: 3000 }, {});
    await handleCommand({ type: 'courier_delivered', orderId, eventKey: 'delivered-allocation' }, {});
    await handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'charge-final-allocation', chargedFee: 5000, finalized: true }, {});

    await expect(handleCommand({ type: 'buyer_confirmed', orderId, eventKey: 'confirm-allocation' }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: {
        state: 'Released',
        courier_paid_satang: '5000',
        product_released_satang: '128500',
        refunded_satang: '0'
      }
    });

    const balances = await pool.query<{ account: string; balance: string }>(
      `SELECT account, SUM(amount_satang)::text AS balance
         FROM ledger_entries WHERE order_id = $1 GROUP BY account ORDER BY account`,
      [orderId]
    );
    expect(balances.rows).toEqual([
      { account: 'buyer_available', balance: '-133500' },
      { account: 'courier_payable', balance: '5000' },
      { account: 'hold_suspense', balance: '0' },
      { account: 'seller_available', balance: '128500' }
    ]);

    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-refund-allowance' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-refund-allowance', chargedFee: 3000 }, {});
    await handleCommand({ type: 'courier_delivered', orderId, eventKey: 'delivered-refund-allowance' }, {});
    await handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'charge-final-refund-allowance', chargedFee: 3000, finalized: true }, {});
    await expect(handleCommand({ type: 'buyer_confirmed', orderId, eventKey: 'confirm-refund-allowance' }, {})).resolves.toMatchObject({
      order: { state: 'Released', courier_paid_satang: '3000', product_released_satang: '129000', refunded_satang: '1500' }
    });
  });

  it('retains a late reweigh after delivery as an append-only courier adjustment', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-reweigh' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-reweigh', chargedFee: 3000 }, {});
    await handleCommand({ type: 'courier_delivered', orderId, eventKey: 'delivered-reweigh' }, {});
    await expect(handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'reweigh-1', chargedFee: 5000, finalized: true }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Shipped', courier_paid_satang: '5000', product_released_satang: '0' }
    });

    const courierEntries = await pool.query<{ transaction_id: string; amount: string }>(
      `SELECT transaction_id, amount_satang::text AS amount FROM ledger_entries
        WHERE order_id = $1 AND account = 'courier_payable' ORDER BY created_at, id`,
      [orderId]
    );
    expect(courierEntries.rows.map((row) => row.amount)).toEqual(['3000', '2000']);
    expect(new Set(courierEntries.rows.map((row) => row.transaction_id)).size).toBe(2);

    await expect(handleCommand({ type: 'buyer_confirmed', orderId, eventKey: 'confirm-after-reweigh' }, {})).resolves.toMatchObject({
      order: { state: 'Released', product_released_satang: '128500' }
    });
  });

  it('ignores a duplicate reweigh without appending a second financial adjustment', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-reweigh-duplicate' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-reweigh-duplicate', chargedFee: 3000 }, {});
    const reweigh = { type: 'courier_charge_updated', orderId, eventKey: 'reweigh-duplicate', chargedFee: 5000, finalized: true } as const;
    await handleCommand(reweigh, {});
    await expect(handleCommand(reweigh, {})).resolves.toMatchObject({ outcome: 'duplicate-ignored' });
    expect(await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ledger_entries
        WHERE order_id = $1 AND account = 'courier_payable'`,
      [orderId]
    )).toMatchObject({ rows: [{ count: '2' }] });
    expect(await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM domain_events
        WHERE order_id = $1 AND event_name = 'duplicate-ignored'`,
      [orderId]
    )).toMatchObject({ rows: [{ count: '1' }] });
  });

  it('moves an impossible courier overage to PendingVerification without a negative payout', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-impossible' }, {});
    await expect(handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-impossible', chargedFee: 133501 }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'PendingVerification', courier_paid_satang: '0', product_released_satang: '0' }
    });
    expect(await pool.query<{ account: string; balance: string }>(
      `SELECT account, SUM(amount_satang)::text AS balance FROM ledger_entries
        WHERE order_id = $1 GROUP BY account ORDER BY account`,
      [orderId]
    )).toMatchObject({ rows: [
      { account: 'buyer_available', balance: '-133500' },
      { account: 'hold_suspense', balance: '133500' }
    ] });
  });

  it('gates auto-release on both delivery and finalized courier charge', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-gate' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-gate', chargedFee: 3000 }, {});
    await expect(handleCommand(await leaseTimer('auto_release_expired', 'auto-before-delivery'), {})).resolves.toMatchObject({
      outcome: 'rejected-invalid-transition', order: { state: 'Shipped', product_released_satang: '0' }
    });
    expect(await pool.query(`SELECT status FROM timers WHERE event_key='auto-before-delivery'`))
      .toMatchObject({ rows: [{ status: 'completed' }] });
    await handleCommand({ type: 'courier_delivered', orderId, eventKey: 'delivered-gate' }, {});
    await expect(handleCommand(await leaseTimer('auto_release_expired', 'auto-before-finalization'), {})).resolves.toMatchObject({
      outcome: 'rejected-invalid-transition', order: { state: 'Shipped', product_released_satang: '0' }
    });
    await handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'charge-final-gate', chargedFee: 3000, finalized: true }, {});
    await expect(handleCommand(await leaseTimer('auto_release_expired', 'auto-after-gate'), {})).resolves.toMatchObject({
      outcome: 'processed', order: { state: 'Released', product_released_satang: '129000' }
    });
  });

  it('records an early buyer confirmation as intent without releasing product money', async () => {
    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-early-confirm' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-early-confirm', chargedFee: 3000 }, {});
    await expect(handleCommand({ type: 'buyer_confirmed', orderId, eventKey: 'confirm-before-gate' }, {})).resolves.toMatchObject({
      outcome: 'processed', order: { state: 'Shipped', product_released_satang: '0' }
    });
    await handleCommand({ type: 'courier_delivered', orderId, eventKey: 'delivered-early-confirm' }, {});
    await expect(handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'charge-final-early-confirm', chargedFee: 3000, finalized: true }, {})).resolves.toMatchObject({
      order: { state: 'Released', product_released_satang: '129000' }
    });
  });

  it('writes a durable duplicate audit without a second financial effect', async () => {
    await resetFixture();
    const command = { type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-duplicate-audit' } as const;
    await handleCommand(command, {});
    await expect(handleCommand(command, {})).resolves.toMatchObject({ outcome: 'duplicate-ignored' });
    expect(await pool.query<{ event_name: string; outcome: string }>(
      `SELECT event_name, payload->>'outcome' AS outcome FROM domain_events
        WHERE order_id = $1 ORDER BY occurred_at, id`,
      [orderId]
    )).toMatchObject({ rows: [
      { event_name: 'seller_accepted_and_funded', outcome: 'processed' },
      { event_name: 'duplicate-ignored', outcome: 'duplicate-ignored' }
    ] });
    expect(await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger_entries WHERE order_id = $1', [orderId]
    )).toMatchObject({ rows: [{ count: '2' }] });
  });

  it('reports lock waits and invariant failures with redacted structured logs', async () => {
    await resetFixture();
    const logs: Record<string, unknown>[] = [];
    const logger = {
      info(fields: Record<string, unknown>): void { logs.push(fields); },
      error(fields: Record<string, unknown>): void { logs.push(fields); }
    };
    let releaseFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => {
      void withTransaction(async (transaction) => {
        await lockOrder(transaction, orderId);
        resolve();
        await new Promise<void>((release) => { releaseFirst = release; });
      });
    });
    await firstLocked;
    const waiting = handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-lock-wait', chargedFee: 4500 }, {
      traceId: 'trace-lock', requestId: 'request-lock', logger
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirst();
    await waiting;
    expect(logs.map((log) => log.event)).toContain('order_lock_waited');
    expect(JSON.stringify(logs)).not.toContain('4500');

    await resetFixture();
    await pool.query('UPDATE orders SET courier_paid_satang = 1 WHERE id = $1', [orderId]);
    await expect(handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-invariant-log', chargedFee: 4500 }, {
      traceId: 'trace-invariant', requestId: 'request-invariant', logger
    })).rejects.toThrow('pre-payment order');
    expect(logs.map((log) => log.event)).toContain('invariant_failed');
    expect(JSON.stringify(logs)).not.toContain('ops-proof');
  });

  it('keeps concurrent global checks green from one consistent snapshot', async () => {
    await resetFixture();
    const secondOrderId = '00000000-0000-4000-8000-000000000101';
    await pool.query(
      `INSERT INTO orders (id, state, product_satang, shipping_cap_satang, total_satang)
       VALUES ($1, 'pre_payment', 129000, 4500, 133500)`, [secondOrderId]
    );
    const results = await Promise.all([
      handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-global-a' }, {}),
      handleCommand({ type: 'seller_accepted_and_funded', orderId: secondOrderId, eventKey: 'fund-global-b' }, {}),
      reconcile(),
      reconcile()
    ]);
    expect(results.slice(2)).toEqual([
      { ok: true, violations: [] },
      { ok: true, violations: [] }
    ]);
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
    await handleCommand({ type: 'courier_delivered', orderId, eventKey: 'delivered-confirm' }, {});
    await handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'charge-confirm', chargedFee: 4500, finalized: true }, {});
    await expect(handleCommand({ type: 'buyer_confirmed', orderId, eventKey: 'confirm-1' }, {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Released', product_released_satang: '129000' }
    });

    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-auto' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-auto', chargedFee: 4500 }, {});
    await handleCommand({ type: 'courier_delivered', orderId, eventKey: 'delivered-auto' }, {});
    await handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'charge-auto', chargedFee: 4500, finalized: true }, {});
    await expect(handleCommand(await leaseTimer('auto_release_expired', 'auto-1'), {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Released' }
    });

    await resetFixture();
    await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-refund' }, {});
    await handleCommand({ type: 'courier_pickup', orderId, eventKey: 'pickup-refund', chargedFee: 4500 }, {});
    await handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'charge-refund', chargedFee: 4500, finalized: true }, {});
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
    await handleCommand({ type: 'courier_charge_updated', orderId, eventKey: 'charge-release', chargedFee: 4500, finalized: true }, {});
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
    await expect(handleCommand(await leaseTimer('verification_expired', 'verification-expiry'), {})).resolves.toMatchObject({
      outcome: 'processed',
      order: { state: 'Refunded' }
    });
  });
});
