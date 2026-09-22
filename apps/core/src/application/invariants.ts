import type { PoolClient } from 'pg';

export async function assertOrderInvariants(client: PoolClient, orderId: string): Promise<void> {
  const transactions = await client.query<{ transaction_id: string; balance: string }>(
    `SELECT transaction_id, SUM(amount_satang)::text AS balance
       FROM ledger_entries WHERE order_id = $1 GROUP BY transaction_id HAVING SUM(amount_satang) <> 0`,
    [orderId]
  );
  if (transactions.rowCount) throw new Error(`unbalanced ledger transaction: ${transactions.rows[0]?.transaction_id}`);

  const order = await client.query<{
    state: string; total: string; shipping: string; product: string; refunded: string;
  }>(
    `SELECT state, total_satang::text AS total, shipping_released_satang::text AS shipping,
            product_released_satang::text AS product, refunded_satang::text AS refunded
       FROM orders WHERE id = $1`, [orderId]
  );
  const row = order.rows[0];
  if (!row) throw new Error(`order not found: ${orderId}`);
  const accounted = Number(row.shipping) + Number(row.product) + Number(row.refunded);
  if (accounted > Number(row.total)) throw new Error('order accounting exceeds total');
  if ((row.state === 'Released' || row.state === 'Refunded') && accounted !== Number(row.total)) {
    throw new Error('terminal order accounting does not equal total');
  }

  const ledger = await client.query<{ account: string; balance: string }>(
    `SELECT account, COALESCE(SUM(amount_satang), 0)::text AS balance
       FROM ledger_entries WHERE order_id = $1 GROUP BY account`, [orderId]
  );
  const balances = new Map(ledger.rows.map((entry) => [entry.account, Number(entry.balance)]));
  if ((balances.get('hold_suspense') ?? 0) !== Number(row.total) - accounted) throw new Error('order hold ledger mismatch');
  if ((balances.get('seller_available') ?? 0) !== Number(row.shipping) + Number(row.product)) throw new Error('order seller ledger mismatch');
  if ((balances.get('buyer_refund') ?? 0) !== Number(row.refunded)) throw new Error('order refund ledger mismatch');

  const global = await client.query<{ hold: string; remaining: string }>(
    `SELECT
       COALESCE((SELECT SUM(amount_satang) FROM ledger_entries WHERE account = 'hold_suspense'), 0)::text AS hold,
       COALESCE((SELECT SUM(total_satang - shipping_released_satang - product_released_satang - refunded_satang)
                   FROM orders WHERE state NOT IN ('Released', 'Refunded')), 0)::text AS remaining`
  );
  if (Number(global.rows[0]?.hold) !== Number(global.rows[0]?.remaining)) {
    throw new Error('global hold balance does not equal non-terminal remaining amounts');
  }
}
