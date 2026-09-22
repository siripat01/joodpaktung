import type { PoolClient } from 'pg';
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

export async function lockOrder(client: PoolClient, orderId: string): Promise<LockedOrder> {
  const result = await client.query<LockedOrder>(
    `SELECT id, shipment_token, state, product_satang, shipping_cap_satang, total_satang,
            shipping_released_satang, product_released_satang, refunded_satang,
            ship_by, verification_deadline, dispute_deadline, created_at, updated_at
       FROM orders
      WHERE id = $1
      FOR UPDATE`,
    [orderId]
  );
  const order = result.rows[0];
  if (!order) throw new Error(`order not found: ${orderId}`);
  return order;
}
