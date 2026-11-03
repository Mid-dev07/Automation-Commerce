const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const workerPath = path.join(root, "worker.js");
const worker = fs.readFileSync(workerPath, "utf8");

function extractBetween(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, "start marker not found: " + start);
  assert.notEqual(b, -1, "end marker not found: " + end);
  return source.slice(a, b);
}

function evaluateFunction(source, name) {
  return vm.runInNewContext(source + "\n" + name, { Intl, Date, Number, String, Math, RegExp });
}

const parseOrderText = evaluateFunction(
  extractBetween(worker, "function parseOrderText(text) {", "async function createOrder(env, input) {"),
  "parseOrderText"
);
const parseCatalogProduct = evaluateFunction(
  extractBetween(worker, "function parseCatalogProduct(row) {", "async function findProduct(env, sku) {"),
  "parseCatalogProduct"
);
const csvCell = evaluateFunction(
  extractBetween(worker, "function csvCell(value) {", "function csvText(rows) {"),
  "csvCell"
);

test("worker module parses", () => {
  execFileSync(process.execPath, ["--check", workerPath], { stdio: "pipe" });
});

test("embedded dashboard JavaScript parses", () => {
  const line = worker.split("\n").find(value => value.startsWith("const ADMIN_DASHBOARD_HTML = "));
  assert.ok(line, "dashboard html constant exists");
  const html = JSON.parse(line.slice("const ADMIN_DASHBOARD_HTML = ".length, -1));
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, "dashboard inline script exists");
  new vm.Script(match[1], { filename: "admin-dashboard-inline.js" });
});

test("Telegram webhook fails closed without secret", () => {
  assert.match(worker, /if \(!env\.TELEGRAM_WEBHOOK_SECRET\) return json\(\{ ok: false, error: "Webhook security is not configured" \}, 503\)/);
  assert.match(worker, /X-Telegram-Bot-Api-Secret-Token/);
});

test("deferred WhatsApp handlers are absent", () => {
  assert.doesNotMatch(worker, /function verifyWhatsApp|function handleWhatsApp|function sendWhatsApp|WHATSAPP_API_VERSION/);
});

test("text order parser accepts only supported quantity and SKU limits", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseOrderText("beli SEI-001 1 QRIS"))), {
    sku: "SEI-001", quantity: 1, paymentMethod: "QRIS"
  });
  assert.equal(parseOrderText("beli SEI-001 1000 TRANSFER").quantity, 1000);
  assert.equal(parseOrderText("beli SEI-001 1001 QRIS"), null);
  assert.equal(parseOrderText("beli " + "S".repeat(41) + " 1 QRIS"), null);
  assert.equal(parseOrderText("beli SEI-001 0 QRIS"), null);
  assert.equal(parseOrderText("beli SEI-001 1 CASH"), null);
});

test("catalog parser distinguishes unlimited stock from malformed stock", () => {
  const unlimited = parseCatalogProduct(["SKU-1", "Produk", 10000, "", true]);
  assert.equal(unlimited.priceValid, true);
  assert.equal(unlimited.stockValid, true);
  assert.equal(unlimited.stock, null);

  const brokenStock = parseCatalogProduct(["SKU-2", "Produk", 10000, "banyak", true]);
  assert.equal(brokenStock.stockValid, false);
  assert.equal(brokenStock.stock, null);

  const brokenPrice = parseCatalogProduct(["SKU-3", "Produk", "", 10, true]);
  assert.equal(brokenPrice.priceValid, false);
  assert.equal(brokenPrice.active, true);
});

test("CSV cells neutralize formula prefixes, including whitespace-prefixed formulas", () => {
  assert.equal(csvCell("=HYPERLINK(\"https://bad.example\")"), "\"'=HYPERLINK(\"\"https://bad.example\"")\"");
  assert.equal(csvCell("  =1+1"), "\"'  =1+1\"");
  assert.equal(csvCell("@SUM(A1:A2)"), "\"'@SUM(A1:A2)\"");
  assert.equal(csvCell("-25000"), "\"-25000\"");
});

test("order and catalog append paths use RAW input", () => {
  assert.match(worker, /valueInputOption=RAW&insertDataOption=INSERT_ROWS/);
  assert.doesNotMatch(worker, /values\/Pesanan!A:M:append\?valueInputOption=USER_ENTERED/);
  assert.doesNotMatch(worker, /values\/Katalog_Produk!A:G:append\?valueInputOption=USER_ENTERED/);
});

test("admin product editor preserves the SKU being edited", () => {
  assert.match(worker, /name="original_sku"/);
  assert.match(worker, /String\(p\.original_sku \|\| ""\)/);
  assert.match(worker, /async function saveCatalogProduct/);
});

test("payment state transitions require online payment verification", () => {
  assert.match(worker, /async function setOrderStatus/);
  assert.match(worker, /Pembayaran QRIS\/transfer harus disetujui/);
  assert.match(worker, /Pesanan yang sudah dibayar tidak dapat dibatalkan/);
});

test("pickup actions require paid, approved orders", () => {
  assert.match(worker, /Resi pengambilan tidak ditemukan, dibatalkan, atau belum disetujui/);
  assert.match(worker, /Pesanan tidak memiliki resi pembayaran valid atau sudah dibatalkan/);
});

test("dashboard protects formula exports and avoids overlapping refresh calls", () => {
  assert.match(worker, /function csvCell\(value\)[\s\S]{0,250}\\u0000-\\u001f/);
  assert.match(worker, /refreshInFlight/);
  assert.match(worker, /chart\.js@4\.6\.1/);
});
