-- Phase 1 digital products: keep existing orders and inventory history intact.
-- New digital catalogue entries remain inactive until inventory and fulfillment QA pass.

CREATE TABLE IF NOT EXISTS digital_stock_accounts (
  stock_id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('muse_starter','muse_bisnis')),
  email_hash TEXT NOT NULL,
  email_domain TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  payload_nonce TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','CLAIMED','REVOKED')),
  claimed_order_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  revoked_at TEXT,
  UNIQUE(email_hash)
);

CREATE INDEX IF NOT EXISTS idx_digital_stock_available
  ON digital_stock_accounts(category,status,created_at,stock_id);

CREATE TABLE IF NOT EXISTS digital_fulfillments (
  order_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('WAITING_STOCK','CLAIMED','DELIVERED','SETUP_PENDING','SETUP_RECEIVED','CANCELLED')),
  stock_id TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  delivered_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(order_id),
  FOREIGN KEY(stock_id) REFERENCES digital_stock_accounts(stock_id)
);

CREATE INDEX IF NOT EXISTS idx_digital_fulfillments_status
  ON digital_fulfillments(status,updated_at);

CREATE TABLE IF NOT EXISTS digital_setup_requests (
  setup_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  setup_type TEXT NOT NULL CHECK(setup_type IN ('muse_bisnis','otp_setup')),
  business_name TEXT NOT NULL DEFAULT '',
  domain_name TEXT NOT NULL DEFAULT '',
  encrypted_payload TEXT NOT NULL,
  payload_nonce TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','IN_PROGRESS','COMPLETED','CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_digital_setup_status
  ON digital_setup_requests(status,created_at);

INSERT OR IGNORE INTO catalog_products
  (sku,name,price,stock,active,photo_url,description,updated_at)
VALUES
  ('MUSE-STARTER','Akun Muse Starter',25000,0,0,'',
   'Produk digital internal Telegram. Akun dikirim setelah pembayaran terkonfirmasi dan stok tersedia.','2026-11-13T00:00:00.000Z'),
  ('MUSE-BISNIS','Paket Muse Bisnis (Full Setup)',150000,0,0,'',
   'Paket akun dan layanan instalasi AI. Aktivasi setelah pemeriksaan infrastruktur, pembayaran, dan ketersediaan akun.','2026-11-13T00:00:00.000Z'),
  ('OTP-SETUP','Jasa Setup Domain & Portal OTP',100000,NULL,0,'',
   'Jasa konfigurasi email domain dan portal mailbox privat pada domain yang dimiliki atau diotorisasi pelanggan.','2026-11-13T00:00:00.000Z');

INSERT OR IGNORE INTO app_meta(key,value,updated_at)
VALUES('digital_products_schema','1','2026-11-13T00:00:00.000Z');
