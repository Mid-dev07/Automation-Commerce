-- Seiton.id transactional core (D1)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog_products (
  sku TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK(price >= 0),
  stock INTEGER CHECK(stock IS NULL OR stock >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  photo_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  channel TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
  unit_price INTEGER NOT NULL CHECK(unit_price >= 0),
  subtotal INTEGER NOT NULL CHECK(subtotal >= 0),
  shipping INTEGER NOT NULL CHECK(shipping >= 0),
  total INTEGER NOT NULL CHECK(total >= 0),
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_confirmation_status TEXT NOT NULL DEFAULT '',
  payment_proof_file_id TEXT NOT NULL DEFAULT '',
  payment_proof_type TEXT NOT NULL DEFAULT '',
  payment_requested_at TEXT NOT NULL DEFAULT '',
  payment_confirmed_at TEXT NOT NULL DEFAULT '',
  receipt_code TEXT UNIQUE,
  pickup_status TEXT NOT NULL DEFAULT '',
  stock_reserved INTEGER NOT NULL DEFAULT 0 CHECK(stock_reserved IN (0,1)),
  legacy_sheet_row INTEGER UNIQUE,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (sku) REFERENCES catalog_products(sku)
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, payment_confirmation_status, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders(sku, created_ms DESC);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK(movement_type IN ('RESERVE','RELEASE')),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  created_at TEXT NOT NULL,
  UNIQUE(order_id, movement_type),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (sku) REFERENCES catalog_products(sku)
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(order_id, event_type, source_key),
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, id DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DONE','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(event_type, aggregate_id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, available_at, id);

CREATE TRIGGER IF NOT EXISTS orders_safe_amounts
BEFORE INSERT ON orders
WHEN NEW.subtotal > 9007199254740991 OR NEW.total > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'AMOUNT_OUT_OF_SAFE_RANGE');
END;

CREATE TRIGGER IF NOT EXISTS inventory_reserve_guard
BEFORE INSERT ON inventory_movements
WHEN NEW.movement_type = 'RESERVE'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM catalog_products WHERE sku = NEW.sku AND active = 1
    ) THEN RAISE(ABORT, 'PRODUCT_UNAVAILABLE')
    WHEN (
      SELECT stock FROM catalog_products WHERE sku = NEW.sku
    ) IS NOT NULL AND (
      SELECT stock FROM catalog_products WHERE sku = NEW.sku
    ) < NEW.quantity THEN RAISE(ABORT, 'INSUFFICIENT_STOCK')
  END;
END;

CREATE TRIGGER IF NOT EXISTS inventory_reserve_apply
AFTER INSERT ON inventory_movements
WHEN NEW.movement_type = 'RESERVE'
BEGIN
  UPDATE catalog_products
  SET stock = stock - NEW.quantity, updated_at = NEW.created_at
  WHERE sku = NEW.sku AND stock IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS inventory_release_apply
AFTER INSERT ON inventory_movements
WHEN NEW.movement_type = 'RELEASE'
BEGIN
  UPDATE catalog_products
  SET stock = stock + NEW.quantity, updated_at = NEW.created_at
  WHERE sku = NEW.sku AND stock IS NOT NULL;
END;
