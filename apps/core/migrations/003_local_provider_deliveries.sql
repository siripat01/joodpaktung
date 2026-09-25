CREATE TABLE IF NOT EXISTS local_provider_deliveries (
  notification_key text PRIMARY KEY,
  outbox_id uuid NOT NULL,
  order_id uuid NOT NULL,
  kind text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now()
);
