import { eq, sql } from 'drizzle-orm';
import { withTransaction, type DatabaseTransaction } from '../db/transaction.js';
import { ledgerEntries, orders } from '../db/schema.js';

export type ReconciliationResult = { readonly ok: boolean; readonly violations: string[] };

function asBigInt(value: bigint | string | number | null | undefined): bigint {
  return BigInt(value ?? 0);
}

async function reconcileInTransaction(transaction: DatabaseTransaction): Promise<ReconciliationResult> {
  const violations: string[] = [];
  const unbalanced = await transaction
    .select({ transactionId: ledgerEntries.transactionId })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.transactionId)
    .having(sql`SUM(${ledgerEntries.amountSatang}) <> 0`);
  for (const row of unbalanced) violations.push(`unbalanced ledger transaction: ${row.transactionId}`);

  const orderRows = await transaction
    .select({
      id: orders.id,
      state: orders.state,
      total: orders.totalSatang,
      shipping: orders.shippingReleasedSatang,
      product: orders.productReleasedSatang,
      refunded: orders.refundedSatang
    })
    .from(orders);
  let expectedHold = 0n;
  for (const order of orderRows) {
    const total = asBigInt(order.total);
    const shipping = asBigInt(order.shipping);
    const product = asBigInt(order.product);
    const refunded = asBigInt(order.refunded);
    const accounted = shipping + product + refunded;
    if (accounted > total) violations.push(`accounting exceeds total: ${order.id}`);
    if ((order.state === 'Released' || order.state === 'Refunded') && accounted !== total) {
      violations.push(`terminal accounting does not equal total: ${order.id}`);
    }
    if (order.state !== 'Released' && order.state !== 'Refunded') {
      expectedHold += total - accounted;
    }
  }

  const ledgerByOrder = await transaction
    .select({
      orderId: ledgerEntries.orderId,
      account: ledgerEntries.account,
      balance: sql<string>`COALESCE(SUM(${ledgerEntries.amountSatang}), 0)::text`
    })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.orderId, ledgerEntries.account);
  const ledgerBalances = new Map<string, Map<string, bigint>>();
  for (const entry of ledgerByOrder) {
    const balances = ledgerBalances.get(entry.orderId) ?? new Map<string, bigint>();
    balances.set(entry.account, asBigInt(entry.balance));
    ledgerBalances.set(entry.orderId, balances);
  }
  for (const order of orderRows) {
    const balances = ledgerBalances.get(order.id) ?? new Map<string, bigint>();
    const total = asBigInt(order.total);
    const shipping = asBigInt(order.shipping);
    const product = asBigInt(order.product);
    const refunded = asBigInt(order.refunded);
    if ((balances.get('hold_suspense') ?? 0n) !== total - (shipping + product + refunded)) {
      violations.push(`order hold ledger mismatch: ${order.id}`);
    }
    if ((balances.get('seller_available') ?? 0n) !== shipping + product) {
      violations.push(`order seller ledger mismatch: ${order.id}`);
    }
    if ((balances.get('buyer_refund') ?? 0n) !== refunded) {
      violations.push(`order refund ledger mismatch: ${order.id}`);
    }
  }

  const [hold] = await transaction
    .select({ balance: sql<string>`COALESCE(SUM(${ledgerEntries.amountSatang}), 0)::text` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.account, 'hold_suspense'));
  if (asBigInt(hold?.balance) !== expectedHold) violations.push('global hold balance mismatch');
  return { ok: violations.length === 0, violations };
}

export async function reconcile(): Promise<ReconciliationResult> {
  return withTransaction(reconcileInTransaction);
}
