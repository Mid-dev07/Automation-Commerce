const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "worker.js"), "utf8");
const layer = fs.readFileSync(path.join(root, "transaction-layer.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "migrations/0001_transaction_core.sql"), "utf8");

test("transaction layer and Worker are valid JavaScript modules", () => {
  assert.match(worker, /from "\.\/transaction-layer\.js"/);
  assert.match(layer, /from "cloudflare:workers"/);
});

test("D1 schema has unique order idempotency and stock ledger constraints", () => {
  assert.match(schema, /idempotency_key TEXT UNIQUE/);
  assert.match(schema, /UNIQUE\(order_id, movement_type\)/);
  assert.match(schema, /inventory_reserve_guard/);
  assert.match(schema, /INSUFFICIENT_STOCK/);
  assert.match(schema, /inventory_reserve_apply/);
  assert.match(schema, /inventory_release_apply/);
  assert.match(schema, /stock_reserved INTEGER NOT NULL DEFAULT 0/);
});

test("legacy orders are imported without a second stock deduction", () => {
  assert.match(layer, /stock_reserved,[\s\S]{0,80}VALUES\([\s\S]{0,120}\)\.bind\([\s\S]{0,600}clean\(r\[19\],40\),0,i\+2/);
  assert.ok(layer.includes('const importing="IMPORTING:"+Date.now();'));
  assert.ok(layer.includes("WHERE key='transaction_store_state' AND value=?"));
  assert.ok(layer.includes("value='READY',updated_at=?"));
});

test("new orders reserve finite stock in the same D1 batch", () => {
  const start = layer.indexOf("async function createOrderD1");
  const end = layer.indexOf("\n}", start);
  const code = layer.slice(start, end);
  assert.match(code, /await db\.batch\(\[/);
  assert.match(code, /INSERT OR IGNORE INTO inventory_movements/);
  assert.match(code, /idempotency_key = \?/);
  assert.match(layer, /getByName\("sku:"\+sku\)/);
});

test("Durable Object serializes payment and pickup state changes", () => {
  assert.match(layer, /export class OrderCoordinator extends DurableObject/);
  assert.match(layer, /enqueue\(fn\)/);
  assert.match(layer, /approvePaymentD1/);
  assert.match(layer, /markPickedUpD1/);
  assert.match(layer, /payment_confirmation_status='MENUNGGU_VERIFIKASI'/);
  assert.match(layer, /pickup_status='DIAMBIL'/);
});

test("Worker fails closed during migration and exposes admin-only bootstrap", () => {
  assert.match(worker, /transactionState\.configured && !transactionState\.ready/);
  assert.match(worker, /text === "\/migrasi_d1"/);
  assert.match(worker, /isAdmin\(chatId,env\)/);
  assert.match(worker, /transaction_store: tx\.ready \? "READY"/);
});

test("payment, status and pickup callbacks accept stable order IDs", () => {
  assert.match(worker, /approvePaymentAndIssueTicket\(env, reference\)/);
  assert.match(worker, /rejectPaymentRequest\(env, reference\)/);
  assert.match(worker, /markOrderPickedUp\(env, reference\)/);
  assert.match(worker, /resolveOrderReference\(env,reference\)/);
});

test("Google Sheets is only a best-effort mirror after transactional checkout", () => {
  assert.match(worker, /const order = await createOrderTransactional\(env,\{\.\.\.input,shipping\}\)/);
  assert.match(worker, /event:"order_sheet_mirror"/);
});
