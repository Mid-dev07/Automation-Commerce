const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const migrationPaths = [
  "migrations/0001_transaction_core.sql",
  "migrations/0002_multi_item_cart.sql",
  "migrations/0009_admin_activity_audit.sql"
];

class SQLiteStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  runSync() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes) } };
  }
  async run() {
    return this.runSync();
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
}

class SQLiteD1 {
  constructor(db) {
    this.sqlite = db;
  }
  prepare(sql) {
    return new SQLiteStatement(this.sqlite, sql);
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(statement => statement.runSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationPaths) {
    sqlite.exec(fs.readFileSync(path.join(root, file), "utf8"));
  }
  sqlite.prepare(
    "INSERT INTO app_meta(key,value,updated_at) VALUES('transaction_store_state','READY','2026-11-09T00:00:00+07:00')"
  ).run();
  return { sqlite, db: new SQLiteD1(sqlite) };
}

function addProduct(sqlite, sku, stock, price = 10000) {
  sqlite.prepare(
    "INSERT INTO catalog_products(sku,name,price,stock,active,photo_url,description,updated_at) " +
    "VALUES(?,?,?, ?,1,'','',?)"
  ).run(sku, "Produk " + sku, price, stock, "2026-11-09T00:00:00+07:00");
}

function checkoutInput(items, idempotencyKey, customerId = "1001") {
  return {
    items,
    idempotencyKey,
    channel: "telegram",
    customerId,
    customerName: "Pelanggan Uji",
    paymentMethod: "QRIS",
    shipping: 0,
    actor: "telegram:" + customerId
  };
}

let createCartOrderD1;
let cartInventoryReleaseStatements;
test.before(async () => {
  const cartModule = await import("../cart-layer.mjs");
  createCartOrderD1 = cartModule.createCartOrderD1;
  cartInventoryReleaseStatements = cartModule.cartInventoryReleaseStatements;
});

test("multi-item checkout creates one parent and one child row per SKU", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "SKU-A", 8, 12000);
    addProduct(sqlite, "SKU-B", 5, 25000);

    const order = await createCartOrderD1(db, checkoutInput([
      { sku: "SKU-A", quantity: 2 },
      { sku: "SKU-B", quantity: 1 }
    ], "cart-create-1"));

    assert.equal(order.sku, "MULTI");
    assert.equal(order.quantity, 3);
    assert.equal(order.subtotal, 49000);
    assert.equal(order.total, 49000);
    assert.equal(order.stock_reserved, true);
    assert.equal(order.items.length, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM order_items").get().n, 2);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-A'").get().stock, 6);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-B'").get().stock, 4);
  } finally {
    sqlite.close();
  }
});

test("insufficient stock rejects checkout without creating a partial order", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "SKU-A", 5, 10000);
    addProduct(sqlite, "SKU-B", 1, 20000);

    await assert.rejects(
      createCartOrderD1(db, checkoutInput([
        { sku: "SKU-A", quantity: 2 },
        { sku: "SKU-B", quantity: 2 }
      ], "cart-stock-low")),
      /Stok SKU-B tidak mencukupi/
    );

    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM order_items").get().n, 0);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-A'").get().stock, 5);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-B'").get().stock, 1);
  } finally {
    sqlite.close();
  }
});

test("duplicate checkout with the same idempotency key deducts stock only once", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "SKU-A", 4, 10000);
    const input = checkoutInput([{ sku: "SKU-A", quantity: 2 }], "cart-duplicate");
    const first = await createCartOrderD1(db, input);
    const second = await createCartOrderD1(db, input);

    assert.equal(first.order_id, second.order_id);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM order_items").get().n, 1);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-A'").get().stock, 2);
  } finally {
    sqlite.close();
  }
});

test("concurrent checkouts cannot reserve the final unit twice", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "SKU-LAST", 1, 15000);
    const attempts = await Promise.allSettled([
      createCartOrderD1(db, checkoutInput([{ sku: "SKU-LAST", quantity: 1 }], "race-a", "2001")),
      createCartOrderD1(db, checkoutInput([{ sku: "SKU-LAST", quantity: 1 }], "race-b", "2002"))
    ]);

    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter(result => result.status === "rejected").length, 1);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-LAST'").get().stock, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_movements WHERE movement_type='RESERVE'").get().n, 1);
  } finally {
    sqlite.close();
  }
});

test("cancelling a multi-item order releases each SKU exactly once", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "SKU-A", 7, 10000);
    addProduct(sqlite, "SKU-B", 3, 22000);
    const order = await createCartOrderD1(db, checkoutInput([
      { sku: "SKU-A", quantity: 2 },
      { sku: "SKU-B", quantity: 1 }
    ], "cart-cancel"));

    const at = "2026-11-09T12:00:00+07:00";
    const releaseStatements = cartInventoryReleaseStatements(db, order.order_id, at);
    await db.batch([
      db.prepare("UPDATE orders SET status='DIBATALKAN',updated_at=? WHERE order_id=? AND status='MENUNGGU_PEMBAYARAN'")
        .bind(at, order.order_id),
      ...releaseStatements
    ]);

    assert.equal(sqlite.prepare("SELECT stock_reserved FROM orders WHERE order_id=?").get(order.order_id).stock_reserved, 0);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-A'").get().stock, 7);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-B'").get().stock, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_movements WHERE order_id=? AND movement_type='RELEASE'")
      .get(order.order_id).n, 2);

    await db.batch(cartInventoryReleaseStatements(db, order.order_id, at));
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-A'").get().stock, 7);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-B'").get().stock, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_movements WHERE order_id=? AND movement_type='RELEASE'")
      .get(order.order_id).n, 2);
  } finally {
    sqlite.close();
  }
});

test("legacy single-SKU orders still reserve through inventory_movements", async () => {
  const { sqlite } = createDatabase();
  try {
    addProduct(sqlite, "SKU-LEGACY", 3, 11000);
    const at = "2026-11-09T12:00:00+07:00";
    sqlite.prepare(
      "INSERT INTO orders(order_id,created_at,created_ms,channel,customer_id,customer_name,sku,product_name," +
      "quantity,unit_price,subtotal,shipping,total,payment_method,status,stock_reserved,updated_at) " +
      "VALUES('LEGACY-ORDER',?,?, 'telegram','3001','Pelanggan','SKU-LEGACY','Produk Lama',2,11000,22000,0,22000,'QRIS','MENUNGGU_PEMBAYARAN',1,?)"
    ).run(at, Date.now(), at);
    sqlite.prepare(
      "INSERT INTO inventory_movements(order_id,sku,movement_type,quantity,created_at) " +
      "VALUES('LEGACY-ORDER','SKU-LEGACY','RESERVE',2,?)"
    ).run(at);

    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-LEGACY'").get().stock, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id='LEGACY-ORDER'").get().n, 0);
  } finally {
    sqlite.close();
  }
});

test("checkout rejects malformed methods, duplicate rows, and unsafe totals", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "SKU-A", 10, Number.MAX_SAFE_INTEGER);
    await assert.rejects(
      createCartOrderD1(db, { ...checkoutInput([{ sku: "SKU-A", quantity: 2 }], "unsafe"), paymentMethod: "CASH" }),
      /Metode pembayaran tidak valid/
    );
    await assert.rejects(
      createCartOrderD1(db, checkoutInput([{ sku: "SKU-A", quantity: 2 }], "unsafe-total")),
      /Subtotal produk SKU-A melebihi batas angka aman/
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);
  } finally {
    sqlite.close();
  }
});

