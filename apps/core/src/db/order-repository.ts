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
  readonly shipping_released_satang: string;
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
    shipping_released_satang: order.shippingReleasedSatang.toString(),
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
  shippingSatang: bigint,
  productSatang: bigint,
  refundedSatang: bigint
): Promise<LockedOrder> {
  const result = await transaction
    .update(orders)
    .set({
      state,
      shippingReleasedSatang: shippingSatang,
      productReleasedSatang: productSatang,
      refundedSatang,
      updatedAt: sql`now()`
    })
    .where(eq(orders.id, orderId))
    .returning();
  return toLockedOrder(result[0], orderId);
}
