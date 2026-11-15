-- Per-store configuration for checkout payment methods and bank transfer destinations.
-- Existing orders and QRIS ledger records are intentionally not modified.
CREATE TABLE IF NOT EXISTS payment_method_settings (
  method_key TEXT PRIMARY KEY CHECK (method_key IN ('QRIS','TRANSFER','COD')),
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  instructions TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_bank_accounts (
  account_id TEXT PRIMARY KEY,
  bank_name TEXT NOT NULL CHECK (length(bank_name) BETWEEN 1 AND 80),
  account_holder TEXT NOT NULL CHECK (length(account_holder) BETWEEN 1 AND 100),
  account_number TEXT NOT NULL CHECK (
    length(account_number) BETWEEN 5 AND 32
    AND account_number NOT GLOB '*[^0-9]*'
  ),
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_bank_accounts_bank_number_uq
  ON payment_bank_accounts(lower(bank_name), account_number);

CREATE INDEX IF NOT EXISTS payment_bank_accounts_active_idx
  ON payment_bank_accounts(enabled, sort_order, bank_name);

INSERT OR IGNORE INTO payment_method_settings(method_key,display_name,enabled,instructions,updated_at)
VALUES
  ('QRIS','QRIS Dinamis',1,'Pindai QRIS dan pastikan nominal tepat.',datetime('now')),
  ('TRANSFER','Transfer Bank',1,'Transfer tepat sesuai total tagihan ke rekening resmi Seiton.id.',datetime('now')),
  ('COD','Bayar di Tempat (COD)',1,'Pembayaran dilakukan saat pesanan diterima.',datetime('now'));
