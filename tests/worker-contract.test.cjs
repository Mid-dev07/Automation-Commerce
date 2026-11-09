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

test("Telegram handoff queue uses inline actions and admin-only state transitions", () => {
  assert.match(worker, /Bantuan Pelanggan[\s\S]{0,80}adm:handoff/);
  assert.match(worker, /async function showTelegramHandoffQueue/);
  assert.match(worker, /listMessagingHandoffs\(env, 20, "telegram"\)/);
  assert.match(worker, /callback_data: take/);
  assert.match(worker, /callback_data: decline/);
  assert.match(worker, /callback_data: done/);
  assert.match(worker, /function telegramHandoffCallback\(action, handoffId\)[\s\S]{0,180}length <= 64/);
  assert.match(worker, /if \(data\.startsWith\("hf:"\)\)[\s\S]{0,220}if \(!admin\)/);
  assert.match(worker, /resolveMessagingHandoff\(env, handoffId, chatId\)/);
  assert.match(worker, /declineMessagingHandoff\(env, handoffId, chatId\)/);
  assert.match(worker, /showTelegramHandoffQueue\(env, \{ chat: \{ id: chatId \} \}, chatId\)/);
});

test("handoff decline notice preserves explicit customer STOP preference", () => {
  assert.match(worker, /result\.conversationMode === "OPTED_OUT"[\s\S]{0,220}preferensi STOP tetap berlaku/);
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

  const fractionalPrice = parseCatalogProduct(["SKU-4", "Produk", 1000.5, 10, true]);
  assert.equal(fractionalPrice.priceValid, false);
});

test("CSV cells neutralize formula prefixes, including whitespace-prefixed formulas", () => {
  assert.equal(csvCell('=HYPERLINK("https://bad.example")'), '"\'=HYPERLINK(""https://bad.example"")"');
  assert.equal(csvCell("  =1+1"), '"\'  =1+1"');
  assert.equal(csvCell("@SUM(A1:A2)"), '"\'@SUM(A1:A2)"');
  assert.equal(csvCell("-25000"), '"-25000"');
});

test("order and catalog append paths use RAW input", () => {
  assert.match(worker, /valueInputOption=RAW&insertDataOption=INSERT_ROWS/);
  assert.doesNotMatch(worker, /values\/Pesanan!A:M:append\?valueInputOption=USER_ENTERED/);
  assert.doesNotMatch(worker, /values\/Katalog_Produk!A:G:append\?valueInputOption=USER_ENTERED/);
});

test("admin product editor preserves the SKU being edited", () => {
  assert.match(worker, /name=\\?"original_sku\\?"/);
  assert.match(worker, /String\(p\.original_sku \|\| ""\)/);
  assert.match(worker, /async function saveCatalogProduct/);
});

test("Rupiah amounts reject decimals and validate safe arithmetic", () => {
  assert.match(worker, /Number\.isSafeInteger\(price\)/);
  assert.match(worker, /Number\.isSafeInteger\(subtotal\)/);
  assert.match(worker, /Number\.isSafeInteger\(shipping\)/);
});

test("Telegram fallback send failures are logged, not rethrown", () => {
  assert.match(worker, /event:"telegram_fallback_notice"/);
});

test("Apps Script reporting timezone is Jakarta", () => {
  const script = fs.readFileSync(path.join(root, "setupDashboard.gs"), "utf8");
  assert.match(script, /setSpreadsheetTimeZone\("Asia\/Jakarta"\)/);
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

test("production observability captures logs, redacts query strings, and keeps traces disabled", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
  assert.equal(config.observability?.enabled, true);
  assert.equal(config.observability?.redact_query_string, true);
  assert.equal(config.observability?.logs?.enabled, true);
  assert.equal(config.observability?.logs?.invocation_logs, true);
  assert.equal(config.observability?.logs?.head_sampling_rate, 1);
  assert.equal(config.observability?.traces?.enabled, false);
});


test("admin login uses Cloudflare rate limiting and a per-client D1 lockout", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
  const limiter = config.ratelimits?.find(item => item.name === "ADMIN_LOGIN_RATE_LIMITER");
  assert.ok(limiter, "admin login rate limiter binding exists");
  assert.equal(limiter.simple?.limit, 10);
  assert.equal(limiter.simple?.period, 60);

  assert.match(worker, /ADMIN_LOGIN_RATE_LIMITER\.limit\(\{ key: clientKey \}\)/);
  assert.match(worker, /CF-Connecting-IP/);
  assert.match(worker, /SEITON_ADMIN_LOGIN_CLIENT_V1\./);
  assert.match(worker, /crypto\.subtle\.sign\([\s\S]{0,100}HMAC/);
  assert.match(worker, /ON CONFLICT\(client_key\) DO UPDATE/);
  assert.match(worker, /ADMIN_LOGIN_MAX_FAILURES = 5/);
  assert.match(worker, /ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 \* 60 \* 1000/);
  assert.match(worker, /ADMIN_LOGIN_LOCKOUT_MS = 15 \* 60 \* 1000/);
  assert.match(worker, /Retry-After/);
  assert.match(worker, /DELETE FROM admin_login_attempts WHERE client_key = \?/);

  const migration = fs.readFileSync(path.join(root, "migrations", "0007_admin_login_security.sql"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_login_attempts/);
  assert.match(migration, /client_key TEXT PRIMARY KEY/);
  assert.match(migration, /updated_at_ms INTEGER NOT NULL/);
  assert.doesNotMatch(migration, /ip_address|client_ip/i);
});


test("admin login verifies signed owner-panel client identity for service bindings", () => {
  assert.match(worker, /X-Seiton-Login-Client/);
  assert.match(worker, /X-Seiton-Login-Signature/);
  assert.match(worker, /SITE_ADMIN_LOGIN_SHARED_SECRET/);
  assert.ok(worker.includes("SEITON_SITE_ADMIN_LOGIN_V1."));
  assert.ok(worker.includes("crypto.subtle.verify"));
  assert.match(worker, /ADMIN_LOGIN_TRUSTED_CLIENT_INVALID/);
});
