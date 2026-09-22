CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  shipment_token text UNIQUE,
  state text NOT NULL CHECK (state IN ('pre_payment', 'Reserved', 'PendingVerification', 'PartiallyReleased', 'Disputed', 'Released', 'Refunded')),
  product_satang bigint NOT NULL CHECK (product_satang >= 0),
  shipping_cap_satang bigint NOT NULL CHECK (shipping_cap_satang >= 0),
  total_satang bigint NOT NULL CHECK (total_satang = product_satang + shipping_cap_satang),
  shipping_released_satang bigint NOT NULL DEFAULT 0 CHECK (shipping_released_satang >= 0),
  product_released_satang bigint NOT NULL DEFAULT 0 CHECK (product_released_satang >= 0),
  refunded_satang bigint NOT NULL DEFAULT 0 CHECK (refunded_satang >= 0),
  ship_by timestamptz,
  verification_deadline timestamptz,
  dispute_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (shipping_released_satang + product_released_satang + refunded_satang <= total_satang)
);

CREATE INDEX IF NOT EXISTS orders_state_ship_by_idx ON orders(state, ship_by);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  transaction_id uuid NOT NULL,
  account text NOT NULL CHECK (account IN ('buyer_available', 'hold_suspense', 'seller_available', 'buyer_refund')),
  amount_satang bigint NOT NULL CHECK (amount_satang <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_entries_order_created_idx ON ledger_entries(order_id, created_at);

CREATE OR REPLACE FUNCTION reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are append-only';
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TABLE IF NOT EXISTS processed_events (
  event_key text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  outcome text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processed_events_order_created_idx ON processed_events(order_id, created_at);

CREATE TABLE IF NOT EXISTS timers (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  kind text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
  lease_owner text,
  lease_until timestamptz,
  event_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timers_claim_idx ON timers(status, due_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  kind text NOT NULL,
  notification_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_claim_idx ON outbox_events(status, available_at);

CREATE TABLE IF NOT EXISTS domain_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS domain_events_order_occurred_idx ON domain_events(order_id, occurred_at);

CREATE TABLE IF NOT EXISTS clock_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  now_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
