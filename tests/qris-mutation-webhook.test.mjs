import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  buildDynamicQrisPayload,
  buildQrisPayloadByMode,
  crc16CcittFalse,
  encodeEmvTlv,
  parseQrisPayload
} from "../qris.mjs";
import {
  parseMutationNotification,
  buildMutationDedupeKey,
  verifyMutationDeviceToken,
  sha256Hex
} from "../src/order-bot/payment-mutations.mjs";
import {
  validateWebhookTargetUrl,
  signWebhookPayload,
  verifyWebhookSignature,
  buildPaymentWebhookPayload,
  deliverSingleWebhook,
  enqueuePaymentWebhookDeliveries,
  dispatchPaymentWebhookDeliveries
} from "../src/order-bot/payment-webhooks.mjs";

function makeSampleStaticQris() {
  const body = encodeEmvTlv([
    { tag: "00", value: "01" },
    { tag: "01", value: "11" },
    { tag: "26", value: "0014ID.CO.GOPAY.WWW01189360091400000123450209123456789" },
    { tag: "52", value: "5499" },
    { tag: "53", value: "360" },
    { tag: "58", value: "ID" },
    { tag: "59", value: "SEITON STORE" },
    { tag: "60", value: "JAKARTA" }
  ]);
  const withCrcHeader = body + "6304";
  const crc = crc16CcittFalse(withCrcHeader).toString(16).toUpperCase().padStart(4, "0");
  return withCrcHeader + crc;
}

test("QRIS compatible mode keeps Tag 01=11 while locking Tag 54 and recomputing CRC", () => {
  const staticQris = makeSampleStaticQris();
  const compatible = buildQrisPayloadByMode(staticQris, 25007, "COMPATIBLE");
  const parsed = parseQrisPayload(compatible);
  assert.equal(parsed.pointOfInitiation, "11");
  assert.equal(parsed.amount, 25007);
  assert.equal(parsed.merchantName, "SEITON STORE");

  const dynamic = buildDynamicQrisPayload(staticQris, 25007);
  const parsedDyn = parseQrisPayload(dynamic);
  assert.equal(parsedDyn.pointOfInitiation, "12");
  assert.equal(parsedDyn.amount, 25007);

  const staticFallback = buildQrisPayloadByMode(staticQris, 25007, "STATIC_FALLBACK");
  assert.equal(staticFallback, staticQris);
});

test("GoPay Merchant & Indonesian merchant notification parser extracts exact incoming IDR", () => {
  const gopay = parseMutationNotification({
    source_app: "com.gojek.gopaymerchant",
    title: "Pembayaran QRIS masuk",
    text: "Kamu menerima pembayaran sebesar Rp 150.247 dari Pelanggan via QRIS."
  });
  assert.equal(gopay.accepted, true);
  assert.equal(gopay.amount, 150247);
  assert.equal(gopay.sourceApp, "com.gojek.gopaymerchant");

  const gobiz = parseMutationNotification({
    source_app: "com.gojek.gobiz",
    title: "Transaksi QRIS berhasil diterima",
    text: "Nominal IDR 25,003 telah masuk ke saldo toko."
  });
  assert.equal(gobiz.accepted, true);
  assert.equal(gobiz.amount, 25003);

  const promo = parseMutationNotification({
    source_app: "com.gojek.gopaymerchant",
    title: "Promo Cashback Rp 50.000",
    text: "Dapatkan cashback Rp 50.000 untuk pembayaran masuk hari ini!"
  });
  assert.equal(promo.accepted, false);
  assert.equal(promo.reason, "NON_INCOMING_NOTIFICATION");

  const outgoing = parseMutationNotification({
    source_app: "id.dana",
    title: "Transfer keluar berhasil",
    text: "Transfer keluar Rp 75.000 berhasil diproses."
  });
  assert.equal(outgoing.accepted, false);
  assert.equal(outgoing.reason, "NON_INCOMING_NOTIFICATION");
});

test("Mutation dedupe key is deterministic for identical notifications", async () => {
  const parsed = parseMutationNotification({
    source_app: "com.gojek.gopaymerchant",
    title: "Pembayaran masuk",
    text: "Terima pembayaran Rp 15.004",
    notification_id: "notif-12345"
  });
  const k1 = await buildMutationDedupeKey(parsed, 1_700_000_000_000);
  const k2 = await buildMutationDedupeKey(parsed, 1_700_000_999_000);
  assert.equal(k1, k2);
  assert.match(k1, /^[0-9a-f]{64}$/);
});

test("Device token verification fails closed and accepts matching env token", async () => {
  const denied = await verifyMutationDeviceToken({}, "dt_anything");
  assert.equal(denied.ok, false);

  const ok = await verifyMutationDeviceToken({ MUTATION_DEVICE_TOKEN: "dt_test_token_123" }, "dt_test_token_123");
  assert.equal(ok.ok, true);
  assert.equal(ok.deviceId, "env-device");

  const wrong = await verifyMutationDeviceToken({ MUTATION_DEVICE_TOKEN: "dt_test_token_123" }, "dt_wrong");
  assert.equal(wrong.ok, false);
  assert.match(await sha256Hex("dt_test_token_123"), /^[0-9a-f]{64}$/);
});

test("Webhook SSRF validator blocks local, private, metadata, and HTTP targets", () => {
  assert.equal(validateWebhookTargetUrl("https://hooks.example.com/qris").ok, true);
  assert.equal(validateWebhookTargetUrl("http://hooks.example.com/qris").ok, false);
  assert.equal(validateWebhookTargetUrl("https://localhost/webhook").ok, false);
  assert.equal(validateWebhookTargetUrl("https://127.0.0.1/webhook").ok, false);
  assert.equal(validateWebhookTargetUrl("https://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(validateWebhookTargetUrl("https://10.0.0.5/internal").ok, false);
  assert.equal(validateWebhookTargetUrl("https://192.168.1.1/hook").ok, false);
  assert.equal(validateWebhookTargetUrl("https://[::1]/hook").ok, false);
  assert.equal(validateWebhookTargetUrl("https://user:pass@hooks.example.com/qris").ok, false);
});

test("Webhook HMAC-SHA256 signing verifies raw payload and rejects replay/tampering", async () => {
  const payload = buildPaymentWebhookPayload(
    "payment.paid",
    { order_id: "ORD-101", total: 50000, customer_name: "Budi", receipt_code: "SEI-20261123-ABC123", payment_confirmed_at: "2026-11-23T09:00:00Z", created_at: "2026-11-23T08:55:00Z" },
    { provider_order_id: "QR-101", base_amount: 50000, unique_code: 7, expected_amount: 50007 },
    { sourceApp: "com.gojek.gopaymerchant" }
  );
  assert.equal(payload.event, "payment.paid");
  assert.equal(payload.total_amount, 50007);
  assert.equal(payload.external_order_id, "ORD-101");

  const rawBody = JSON.stringify(payload);
  const secret = "whsec_unit_test_secret";
  const nowSec = 1_760_000_000;
  const { timestamp, signature } = await signWebhookPayload(rawBody, secret, nowSec);

  const valid = await verifyWebhookSignature(rawBody, secret, timestamp, signature, nowSec + 10);
  assert.equal(valid.ok, true);

  const prefixed = await verifyWebhookSignature(rawBody, secret, timestamp, "sha256=" + signature, nowSec + 10);
  assert.equal(prefixed.ok, true);

  const tampered = await verifyWebhookSignature(rawBody + " ", secret, timestamp, signature, nowSec + 10);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, "SIGNATURE_MISMATCH");

  const stale = await verifyWebhookSignature(rawBody, secret, timestamp, signature, nowSec + 301);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "TIMESTAMP_OUT_OF_WINDOW");
});

test("deliverSingleWebhook sends flat JSON with Seiton HMAC headers", async () => {
  let captured = null;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return new Response("ok", { status: 200 });
  };
  const rawBody = JSON.stringify({ event: "payment.paid", external_order_id: "ORD-99", total_amount: 15003 });
  const res = await deliverSingleWebhook(
    "https://hooks.example.com/seiton",
    "whsec_mock_secret",
    "payment.paid",
    rawBody,
    "whd_123",
    1,
    mockFetch
  );
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(captured.url, "https://hooks.example.com/seiton");
  assert.equal(captured.init.headers["X-Seiton-Event"], "payment.paid");
  assert.equal(captured.init.headers["X-Seiton-Delivery-Id"], "whd_123");
  assert.equal(captured.init.headers["X-Seiton-Attempt"], "1");
  const verified = await verifyWebhookSignature(
    captured.init.body,
    "whsec_mock_secret",
    captured.init.headers["X-Seiton-Timestamp"],
    captured.init.headers["X-Seiton-Signature"]
  );
  assert.equal(verified.ok, true);
});

test("Migration 0015 defines mutation and webhook tables cleanly", () => {
  const sql = fs.readFileSync(
    path.resolve("migrations/0015_payment_mutations_and_webhooks.sql"),
    "utf8"
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_listener_devices/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_mutations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_webhook_endpoints/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_webhook_deliveries/);
});

function createD1Adapter(sqliteDb) {
  const runStatement = (sql, params) => {
    const stmt = sqliteDb.prepare(sql);
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
      return { success: true, results: stmt.all(...params), meta: { changes: 0 } };
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
    bind(...next) { return makePrepared(sql, next); },
    async first(col) {
      const row = sqliteDb.prepare(sql).get(...params);
      if (!row) return null;
      return col ? row[col] : row;
    },
    async all() {
      return { success: true, results: sqliteDb.prepare(sql).all(...params), meta: { changes: 0 } };
    },
    async run() { return runStatement(sql, params); }
  });
  return {
    prepare(sql) { return makePrepared(sql, []); },
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

test("E2E OrderCoordinator.approvePaymentByMutation is idempotent and dispatches signed webhook", async () => {
  const txPath = new URL("../transaction-layer.js", import.meta.url);
  const digitalUrl = pathToFileURL(new URL("../digital-products.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href;
  const txSource = fs.readFileSync(txPath, "utf8")
    .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }")
    .replace('from "./digital-products.mjs";', `from ${JSON.stringify(digitalUrl)};`);
  const { OrderCoordinator } = await import("data:text/javascript;base64," + Buffer.from(txSource, "utf8").toString("base64"));

  const sqlite = new DatabaseSync(":memory:");
  for (const rel of [
    "../migrations/0001_transaction_core.sql",
    "../migrations/0002_multi_item_cart.sql",
    "../migrations/0009_admin_activity_audit.sql",
    "../migrations/0010_digital_products.sql",
    "../migrations/0011_qris_payments.sql",
    "../migrations/0012_qris_static_fallback_product_form.sql",
    "../migrations/0013_payment_methods_and_bank_accounts.sql",
    "../migrations/0015_payment_mutations_and_webhooks.sql"
  ]) {
    sqlite.exec(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
  }
  sqlite.exec("INSERT INTO app_meta(key, value) VALUES ('transaction_store_state', 'READY')");

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const future = new Date(nowMs + 15 * 60_000).toISOString();
  sqlite.prepare(
    `INSERT INTO orders(order_id, idempotency_key, channel, customer_id, customer_name, sku, product_name, quantity, unit_price, subtotal, shipping, total, payment_method, status, payment_confirmation_status, created_at, created_ms, updated_at)
     VALUES ('ORD-MUT-1', 'idem-mut-1', 'TELEGRAM', '12345', 'Rina', 'SKU-1', 'Produk A', 1, 20000, 20000, 0, 20000, 'QRIS', 'MENUNGGU_PEMBAYARAN', '', ?, ?, ?)`
  ).run(now, nowMs, now);
  sqlite.prepare(
    `INSERT INTO qris_payments(order_id, provider, provider_order_id, amount, base_amount, unique_code, expected_amount, qris_payload, qris_mode, status, expires_at, created_at, updated_at)
     VALUES ('ORD-MUT-1', 'internal_qris', 'QR-MUT-1', 20007, 20000, 7, 20007, ?, 'STATIC_FALLBACK', 'PENDING', ?, ?, ?)`
  ).run(makeSampleStaticQris(), future, now, now);

  const db = createD1Adapter(sqlite);
  const env = {
    DB: db,
    PAYMENT_WEBHOOK_URL: "https://hooks.example.com/qris-paid",
    PAYMENT_WEBHOOK_SECRET: "whsec_e2e_secret"
  };
  const coordinator = new OrderCoordinator({ blockConcurrencyWhile: (fn) => fn(), storage: { sql: { exec() {} } } }, env);

  const [first, second] = await Promise.all([
    coordinator.approvePaymentByMutation("ORD-MUT-1", { mutationId: "mut_1", sourceApp: "com.gojek.gopaymerchant", amount: 20007 }, "qris-mutation:dev1"),
    coordinator.approvePaymentByMutation("ORD-MUT-1", { mutationId: "mut_2", sourceApp: "com.gojek.gopaymerchant", amount: 20007 }, "qris-mutation:dev1")
  ]);

  assert.equal(Boolean(first.alreadyApproved), false);
  assert.equal(Boolean(second.alreadyApproved), true);
  assert.equal(first.receipt_code, second.receipt_code);
  assert.equal(first.status, "DIBAYAR");

  const events = sqlite.prepare("SELECT COUNT(*) AS c FROM order_events WHERE order_id='ORD-MUT-1' AND event_type='PAYMENT_APPROVED'").get();
  assert.equal(Number(events.c), 1);

  const payload = buildPaymentWebhookPayload("payment.paid", first, { provider_order_id: "QR-MUT-1", base_amount: 20000, unique_code: 7, expected_amount: 20007 }, { sourceApp: "com.gojek.gopaymerchant" });
  const queued = await enqueuePaymentWebhookDeliveries(env, "payment.paid", payload);
  assert.equal(queued.enqueued, 1);

  let receivedSig = "";
  let receivedTs = "";
  let receivedBody = "";
  const dispatch = await dispatchPaymentWebhookDeliveries(env, 10, async (_url, init) => {
    receivedSig = init.headers["X-Seiton-Signature"];
    receivedTs = init.headers["X-Seiton-Timestamp"];
    receivedBody = init.body;
    return new Response("ok", { status: 200 });
  });
  assert.equal(dispatch.delivered, 1);
  assert.equal(dispatch.failed, 0);

  const verify = await verifyWebhookSignature(receivedBody, "whsec_e2e_secret", receivedTs, receivedSig);
  assert.equal(verify.ok, true);
});
