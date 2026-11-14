-- Dynamic QRIS checkout transactions and idempotent provider notifications.
CREATE TABLE IF NOT EXISTS qris_payments (
  order_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'midtrans'),
  provider_order_id TEXT NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  merchant_id TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','EXPIRED','FAILED')),
  raw_provider_status TEXT NOT NULL DEFAULT '',
  qr_image_url TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_qris_payments_status_created
  ON qris_payments(status, created_at DESC);

CREATE TABLE IF NOT EXISTS qris_webhook_events (
  provider TEXT NOT NULL CHECK (provider = 'midtrans'),
  event_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  transaction_status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_qris_webhook_events_order
  ON qris_webhook_events(order_id, received_at DESC);
