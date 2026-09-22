ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_state_check;
UPDATE orders SET state = 'Shipped' WHERE state = 'PartiallyReleased';
ALTER TABLE orders ADD CONSTRAINT orders_state_check
  CHECK (state IN ('pre_payment', 'Reserved', 'PendingVerification', 'Shipped', 'Disputed', 'Released', 'Refunded'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_paid_satang bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_charge_satang bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_charge_finalized boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_confirmed_at timestamptz;
ALTER TABLE orders ADD CONSTRAINT orders_courier_paid_nonnegative_check
  CHECK (courier_paid_satang >= 0 AND courier_paid_satang <= total_satang);
ALTER TABLE orders ADD CONSTRAINT orders_courier_charge_nonnegative_check
  CHECK (courier_charge_satang >= 0);

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check
  CHECK (account IN ('buyer_available', 'hold_suspense', 'courier_payable', 'seller_available', 'buyer_refund'));
