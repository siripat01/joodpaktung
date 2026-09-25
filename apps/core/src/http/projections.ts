import { asc, eq, sql } from 'drizzle-orm';
import { reconcileInTransaction } from '../application/reconciliation.js';
import { withTransaction } from '../db/transaction.js';
import { domainEvents, ledgerEntries, orders, timers } from '../db/schema.js';

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function orderProjection(order: typeof orders.$inferSelect) {
  return {
    id: order.id,
    state: order.state,
    product_satang: order.productSatang.toString(),
    shipping_allowance_satang: order.shippingCapSatang.toString(),
    total_satang: order.totalSatang.toString(),
    courier_paid_satang: order.courierPaidSatang.toString(),
    courier_charge_satang: order.courierChargeSatang.toString(),
    courier_charge_finalized: order.courierChargeFinalized,
    product_released_satang: order.productReleasedSatang.toString(),
    refunded_satang: order.refundedSatang.toString(),
    delivered_at: iso(order.deliveredAt),
    buyer_confirmed_at: iso(order.buyerConfirmedAt),
    ship_by: iso(order.shipBy),
    verification_deadline: iso(order.verificationDeadline),
    dispute_deadline: iso(order.disputeDeadline),
    updated_at: order.updatedAt.toISOString()
  };
}

export async function getOrderProjection(orderId: string) {
  return withTransaction(async (db) => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return undefined;
    const ledger = await db.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId)).orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id));
    const events = await db.select().from(domainEvents).where(eq(domainEvents.orderId, orderId)).orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));
    const orderTimers = await db.select().from(timers).where(eq(timers.orderId, orderId)).orderBy(asc(timers.dueAt));
    return {
    order: orderProjection(order),
    ledger: ledger.map((entry) => ({
      id: entry.id, transaction_id: entry.transactionId, account: entry.account,
      amount_satang: entry.amountSatang.toString(), created_at: entry.createdAt.toISOString()
    })),
    events: events.map((event) => ({
      id: event.id, name: event.eventName, payload: event.payload, occurred_at: event.occurredAt.toISOString()
    })),
    timers: orderTimers.map((timer) => ({
      id: timer.id, kind: timer.kind, status: timer.status, due_at: timer.dueAt.toISOString()
    }))
    };
  });
}

export async function getConsoleProjection() {
  return withTransaction(async (db) => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const allOrders = await db.select().from(orders).orderBy(asc(orders.createdAt));
    const ledger = await db.select().from(ledgerEntries).orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id));
    const events = await db.select().from(domainEvents).orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));
    const invariant = await reconcileInTransaction(db);
    return {
    orders: allOrders.map(orderProjection),
    ledger: ledger.map((entry) => ({
      id: entry.id, order_id: entry.orderId, transaction_id: entry.transactionId,
      account: entry.account, amount_satang: entry.amountSatang.toString(), created_at: entry.createdAt.toISOString()
    })),
    events: events.map((event) => ({
      id: event.id, order_id: event.orderId, name: event.eventName,
      payload: event.payload, occurred_at: event.occurredAt.toISOString()
    })),
    invariants: invariant
    };
  });
}
