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
  assert.match(worker, /approvePaymentAndIssueTicket\(env, reference, "telegram:" \+ \(userId \|\| chatId\)\)/);
  assert.match(worker, /rejectPaymentRequest\(env, reference, "telegram:" \+ \(userId \|\| chatId\)\)/);
  assert.match(worker, /markOrderPickedUp\(env, reference, "telegram:" \+ \(userId \|\| chatId\)\)/);
  assert.match(worker, /resolveOrderReference\(env,reference\)/);
});

test("catalog blank stock remains unlimited and paid approval retry-safe", () => {
  assert.match(layer, /product\.stock == null \|\| product\.stock === "" \? null/);
  assert.match(worker, /stockText === "" \? null : Number\(stockText\)/);
  assert.match(layer, /alreadyApproved: true/);
  assert.match(layer, /status IN \('DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED'\)/);
  assert.match(layer, /Pesanan yang sudah dibatalkan tidak dapat dibuka kembali/);
});

test("Wrangler declares the SQLite DO class and D1 production binding", () => {
  const config = fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
  assert.match(config, /"binding": "DB"/);
  assert.match(config, /"database_name": "seiton-transactions-prod"/);
  assert.match(config, /"name": "ORDER_COORDINATOR"/);
  assert.match(config, /"type": "durable-object"/);
  assert.match(config, /"storage": "sqlite"/);
});

test("Google Sheets is only a best-effort mirror after transactional checkout", () => {
  assert.match(worker, /const order = await createOrderTransactional\(env,\{\.\.\.input,shipping\}\)/);
  assert.match(worker, /event:"order_sheet_mirror"/);
});

test("payment approval event records the actual previous status", () => {
  assert.match(layer, /SELECT order_id,'PAYMENT_APPROVED',\?,'DIBAYAR'/);
  assert.match(layer, /\.bind\(o\.status,clean\(actor,128\),sourceKey/);
  assert.match(layer, /const sourceKey = \"approve:\" \+ code/);
});

test("order lifecycle transitions are atomically mirrored into the admin activity audit", () => {
  assert.match(layer, /function adminActivityAuditStatement\(db, actor, action, resourceId, summary, at, sourceKey\)/);
  assert.match(layer, /INSERT INTO admin_activity_audit\(audit_id,actor_channel,actor_id,action,resource_type,resource_id,summary_json,created_at_ms\)/);
  assert.match(layer, /WHERE EXISTS \([\s\S]{0,180}FROM order_events WHERE order_id=\? AND event_type=\? AND source_key=\?/);

  const cases = [
    ["async function approvePaymentD1", "async function rejectPaymentD1", "PAYMENT_APPROVED"],
    ["async function rejectPaymentD1", "async function setOrderStatusD1", "PAYMENT_REJECTED"],
    ["async function setOrderStatusD1", "async function markPickedUpD1", "STATUS_CHANGED"],
    ["async function markPickedUpD1", "export async function bootstrapTransactions", "PICKED_UP"]
  ];
  for (const [startMarker, endMarker, action] of cases) {
    const start = layer.indexOf(startMarker);
    const end = layer.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, startMarker);
    assert.notEqual(end, -1, endMarker);
    assert.match(layer.slice(start, end), new RegExp("adminActivityAuditStatement\\(db,actor,\"" + action + "\""));
  }

  assert.match(layer, /if \(current === String\(status\)\.toUpperCase\(\)\) return \{ \.\.\.o, noStatusChange: true \}/);
  assert.match(layer, /SELECT order_id,'PICKED_UP',\?,'SELESAI'/);
  assert.match(layer, /String\(before\.status\|\|\"\"\)/);
});

test("coordinator audit is best-effort and bounded", () => {
  const start = layer.indexOf("  audit(operation,key,result)");
  const end = layer.indexOf("\n  async createOrder", start);
  const audit = layer.slice(start, end);
  assert.match(audit, /try \{/);
  assert.match(audit, /catch \(error\)/);
  assert.match(audit, /LIMIT 1 OFFSET 999/);
});

test("D1 outbox queues every order mirror mutation and reclaims expired leases", () => {
  assert.match(layer, /sheetMirrorStatement\(db,id,at\)/);
  assert.match(layer, /event_type IN \('SHEET_MIRROR','CATALOG_MIRROR'\)/);
  assert.match(layer, /status='PROCESSING',attempts=attempts\+1,available_at=\?/);
  assert.match(layer, /status='DONE',processed_at=\?,available_at=\?/);
  assert.match(layer, /const status=attempts>=8\?"FAILED":"PENDING"/);
});

test("scheduled dispatcher retries Sheets mirror and recovers orphaned append", () => {
  assert.match(worker, /async scheduled\(controller, env\)/);
  assert.match(worker, /dispatchSheetsMirrorOutbox\(env, 20\)/);
  assert.match(worker, /recoverAppend: true/);
  assert.match(worker, /Pesanan!A2:A/);
});

test("Wrangler config schedules outbox delivery every five minutes", () => {
  const config = fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
  assert.match(config, /"crons": \["\*\/5 \* \* \* \*"\]/);
});

test("product create, update, and soft-delete enqueue retryable catalog mirrors", () => {
  const saveStart=layer.indexOf("async function saveProductD1");
  const saveEnd=layer.indexOf("\nasync function deleteProductD1",saveStart);
  const save=layer.slice(saveStart,saveEnd);
  const deleteStart=layer.indexOf("async function deleteProductD1");
  const deleteEnd=layer.indexOf("\nasync function setLegacySheetRowD1",deleteStart);
  const remove=layer.slice(deleteStart,deleteEnd);
  assert.equal((save.match(/catalogMirrorStatement\(db,/g)||[]).length,2);
  assert.match(remove,/catalogMirrorStatement\(db,old\.sku,at\)/);
  assert.match(layer,/event_type IN \('SHEET_MIRROR','CATALOG_MIRROR'\)/);
});

test("scheduled outbox dispatch handles both order and catalog mirrors", () => {
  assert.match(worker,/event\.event_type === "CATALOG_MIRROR"/);
  assert.match(worker,/findProductTransactional\(env,\s*event\.aggregate_id\)/);
  assert.match(worker,/mirrorTransactionalProduct\(env, product\)/);
  assert.match(worker,/mirrorTransactionalOrder\(env, order, \{ recoverAppend: true \}\)/);
});

test("multi-item cart uses D1 child rows and keeps the parent order as payment unit", () => {
  const cart = fs.readFileSync(path.join(root, "cart-layer.mjs"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations/0002_multi_item_cart.sql"), "utf8");
  assert.match(cart, /await db\.batch\(statements\)/);
  assert.match(cart, /INSERT INTO order_items/);
  assert.match(cart, /INSERT INTO order_item_inventory_movements/);
  assert.match(cart, /idempotency_key/);
  assert.match(cart, /sku: "MULTI"/);
  assert.match(migration, /UNIQUE\(order_id, sku, movement_type\)/);
  assert.match(migration, /RAISE\(ABORT, 'INSUFFICIENT_STOCK'\)/);
  assert.match(migration, /WHEN NEW\.movement_type = 'RESERVE'/);
});

test("cart checkout and operations are serialized by the durable coordinator", () => {
  assert.match(layer, /from "\.\/cart-layer\.mjs"/);
  for (const method of [
    "getCartTransactional", "addCartItemTransactional", "updateCartItemTransactional",
    "removeCartItemTransactional", "clearCartTransactional", "checkoutCartTransactional"
  ]) assert.ok(layer.includes("export async function " + method));

  assert.match(layer, /getByName\("cart:"\+/);
  assert.match(layer, /CREATE TABLE IF NOT EXISTS cart_items/);
  assert.match(layer, /CREATE TABLE IF NOT EXISTS cart_meta/);
  assert.match(layer, /CREATE TABLE IF NOT EXISTS cart_mutations/);
  assert.match(layer, /transactionSync\(\(\)=>/);
  assert.match(layer, /async checkoutCart\(input\)/);
  assert.match(layer, /createCartOrderD1\(this\.env\.DB/);
});

test("cancelling a multi-item order releases all child SKU reservations atomically", () => {
  const start=layer.indexOf("async function setOrderStatusD1");
  const end=layer.indexOf("\nasync function markPickedUpD1",start);
  const code=layer.slice(start,end);
  assert.match(code, /String\(o\.sku \|\| ""\)\.toUpperCase\(\) === "MULTI"/);
  assert.match(code, /cartInventoryReleaseStatements\(db,id,at\)/);
  const cart = fs.readFileSync(path.join(root, "cart-layer.mjs"), "utf8");
  assert.match(cart, /INSERT OR IGNORE INTO order_item_inventory_movements/);
  assert.match(cart, /UPDATE orders SET stock_reserved=0/);
  assert.match(code, /PAID_STATUSES\.has\(current\)/);
});

test("legacy single-SKU checkout path remains active alongside cart checkout", () => {
  assert.match(layer, /async function createOrderD1\(db, input\)/);
  assert.match(layer, /export async function createOrderTransactional\(env,input\)/);
  assert.match(layer, /getByName\("sku:"\+sku\)/);
  assert.match(layer, /inventory_movements\(order_id,sku,movement_type,quantity,created_at\)/);
});
