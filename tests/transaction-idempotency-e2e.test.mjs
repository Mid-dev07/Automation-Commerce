import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  encodeEmvTlv,
  crc16CcittFalse,
  getQrisCheckoutMode,
  isQrisCheckoutAvailable,
  isInternalQrisConfigured,
  isStaticQrisFallbackConfigured
} from "../qris.mjs";

const txPath = new URL("../transaction-layer.js", import.meta.url);
const digitalUrl = pathToFileURL(new URL("../digital-products.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href;
const txSource = readFileSync(txPath, "utf8")
  .replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
  )
  .replace('from "./digital-products.mjs";', `from ${JSON.stringify(digitalUrl)};`);

const txModule = await import("data:text/javascript;base64," + Buffer.from(txSource, "utf8").toString("base64"));
const {
  OrderCoordinator,
  claimSheetMirrorOutbox,
  failSheetMirrorOutbox
} = txModule;

function createD1Adapter(sqliteDb) {
  const runStatement = (sql, params) => {
    const stmt = sqliteDb.prepare(sql);
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
      const results = stmt.all(...params);
      return { success: true, results, meta: { changes: 0 } };
    }
    const info = stmt.run(...params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) }
    };
  };

  const makePrepared = (sql, params = []) => ({
    sql,
    params,
    bind(...next) {
      return makePrepared(sql, next);
    },
    async first(col) {
      const row = sqliteDb.prepare(sql).get(...params);
      if (!row) return null;
      return col ? row[col] : row;
    },
    async all() {
      return { success: true, results: sqliteDb.prepare(sql).all(...params), meta: { changes: 0 } };
    },
    async run() {
      return runStatement(sql, params);
    }
  });

  return {
    prepare(sql) {
      return makePrepared(sql, []);
    },
    async batch(statements) {
      sqliteDb.exec("BEGIN");
      try {
        const results = statements.map((st) => runStatement(st.sql, st.params));
        sqliteDb.exec("COMMIT");
        return results;
      } catch (error) {
        sqliteDb.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function createTestTransactionEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = [
    "../migrations/0001_transaction_core.sql",
    "../migrations/0002_multi_item_cart.sql",
    "../migrations/0009_admin_activity_audit.sql",
    "../migrations/0010_digital_products.sql",
    "../migrations/0011_qris_payments.sql",
    "../migrations/0012_qris_static_fallback_product_form.sql",
    "../migrations/0013_payment_methods_and_bank_accounts.sql"
  ];
  for (const rel of migrations) {
    sqlite.exec(readFileSync(new URL(rel, import.meta.url), "utf8"));
  }
  sqlite.exec(`
    INSERT OR REPLACE INTO app_meta(key, value, updated_at) VALUES ('transaction_store_state', 'READY', '2026-11-21T00:00:00+07:00');
    UPDATE payment_method_settings SET enabled = 1 WHERE method_key = 'TRANSFER';
    INSERT INTO payment_bank_accounts(bank_name, account_number, account_holder, enabled, sort_order, created_at, updated_at)
    VALUES ('BCA', '1234567890', 'Seiton Test', 1, 1, '2026-11-21T00:00:00+07:00', '2026-11-21T00:00:00+07:00');
    INSERT INTO catalog_products(sku, name, price, stock, active, photo_url, description, updated_at)
    VALUES ('SKU-LIMIT-1', 'Produk Stok Satu', 50000, 1, 1, '', '', '2026-11-21T00:00:00+07:00');
  `);

  const auditSqlite = new DatabaseSync(":memory:");
  const ctx = {
    blockConcurrencyWhile(fn) {
      return fn();
    },
    storage: {
      sql: {
        exec(sql, ...params) {
          if (params.length === 0) {
            auditSqlite.exec(sql);
            return [];
          }
          auditSqlite.prepare(sql).run(...params);
          return [];
        }
      }
    }
  };
  const db = createD1Adapter(sqlite);
  const env = { DB: db };
  const coordinator = new OrderCoordinator(ctx, env);
  return { sqlite, db, env, coordinator };
}

function makeSyntheticStaticQrisTemplate() {
  const merchantInfo = encodeEmvTlv([
    { tag: "00", value: "ID.CO.GOPAY.WWW" },
    { tag: "01", value: "9360091431234567890" },
    { tag: "02", value: "ID1020304050" },
    { tag: "03", value: "UMI" }
  ]);
  const body =
    encodeEmvTlv([
      { tag: "00", value: "01" },
      { tag: "01", value: "11" },
      { tag: "26", value: merchantInfo },
      { tag: "52", value: "5499" },
      { tag: "53", value: "360" },
      { tag: "58", value: "ID" },
      { tag: "59", value: "SEITON DEMO" },
      { tag: "60", value: "JEMBER" }
    ]) + "6304";
  return body + crc16CcittFalse(body).toString(16).toUpperCase().padStart(4, "0");
}

test("OrderCoordinator serializes concurrent checkouts and prevents overselling finite stock", async () => {
  const { sqlite, coordinator } = createTestTransactionEnv();
  const [first, second] = await Promise.allSettled([
    coordinator.createOrder({
      idempotencyKey: "checkout-concurrent-a",
      channel: "telegram",
      customerId: "cust-a",
      customerName: "Pembeli A",
      sku: "SKU-LIMIT-1",
      quantity: 1,
      paymentMethod: "TRANSFER"
    }),
    coordinator.createOrder({
      idempotencyKey: "checkout-concurrent-b",
      channel: "telegram",
      customerId: "cust-b",
      customerName: "Pembeli B",
      sku: "SKU-LIMIT-1",
      quantity: 1,
      paymentMethod: "TRANSFER"
    })
  ]);

  const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
  const rejected = [first, second].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one checkout should win the single unit of stock");
  assert.equal(rejected.length, 1, "second concurrent checkout must fail closed");
  assert.match(String(rejected[0].reason?.message || ""), /Stok tidak mencukupi/i);

  const stockRow = sqlite.prepare("SELECT stock FROM catalog_products WHERE sku='SKU-LIMIT-1'").get();
  const orderCount = sqlite.prepare("SELECT COUNT(*) AS cnt FROM orders").get();
  const reserveCount = sqlite.prepare("SELECT COUNT(*) AS cnt FROM inventory_movements WHERE movement_type='RESERVE'").get();
  assert.equal(Number(stockRow.stock), 0);
  assert.equal(Number(orderCount.cnt), 1);
  assert.equal(Number(reserveCount.cnt), 1);
});

test("parallel payment approval emits exactly one transition and one single receipt", async () => {
  const { sqlite, coordinator } = createTestTransactionEnv();
  const created = await coordinator.createOrder({
    idempotencyKey: "checkout-approve-parallel",
    channel: "telegram",
    customerId: "cust-pay",
    customerName: "Pembeli Transfer",
    sku: "SKU-LIMIT-1",
    quantity: 1,
    paymentMethod: "TRANSFER"
  });
  await coordinator.requestVerification(created.order_id, "cust-pay");

  const [r1, r2] = await Promise.all([
    coordinator.approvePayment(created.order_id, "admin-1"),
    coordinator.approvePayment(created.order_id, "admin-2")
  ]);

  assert.equal(r1.status, "DIBAYAR");
  assert.equal(r1.payment_confirmation_status, "DISETUJUI");
  assert.match(r1.receipt_code, /^SEI-\d{8}-[A-Z0-9]{6}$/);
  assert.equal(Boolean(r1.alreadyApproved), false);

  assert.equal(r2.alreadyApproved, true, "second parallel approval must be idempotent");
  assert.equal(r2.receipt_code, r1.receipt_code, "receipt code must never be regenerated or duplicated");

  const approvedEvents = sqlite.prepare(
    "SELECT COUNT(*) AS cnt FROM order_events WHERE order_id=? AND event_type='PAYMENT_APPROVED'"
  ).get(created.order_id);
  const auditEvents = sqlite.prepare(
    "SELECT COUNT(*) AS cnt FROM admin_activity_audit WHERE resource_id=? AND action='PAYMENT_APPROVED'"
  ).get(created.order_id);
  assert.equal(Number(approvedEvents.cnt), 1);
  assert.equal(Number(auditEvents.cnt), 1);
});

test("Google Sheets mirror failure retries in outbox without rolling back committed D1 order", async () => {
  const { sqlite, env, coordinator } = createTestTransactionEnv();
  const created = await coordinator.createOrder({
    idempotencyKey: "checkout-sheets-failure",
    channel: "telegram",
    customerId: "cust-sheet",
    customerName: "Pembeli Mirror",
    sku: "SKU-LIMIT-1",
    quantity: 1,
    paymentMethod: "TRANSFER"
  });
  await coordinator.requestVerification(created.order_id, "cust-sheet");
  const approved = await coordinator.approvePayment(created.order_id, "admin-1");

  const claimed = await claimSheetMirrorOutbox(env, 10);
  assert.ok(claimed.length >= 1, "order mutation must enqueue a retryable SHEET_MIRROR outbox item");
  const mirrorEvent = claimed.find((item) => item.aggregate_id === created.order_id);
  assert.ok(mirrorEvent);

  const rescheduled = await failSheetMirrorOutbox(env, mirrorEvent, new Error("GOOGLE_SHEETS_503"));
  assert.equal(rescheduled, true);

  const outboxRow = sqlite.prepare("SELECT status, attempts, available_at FROM outbox WHERE id=?").get(mirrorEvent.id);
  assert.equal(outboxRow.status, "PENDING");
  assert.equal(Number(outboxRow.attempts), 1);
  assert.ok(Date.parse(outboxRow.available_at) > Date.now(), "retry backoff must schedule available_at in the future");

  const persistedOrder = sqlite.prepare("SELECT status, payment_confirmation_status, receipt_code FROM orders WHERE order_id=?").get(created.order_id);
  assert.equal(persistedOrder.status, "DIBAYAR");
  assert.equal(persistedOrder.payment_confirmation_status, "DISETUJUI");
  assert.equal(persistedOrder.receipt_code, approved.receipt_code);
});

test("QRIS falls back cleanly to static merchant QR when dynamic flag is off", () => {
  const syntheticStaticPayload = makeSyntheticStaticQrisTemplate();

  const prodSafeEnv = {
    QRIS_INTERNAL_ENABLED: "false",
    QRIS_STATIC_FALLBACK_ENABLED: "true",
    QRIS_STATIC_PAYLOAD: syntheticStaticPayload
  };
  assert.equal(isInternalQrisConfigured(prodSafeEnv), false);
  assert.equal(isStaticQrisFallbackConfigured(prodSafeEnv), true);
  assert.equal(getQrisCheckoutMode(prodSafeEnv), "STATIC_FALLBACK");
  assert.equal(isQrisCheckoutAvailable(prodSafeEnv), true);

  const disabledEnv = {
    QRIS_INTERNAL_ENABLED: "false",
    QRIS_STATIC_FALLBACK_ENABLED: "false",
    QRIS_STATIC_PAYLOAD: syntheticStaticPayload
  };
  assert.equal(getQrisCheckoutMode(disabledEnv), "DISABLED");
  assert.equal(isQrisCheckoutAvailable(disabledEnv), false);

  const brokenTemplateEnv = {
    QRIS_INTERNAL_ENABLED: "true",
    QRIS_STATIC_FALLBACK_ENABLED: "true",
    QRIS_STATIC_PAYLOAD: "NOT_A_VALID_QRIS"
  };
  assert.equal(getQrisCheckoutMode(brokenTemplateEnv), "DISABLED");
  assert.equal(isQrisCheckoutAvailable(brokenTemplateEnv), false);
});
