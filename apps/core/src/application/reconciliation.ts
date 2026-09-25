import { sql } from 'drizzle-orm';
import { withTransaction, type DatabaseTransaction } from '../db/transaction.js';

export type ReconciliationResult = { readonly ok: boolean; readonly violations: string[] };

type ReconciliationRow = {
  id: string;
  state: string;
  product: string;
  total: string;
  courier_paid: string;
  product_released: string;
  refunded: string;
  account_balances: Array<{ account: string; balance: string }>;
  has_ledger: boolean;
  global_hold: string;
  global_remaining: string;
  unbalanced_transactions: string[];
};

function asBigInt(value: bigint | string | number | null | undefined): bigint {
  return BigInt(value ?? 0);
}

async function readReconciliationSnapshot(transaction: DatabaseTransaction): Promise<ReconciliationRow[]> {
  const result = await transaction.execute(sql`
    WITH order_snapshot AS (
      SELECT id, state, product_satang::text AS product, total_satang::text AS total,
             courier_paid_satang::text AS courier_paid,
             product_released_satang::text AS product_released,
             refunded_satang::text AS refunded
        FROM orders
    ),
    account_snapshot AS (
      SELECT order_id, account, SUM(amount_satang)::text AS balance
        FROM ledger_entries GROUP BY order_id, account
    ),
    transaction_snapshot AS (
      SELECT order_id, transaction_id::text AS transaction_id
        FROM ledger_entries GROUP BY order_id, transaction_id
       HAVING SUM(amount_satang) <> 0
    ),
    global_snapshot AS (
      SELECT
        (SELECT COALESCE(SUM(amount_satang), 0)::text FROM ledger_entries WHERE account = 'hold_suspense') AS global_hold,
        (SELECT COALESCE(SUM(total_satang - courier_paid_satang - product_released_satang - refunded_satang), 0)::text
           FROM orders WHERE state NOT IN ('pre_payment', 'Released', 'Refunded')) AS global_remaining
    )
    SELECT
      o.id,
      o.state,
      o.product,
      o.total,
      o.courier_paid,
      o.product_released,
      o.refunded,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('account', a.account, 'balance', a.balance))
                  FROM account_snapshot a WHERE a.order_id = o.id), '[]'::jsonb) AS account_balances,
      EXISTS (SELECT 1 FROM account_snapshot a WHERE a.order_id = o.id) AS has_ledger,
      g.global_hold,
      g.global_remaining,
      COALESCE((SELECT jsonb_agg(t.transaction_id) FROM transaction_snapshot t WHERE t.order_id = o.id), '[]'::jsonb) AS unbalanced_transactions
      FROM order_snapshot o CROSS JOIN global_snapshot g
  `);
  return result.rows as unknown as ReconciliationRow[];
}

export async function reconcileInTransaction(transaction: DatabaseTransaction): Promise<ReconciliationResult> {
  const rows = await readReconciliationSnapshot(transaction);
  const violations: string[] = [];
  let expectedHold = 0n;
  for (const order of rows) {
    const total = asBigInt(order.total);
    const product = asBigInt(order.product);
    const courierPaid = asBigInt(order.courier_paid);
    const productReleased = asBigInt(order.product_released);
    const refunded = asBigInt(order.refunded);
    const accounted = courierPaid + productReleased + refunded;
    if (courierPaid > total) violations.push(`courier paid exceeds total: ${order.id}`);
    if (productReleased > product) violations.push(`product payout exceeds product amount: ${order.id}`);
    if (accounted > total) violations.push(`accounting exceeds total: ${order.id}`);
    if ((order.state === 'Released' || order.state === 'Refunded') && accounted !== total) {
      violations.push(`terminal accounting does not equal total: ${order.id}`);
    }
    for (const transactionId of order.unbalanced_transactions ?? []) {
      violations.push(`unbalanced ledger transaction: ${transactionId}`);
    }

    const balances = new Map((order.account_balances ?? []).map((entry) => [entry.account, asBigInt(entry.balance)]));
    if (order.state === 'pre_payment') {
      if (accounted !== 0n) violations.push(`pre-payment order accounting is nonzero: ${order.id}`);
      if (order.has_ledger) violations.push(`pre-payment order has ledger entries: ${order.id}`);
    } else {
      if ((balances.get('hold_suspense') ?? 0n) !== total - accounted) {
        violations.push(`order hold ledger mismatch: ${order.id}`);
      }
      if ((balances.get('courier_payable') ?? 0n) !== courierPaid) {
        violations.push(`order courier ledger mismatch: ${order.id}`);
      }
      if ((balances.get('seller_available') ?? 0n) !== productReleased) {
        violations.push(`order seller ledger mismatch: ${order.id}`);
      }
      if ((balances.get('buyer_refund') ?? 0n) !== refunded) {
        violations.push(`order refund ledger mismatch: ${order.id}`);
      }
    }
    if (order.state !== 'pre_payment' && order.state !== 'Released' && order.state !== 'Refunded') {
      expectedHold += total - accounted;
    }
  }

  const globalHold = rows[0]?.global_hold ?? '0';
  const globalRemaining = rows[0]?.global_remaining ?? '0';
  if (asBigInt(globalHold) !== expectedHold || asBigInt(globalHold) !== asBigInt(globalRemaining)) {
    violations.push('global hold balance mismatch');
  }
  return { ok: violations.length === 0, violations };
}

export async function reconcile(): Promise<ReconciliationResult> {
  return withTransaction(reconcileInTransaction);
}
