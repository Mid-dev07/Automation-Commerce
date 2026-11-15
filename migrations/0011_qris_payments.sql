-- Internal QRIS payload issuance and receipt OCR reconciliation.
-- Replaces the un-applied Midtrans-only draft migration 0011.
CREATE TABLE IF NOT EXISTS qris_payments (
  order_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'internal_qris'),
  provider_order_id TEXT NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  merchant_id TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROOF_UPLOADED','OCR_MATCHED','OCR_MISMATCH','REVIEW','PAID','FAILED')),
  raw_provider_status TEXT NOT NULL DEFAULT '',
  qr_image_url TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT '',
  base_amount INTEGER NOT NULL CHECK (base_amount > 0),
  unique_code INTEGER NOT NULL CHECK (unique_code BETWEEN 1 AND 999),
  expected_amount INTEGER NOT NULL CHECK (expected_amount > base_amount),
  qris_payload TEXT NOT NULL,
  merchant_name TEXT NOT NULL DEFAULT '',
  merchant_city TEXT NOT NULL DEFAULT '',
  receipt_file_id TEXT NOT NULL DEFAULT '',
  receipt_file_unique_id TEXT NOT NULL DEFAULT '',
  receipt_file_type TEXT NOT NULL DEFAULT '',
  receipt_uploaded_at TEXT NOT NULL DEFAULT '',
  ocr_status TEXT NOT NULL DEFAULT 'NOT_RUN'
    CHECK (ocr_status IN ('NOT_RUN','MATCHED','MISMATCH','REVIEW','UNAVAILABLE')),
  ocr_result_json TEXT NOT NULL DEFAULT '{}',
  ocr_amount INTEGER,
  ocr_merchant_name TEXT NOT NULL DEFAULT '',
  ocr_transaction_at TEXT NOT NULL DEFAULT '',
  ocr_reference TEXT NOT NULL DEFAULT '',
  ocr_confidence REAL,
  ocr_checked_at TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

-- An amount cannot identify two QRIS orders, including historical/paid orders.
CREATE UNIQUE INDEX IF NOT EXISTS qris_payments_expected_amount_uq
  ON qris_payments(expected_amount);

-- Prevent a Telegram file or transaction reference being re-used for another order.
CREATE UNIQUE INDEX IF NOT EXISTS qris_payments_receipt_file_uq
  ON qris_payments(receipt_file_unique_id)
  WHERE receipt_file_unique_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS qris_payments_ocr_reference_uq
  ON qris_payments(ocr_reference)
  WHERE ocr_reference <> '';

CREATE INDEX IF NOT EXISTS qris_payments_status_idx
  ON qris_payments(status, created_at DESC);
