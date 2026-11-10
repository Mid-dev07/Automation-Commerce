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
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  runSync() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes) } };
  }
  async run() { return this.runSync(); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
}

class SQLiteD1 {
  constructor(db) { this.sqlite = db; }
  prepare(sql) { return new SQLiteStatement(this.sqlite, sql); }
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
  for (const file of migrationPaths) sqlite.exec(fs.readFileSync(path.join(root, file), "utf8"));
  sqlite.prepare(
    "INSERT INTO app_meta(key,value,updated_at) VALUES('transaction_store_state','READY','2026-11-09T00:00:00+07:00')"
  ).run();
  return { sqlite, db: new SQLiteD1(sqlite) };
}

function addProduct(sqlite, sku, stock, price) {
  sqlite.prepare(
    "INSERT INTO catalog_products(sku,name,price,stock,active,photo_url,description,updated_at) VALUES(?,?,?, ?,1,'','',?)"
  ).run(sku, "Produk " + sku, price, stock, "2026-11-09T00:00:00+07:00");
}

function input(items, key, customerId = "PH6-CUSTOMER") {
  return {
    items, idempotencyKey: key, channel: "telegram", customerId,
    customerName: "Pelanggan Preview", paymentMethod: "QRIS", shipping: 0,
    actor: "telegram:" + customerId
  };
}

let createCartOrderD1;
let requestVerificationD1;
let savePaymentProofD1;
let approvePaymentD1;
let rejectPaymentD1;
let setOrderStatusD1;

test.before(async () => {
  ({ createCartOrderD1 } = await import("../cart-layer.mjs"));
  ({
    requestVerificationD1, savePaymentProofD1, approvePaymentD1,
    rejectPaymentD1, setOrderStatusD1
  } = await import("../order-lifecycle.mjs"));
});

test("multi-item cart checkout completes proof, approval, and processing without duplicate stock movement", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "PH6-PAY-A", 8, 12000);
    addProduct(sqlite, "PH6-PAY-B", 5, 25000);

    const order = await createCartOrderD1(db, input([
      { sku: "PH6-PAY-A", quantity: 2 },
      { sku: "PH6-PAY-B", quantity: 1 }
    ], "phase6-paid-flow"));
    assert.equal(order.sku, "MULTI");
    assert.equal(order.total, 49000);
    assert.equal(order.status, "MENUNGGU_PEMBAYARAN");
    assert.equal(order.stock_reserved, true);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-PAY-A'").get().stock, 6);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-PAY-B'").get().stock, 4);

    await assert.rejects(
      requestVerificationD1(db, order.order_id, "OTHER-CUSTOMER"),
      /bukan milik akun Telegram/
    );
    const requested = await requestVerificationD1(db, order.order_id, "PH6-CUSTOMER");
    assert.equal(requested.payment_confirmation_status, "MENUNGGU_VERIFIKASI");

    const proof = await savePaymentProofD1(
      db, order.order_id, "PH6-CUSTOMER", "SYNTHETIC-PREVIEW-PROOF", "image"
    );
    assert.equal(proof.payment_proof_file_id, "SYNTHETIC-PREVIEW-PROOF");
    assert.equal(proof.payment_proof_type, "image");

    const approved = await approvePaymentD1(db, order.order_id, "preview-admin");
    assert.equal(approved.status, "DIBAYAR");
    assert.equal(approved.payment_confirmation_status, "DISETUJUI");
    assert.equal(approved.pickup_status, "BELUM_DIAMBIL");
    assert.match(approved.receipt_code, /^SEI-\d{8}-[A-F0-9]{6}$/);
    const receipt = approved.receipt_code;

    const duplicateApproval = await approvePaymentD1(db, order.order_id, "preview-admin");
    assert.equal(duplicateApproval.alreadyApproved, true);
    assert.equal(duplicateApproval.receipt_code, receipt);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id=? AND event_type='PAYMENT_APPROVED'")
        .get(order.order_id).n,
      1
    );

    await assert.rejects(
      setOrderStatusD1(db, order.order_id, "DIBATALKAN", "preview-admin"),
      /Pesanan yang sudah dibayar tidak dapat dibatalkan/
    );
    const processing = await setOrderStatusD1(db, order.order_id, "DIPROSES", "preview-admin");
    assert.equal(processing.status, "DIPROSES");
    assert.equal(processing.receipt_code, receipt);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-PAY-A'").get().stock, 6);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-PAY-B'").get().stock, 4);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_movements WHERE order_id=? AND movement_type='RESERVE'")
        .get(order.order_id).n,
      2
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_movements WHERE order_id=? AND movement_type='RELEASE'")
        .get(order.order_id).n,
      0
    );
  } finally {
    sqlite.close();
  }
});

test("cancelled unpaid multi-item checkout releases every SKU exactly once", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "PH6-CANCEL-A", 7, 10000);
    addProduct(sqlite, "PH6-CANCEL-B", 4, 22000);
    const order = await createCartOrderD1(db, input([
      { sku: "PH6-CANCEL-A", quantity: 2 },
      { sku: "PH6-CANCEL-B", quantity: 1 }
    ], "phase6-cancel-flow"));

    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-CANCEL-A'").get().stock, 5);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-CANCEL-B'").get().stock, 3);

    const cancelled = await setOrderStatusD1(db, order.order_id, "DIBATALKAN", "preview-admin");
    assert.equal(cancelled.status, "DIBATALKAN");
    assert.equal(cancelled.stock_reserved, 0);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-CANCEL-A'").get().stock, 7);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-CANCEL-B'").get().stock, 4);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_movements WHERE order_id=? AND movement_type='RELEASE'")
        .get(order.order_id).n,
      2
    );

    await assert.rejects(
      setOrderStatusD1(db, order.order_id, "DIBATALKAN", "preview-admin"),
      /sudah dibatalkan tidak dapat dibuka kembali/
    );
    await assert.rejects(
      requestVerificationD1(db, order.order_id, "PH6-CUSTOMER"),
      /sudah dibatalkan/
    );
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-CANCEL-A'").get().stock, 7);
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-CANCEL-B'").get().stock, 4);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_movements WHERE order_id=? AND movement_type='RELEASE'")
        .get(order.order_id).n,
      2
    );
  } finally {
    sqlite.close();
  }
});

test("rejected payment can be resubmitted but a cancelled order cannot be reverified", async () => {
  const { sqlite, db } = createDatabase();
  try {
    addProduct(sqlite, "PH6-RETRY", 4, 15000);
    const order = await createCartOrderD1(db, input([
      { sku: "PH6-RETRY", quantity: 1 }
    ], "phase6-retry-flow"));

    await requestVerificationD1(db, order.order_id, "PH6-CUSTOMER");
    const rejected = await rejectPaymentD1(db, order.order_id, "preview-admin");
    assert.equal(rejected.payment_confirmation_status, "DITOLAK");
    assert.equal(rejected.status, "MENUNGGU_PEMBAYARAN");

    const retry = await requestVerificationD1(db, order.order_id, "PH6-CUSTOMER");
    assert.equal(retry.payment_confirmation_status, "MENUNGGU_VERIFIKASI");
    const repeatedRequest = await requestVerificationD1(db, order.order_id, "PH6-CUSTOMER");
    assert.equal(repeatedRequest.payment_confirmation_status, "MENUNGGU_VERIFIKASI");

    await setOrderStatusD1(db, order.order_id, "DIBATALKAN", "preview-admin");
    assert.equal(sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='PH6-RETRY'").get().stock, 4);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id=? AND event_type='PAYMENT_REJECTED'")
        .get(order.order_id).n,
      1
    );
  } finally {
    sqlite.close();
  }
});
