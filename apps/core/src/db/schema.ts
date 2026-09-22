import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PaymentState } from '../domain/types.js';

export type PersistedOrderState = PaymentState | 'pre_payment';

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    shipmentToken: text('shipment_token').unique(),
    state: text('state').notNull().$type<PersistedOrderState>(),
    productSatang: bigint('product_satang', { mode: 'bigint' }).notNull(),
    shippingCapSatang: bigint('shipping_cap_satang', { mode: 'bigint' }).notNull(),
    totalSatang: bigint('total_satang', { mode: 'bigint' }).notNull(),
    courierPaidSatang: bigint('courier_paid_satang', { mode: 'bigint' }).notNull().default(0n),
    courierChargeSatang: bigint('courier_charge_satang', { mode: 'bigint' }).notNull().default(0n),
    courierChargeFinalized: boolean('courier_charge_finalized').notNull().default(false),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    buyerConfirmedAt: timestamp('buyer_confirmed_at', { withTimezone: true, mode: 'date' }),
    productReleasedSatang: bigint('product_released_satang', { mode: 'bigint' }).notNull().default(0n),
    refundedSatang: bigint('refunded_satang', { mode: 'bigint' }).notNull().default(0n),
    shipBy: timestamp('ship_by', { withTimezone: true, mode: 'date' }),
    verificationDeadline: timestamp('verification_deadline', { withTimezone: true, mode: 'date' }),
    disputeDeadline: timestamp('dispute_deadline', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (table) => [index('orders_state_ship_by_idx').on(table.state, table.shipBy)]
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    transactionId: uuid('transaction_id').notNull(),
    account: text('account').notNull(),
    amountSatang: bigint('amount_satang', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (table) => [index('ledger_entries_order_created_idx').on(table.orderId, table.createdAt)]
);

export const processedEvents = pgTable(
  'processed_events',
  {
    eventKey: text('event_key').primaryKey(),
    orderId: uuid('order_id').notNull(),
    outcome: text('outcome').notNull(),
    result: jsonb('result').notNull().$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (table) => [index('processed_events_order_created_idx').on(table.orderId, table.createdAt)]
);

export const timers = pgTable(
  'timers',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    kind: text('kind').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status').notNull().default('pending'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    eventKey: text('event_key').notNull().unique(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (table) => [index('timers_claim_idx').on(table.status, table.dueAt)]
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    kind: text('kind').notNull(),
    notificationKey: text('notification_key').notNull().unique(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
    status: text('status').notNull().default('pending'),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (table) => [index('outbox_claim_idx').on(table.status, table.availableAt)]
);

export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    eventName: text('event_name').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (table) => [index('domain_events_order_occurred_idx').on(table.orderId, table.occurredAt)]
);

export const clockState = pgTable('clock_state', {
  singleton: boolean('singleton').primaryKey(),
  nowAt: timestamp('now_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
});
