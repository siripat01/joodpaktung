import { asc, eq } from 'drizzle-orm';
import { reconcile } from '../application/reconciliation.js';
import { getDatabase } from '../db/pool.js';
import { domainEvents, ledgerEntries, orders } from '../db/schema.js';

export async function getOrderProjection(orderId: string) {
  const [order] = await getDatabase().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return null;
  return {
    id: order.id, state: order.state, productSatang: order.productSatang.toString(),
    shippingCapSatang: order.shippingCapSatang.toString(), totalSatang: order.totalSatang.toString(),
    courierPaidSatang: order.courierPaidSatang.toString(), courierChargeFinalized: order.courierChargeFinalized,
    productReleasedSatang: order.productReleasedSatang.toString(), refundedSatang: order.refundedSatang.toString(),
    remainingHoldSatang: (order.totalSatang - order.courierPaidSatang - order.productReleasedSatang - order.refundedSatang).toString(),
    shipmentToken: order.shipmentToken,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    shipBy: order.shipBy?.toISOString() ?? null,
    verificationDeadline: order.verificationDeadline?.toISOString() ?? null,
    disputeDeadline: order.disputeDeadline?.toISOString() ?? null
  };
}

export async function getConsoleProjection(orderId: string) {
  const [order, ledger, events, invariants] = await Promise.all([
    getOrderProjection(orderId),
    getDatabase().select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId)).orderBy(asc(ledgerEntries.createdAt)),
    getDatabase().select().from(domainEvents).where(eq(domainEvents.orderId, orderId)).orderBy(asc(domainEvents.sequence)),
    reconcile()
  ]);
  if (!order) return null;
  return {
    order,
    ledger: ledger.map((entry) => ({ id: entry.id, transactionId: entry.transactionId, account: entry.account, amountSatang: entry.amountSatang.toString() })),
    events: events.map((event) => ({ id: event.sequence, name: event.eventName, outcome: event.payload.outcome, occurredAt: event.occurredAt.toISOString() })),
    invariants
  };
}
