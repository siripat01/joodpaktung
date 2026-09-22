import { eq, notInArray, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../db/pool.js';
import { ledgerEntries, orders } from '../db/schema.js';

function asBigInt(value: bigint | string | number | null | undefined): bigint {
  return BigInt(value ?? 0);
}

export async function assertOrderInvariants(transaction: DatabaseTransaction, orderId: string): Promise<void> {
  const transactions = await transaction
    .select({
      transactionId: ledgerEntries.transactionId,
      balance: sql<string>`SUM(${ledgerEntries.amountSatang})::text`
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.orderId, orderId))
    .groupBy(ledgerEntries.transactionId)
    .having(sql`SUM(${ledgerEntries.amountSatang}) <> 0`);
  if (transactions.length) {
    throw new Error(`unbalanced ledger transaction: ${transactions[0]?.transactionId}`);
  }

  const orderRows = await transaction
    .select({
      state: orders.state,
      total: orders.totalSatang,
      shipping: orders.shippingReleasedSatang,
      product: orders.productReleasedSatang,
      refunded: orders.refundedSatang
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  const order = orderRows[0];
  if (!order) throw new Error(`order not found: ${orderId}`);

  const accounted = order.shipping + order.product + order.refunded;
  if (accounted > order.total) throw new Error('order accounting exceeds total');
  if ((order.state === 'Released' || order.state === 'Refunded') && accounted !== order.total) {
    throw new Error('terminal order accounting does not equal total');
  }

  const ledger = await transaction
    .select({
      account: ledgerEntries.account,
      balance: sql<string>`COALESCE(SUM(${ledgerEntries.amountSatang}), 0)::text`
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.orderId, orderId))
    .groupBy(ledgerEntries.account);
  const balances = new Map(ledger.map((entry) => [entry.account, asBigInt(entry.balance)]));
  if (order.state === 'pre_payment') {
    if (accounted !== 0n) throw new Error('pre-payment order accounting is nonzero');
    if (ledger.length) throw new Error('pre-payment order has ledger entries');
  } else {
    if ((balances.get('hold_suspense') ?? 0n) !== order.total - accounted) {
      throw new Error('order hold ledger mismatch');
    }
    if ((balances.get('seller_available') ?? 0n) !== order.shipping + order.product) {
      throw new Error('order seller ledger mismatch');
    }
    if ((balances.get('buyer_refund') ?? 0n) !== order.refunded) {
      throw new Error('order refund ledger mismatch');
    }
  }

  const [globalHold] = await transaction
    .select({
      balance: sql<string>`COALESCE(SUM(${ledgerEntries.amountSatang}), 0)::text`
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.account, 'hold_suspense'));
  const [globalRemaining] = await transaction
    .select({
      remaining: sql<string>`COALESCE(SUM(${orders.totalSatang} - ${orders.shippingReleasedSatang} - ${orders.productReleasedSatang} - ${orders.refundedSatang}), 0)::text`
    })
    .from(orders)
    .where(notInArray(orders.state, ['pre_payment', 'Released', 'Refunded']));
  if (asBigInt(globalHold?.balance) !== asBigInt(globalRemaining?.remaining)) {
    throw new Error('global hold balance does not equal non-terminal remaining amounts');
  }
}
