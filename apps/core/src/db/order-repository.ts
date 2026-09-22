import { eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from './pool.js';
import { orders, type PersistedOrderState } from './schema.js';
import type { PaymentState } from '../domain/types.js';

export type OrderState = PaymentState | 'pre_payment';

export type LockedOrder = {
  readonly id: string;
  readonly shipment_token: string | null;
  readonly state: OrderState;
  readonly product_satang: string;
  readonly shipping_cap_satang: string;
  readonly total_satang: string;
  readonly courier_paid_satang: string;
  readonly courier_charge_satang: string;
  readonly courier_charge_finalized: boolean;
  readonly delivered_at: Date | null;
  readonly buyer_confirmed_at: Date | null;
  readonly product_released_satang: string;
  readonly refunded_satang: string;
  readonly ship_by: Date | null;
  readonly verification_deadline: Date | null;
  readonly dispute_deadline: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

function toLockedOrder(order: typeof orders.$inferSelect | undefined, orderId: string): LockedOrder {
  if (!order) throw new Error(`order not found: ${orderId}`);
  return {
    id: order.id,
    shipment_token: order.shipmentToken,
    state: order.state,
    product_satang: order.productSatang.toString(),
    shipping_cap_satang: order.shippingCapSatang.toString(),
    total_satang: order.totalSatang.toString(),
    courier_paid_satang: order.courierPaidSatang.toString(),
    courier_charge_satang: order.courierChargeSatang.toString(),
    courier_charge_finalized: order.courierChargeFinalized,
    delivered_at: order.deliveredAt,
    buyer_confirmed_at: order.buyerConfirmedAt,
    product_released_satang: order.productReleasedSatang.toString(),
    refunded_satang: order.refundedSatang.toString(),
    ship_by: order.shipBy,
    verification_deadline: order.verificationDeadline,
    dispute_deadline: order.disputeDeadline,
    created_at: order.createdAt,
    updated_at: order.updatedAt
  };
}

export async function lockOrder(transaction: DatabaseTransaction, orderId: string): Promise<LockedOrder> {
  const result = await transaction
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .for('update');
  return toLockedOrder(result[0], orderId);
}

export async function saveOrder(
  transaction: DatabaseTransaction,
  orderId: string,
  state: PersistedOrderState,
  courierPaidSatang: bigint,
  courierChargeSatang: bigint,
  courierChargeFinalized: boolean,
  deliveredAt: Date | null,
  buyerConfirmedAt: Date | null,
  productSatang: bigint,
  refundedSatang: bigint
): Promise<LockedOrder> {
  const result = await transaction
    .update(orders)
    .set({
      state,
      courierPaidSatang,
      courierChargeSatang,
      courierChargeFinalized,
      deliveredAt,
      buyerConfirmedAt,
      productReleasedSatang: productSatang,
      refundedSatang,
      updatedAt: sql`now()`
    })
    .where(eq(orders.id, orderId))
    .returning();
  return toLockedOrder(result[0], orderId);
}
