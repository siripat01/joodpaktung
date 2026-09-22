import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../db/pool.js';

type AccountBalance = { account: string; balance: string };
type OrderSnapshot = {
  state: string;
  product: string;
  total: string;
  courierPaid: string;
  courierCharge: string;
  productReleased: string;
  refunded: string;
  accountBalances: AccountBalance[];
  unbalancedTransactions: string[];
  globalHold: string;
  globalRemaining: string;
};

function asBigInt(value: bigint | string | number | null | undefined): bigint {
  return BigInt(value ?? 0);
}

async function readOrderSnapshot(transaction: DatabaseTransaction, orderId: string): Promise<OrderSnapshot> {
  const result = await transaction.execute(sql`
    WITH order_snapshot AS (
      SELECT id, state, product_satang, total_satang, courier_paid_satang,
             courier_charge_satang, product_released_satang, refunded_satang
        FROM orders WHERE id = ${orderId}
    ),
    account_snapshot AS (
      SELECT account, SUM(amount_satang)::text AS balance
        FROM ledger_entries WHERE order_id = ${orderId} GROUP BY account
    ),
    unbalanced_snapshot AS (
      SELECT transaction_id::text AS transaction_id
        FROM ledger_entries WHERE order_id = ${orderId}
       GROUP BY transaction_id HAVING SUM(amount_satang) <> 0
    ),
    global_snapshot AS (
      SELECT
        (SELECT COALESCE(SUM(amount_satang), 0)::text FROM ledger_entries WHERE account = 'hold_suspense') AS global_hold,
        (SELECT COALESCE(SUM(total_satang - courier_paid_satang - product_released_satang - refunded_satang), 0)::text
           FROM orders WHERE state NOT IN ('pre_payment', 'Released', 'Refunded')) AS global_remaining
    )
    SELECT
      (SELECT state FROM order_snapshot) AS state,
      (SELECT product_satang::text FROM order_snapshot) AS product,
      (SELECT total_satang::text FROM order_snapshot) AS total,
      (SELECT courier_paid_satang::text FROM order_snapshot) AS courier_paid,
      (SELECT courier_charge_satang::text FROM order_snapshot) AS courier_charge,
      (SELECT product_released_satang::text FROM order_snapshot) AS product_released,
      (SELECT refunded_satang::text FROM order_snapshot) AS refunded,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('account', account, 'balance', balance)) FROM account_snapshot), '[]'::jsonb) AS account_balances,
      COALESCE((SELECT jsonb_agg(transaction_id) FROM unbalanced_snapshot), '[]'::jsonb) AS unbalanced_transactions,
      (SELECT global_hold FROM global_snapshot) AS global_hold,
      (SELECT global_remaining FROM global_snapshot) AS global_remaining
  `);
  const row = result.rows[0] as unknown as {
    state: string | null;
    product: string | null;
    total: string | null;
    courier_paid: string | null;
    courier_charge: string | null;
    product_released: string | null;
    refunded: string | null;
    account_balances: AccountBalance[];
    unbalanced_transactions: string[];
    global_hold: string | null;
    global_remaining: string | null;
  } | undefined;
  if (!row?.state) throw new Error(`order not found: ${orderId}`);
  return {
    state: row.state,
    product: row.product ?? '0',
    total: row.total ?? '0',
    courierPaid: row.courier_paid ?? '0',
    courierCharge: row.courier_charge ?? '0',
    productReleased: row.product_released ?? '0',
    refunded: row.refunded ?? '0',
    accountBalances: row.account_balances ?? [],
    unbalancedTransactions: row.unbalanced_transactions ?? [],
    globalHold: row.global_hold ?? '0',
    globalRemaining: row.global_remaining ?? '0'
  };
}

export async function assertOrderInvariants(transaction: DatabaseTransaction, orderId: string): Promise<void> {
  const snapshot = await readOrderSnapshot(transaction, orderId);
  if (snapshot.unbalancedTransactions.length) {
    throw new Error(`unbalanced ledger transaction: ${snapshot.unbalancedTransactions[0]}`);
  }

  const total = asBigInt(snapshot.total);
  const product = asBigInt(snapshot.product);
  const courierPaid = asBigInt(snapshot.courierPaid);
  const productReleased = asBigInt(snapshot.productReleased);
  const refunded = asBigInt(snapshot.refunded);
  const accounted = courierPaid + productReleased + refunded;
  if (courierPaid > total) throw new Error('courier paid exceeds order total');
  if (productReleased > product) throw new Error('product payout exceeds product amount');
  if (accounted > total) throw new Error('order accounting exceeds total');
  if ((snapshot.state === 'Released' || snapshot.state === 'Refunded') && accounted !== total) {
    throw new Error('terminal order accounting does not equal total');
  }

  const balances = new Map(snapshot.accountBalances.map((entry) => [entry.account, asBigInt(entry.balance)]));
  if (snapshot.state === 'pre_payment') {
    if (accounted !== 0n) throw new Error('pre-payment order accounting is nonzero');
    if (snapshot.accountBalances.length) throw new Error('pre-payment order has ledger entries');
  } else {
    if ((balances.get('hold_suspense') ?? 0n) !== total - accounted) {
      throw new Error('order hold ledger mismatch');
    }
    if ((balances.get('courier_payable') ?? 0n) !== courierPaid) {
      throw new Error('order courier ledger mismatch');
    }
    if ((balances.get('seller_available') ?? 0n) !== productReleased) {
      throw new Error('order seller ledger mismatch');
    }
    if ((balances.get('buyer_refund') ?? 0n) !== refunded) {
      throw new Error('order refund ledger mismatch');
    }
  }

  if (asBigInt(snapshot.globalHold) !== asBigInt(snapshot.globalRemaining)) {
    throw new Error('global hold balance does not equal non-terminal remaining amounts');
  }
}
