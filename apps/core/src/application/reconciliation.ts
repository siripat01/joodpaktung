import { getPool } from '../db/pool.js';

export type ReconciliationResult = { readonly ok: boolean; readonly violations: string[] };

export async function reconcile(): Promise<ReconciliationResult> {
  const pool = getPool();
  const violations: string[] = [];
  const unbalanced = await pool.query<{ transaction_id: string }>(
    `SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_satang) <> 0`
  );
  for (const row of unbalanced.rows) violations.push(`unbalanced ledger transaction: ${row.transaction_id}`);

  const orders = await pool.query<{
    id: string; state: string; total: string; shipping: string; product: string; refunded: string;
  }>(`SELECT id, state, total_satang::text AS total, shipping_released_satang::text AS shipping,
             product_released_satang::text AS product, refunded_satang::text AS refunded FROM orders`);
  let expectedHold = 0;
  for (const order of orders.rows) {
    const accounted = Number(order.shipping) + Number(order.product) + Number(order.refunded);
    if (accounted > Number(order.total)) violations.push(`accounting exceeds total: ${order.id}`);
    if ((order.state === 'Released' || order.state === 'Refunded') && accounted !== Number(order.total)) {
      violations.push(`terminal accounting does not equal total: ${order.id}`);
    }
    if (order.state !== 'Released' && order.state !== 'Refunded') expectedHold += Number(order.total) - accounted;
  }
  const ledgerByOrder = await pool.query<{ order_id: string; account: string; balance: string }>(
    `SELECT order_id, account, COALESCE(SUM(amount_satang), 0)::text AS balance
       FROM ledger_entries GROUP BY order_id, account`
  );
  const orderById = new Map(orders.rows.map((order) => [order.id, order]));
  const ledgerBalances = new Map<string, Map<string, number>>();
  for (const entry of ledgerByOrder.rows) {
    const balances = ledgerBalances.get(entry.order_id) ?? new Map<string, number>();
    balances.set(entry.account, Number(entry.balance));
    ledgerBalances.set(entry.order_id, balances);
  }
  for (const [orderId, order] of orderById) {
    const balances = ledgerBalances.get(orderId) ?? new Map<string, number>();
    if ((balances.get('hold_suspense') ?? 0) !== Number(order.total) - (Number(order.shipping) + Number(order.product) + Number(order.refunded))) violations.push(`order hold ledger mismatch: ${orderId}`);
    if ((balances.get('seller_available') ?? 0) !== Number(order.shipping) + Number(order.product)) violations.push(`order seller ledger mismatch: ${orderId}`);
    if ((balances.get('buyer_refund') ?? 0) !== Number(order.refunded)) violations.push(`order refund ledger mismatch: ${orderId}`);
  }
  const hold = await pool.query<{ balance: string }>(
    `SELECT COALESCE(SUM(amount_satang), 0)::text AS balance FROM ledger_entries WHERE account = 'hold_suspense'`
  );
  if (Number(hold.rows[0]?.balance) !== expectedHold) violations.push('global hold balance mismatch');
  return { ok: violations.length === 0, violations };
}
