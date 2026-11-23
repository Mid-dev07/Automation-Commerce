-- Android notification listener devices, incoming payment mutation logs,
-- and HMAC-SHA256 outbound payment webhook endpoints/deliveries.

CREATE TABLE IF NOT EXISTS payment_listener_devices (
  device_id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  allowed_apps_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_seen_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payment_mutations (
  mutation_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL DEFAULT '',
  source_app TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  extracted_amount INTEGER,
  dedupe_key TEXT NOT NULL UNIQUE,
  match_status TEXT NOT NULL DEFAULT 'UNMATCHED'
    CHECK (match_status IN ('MATCHED','UNMATCHED','DUPLICATE','IGNORED','APPROVAL_FAILED')),
  matched_order_id TEXT NOT NULL DEFAULT '',
  match_note TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS payment_mutations_status_idx
  ON payment_mutations(match_status, received_at DESC);

CREATE INDEX IF NOT EXISTS payment_mutations_order_idx
  ON payment_mutations(matched_order_id)
  WHERE matched_order_id <> '';

CREATE TABLE IF NOT EXISTS payment_webhook_endpoints (
  endpoint_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '["payment.paid"]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL DEFAULT 'env-default',
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','DELIVERED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_http_status INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS payment_webhook_deliveries_pending_idx
  ON payment_webhook_deliveries(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS payment_webhook_deliveries_order_idx
  ON payment_webhook_deliveries(order_id, created_at DESC);
