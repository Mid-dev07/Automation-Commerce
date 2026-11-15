-- Add explicit QRIS rendering mode and durable Telegram admin product-form drafts.
-- Existing payments remain DYNAMIC unless their row is newly created after this migration.
ALTER TABLE qris_payments
  ADD COLUMN qris_mode TEXT NOT NULL DEFAULT 'DYNAMIC'
  CHECK (qris_mode IN ('DYNAMIC','STATIC_FALLBACK'));

CREATE TABLE IF NOT EXISTS admin_product_drafts (
  admin_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('ADD','EDIT')),
  original_sku TEXT NOT NULL DEFAULT '',
  step_index INTEGER NOT NULL DEFAULT 0 CHECK (step_index BETWEEN 0 AND 7),
  steps_json TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS'
    CHECK (status IN ('IN_PROGRESS','REVIEW')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_product_drafts_expiry_idx
  ON admin_product_drafts(expires_at);
