const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const workerPath = path.join(root, "worker.js");
const transactionLayerPath = path.join(root, "transaction-layer.js");
const worker = fs.readFileSync(workerPath, "utf8");
const transactionLayer = fs.readFileSync(transactionLayerPath, "utf8");

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

test("web admin bearer tokens require an active D1 registry entry", () => {
  const migration = fs.readFileSync(path.join(root, "migrations", "0008_admin_web_sessions.sql"), "utf8");
  assert.ok(migration.includes("CREATE TABLE IF NOT EXISTS admin_web_sessions"));
  assert.ok(worker.includes("adminWebSessionTokenHash(token)"));
  assert.ok(worker.includes("FROM admin_web_sessions WHERE token_hash = ?"));
  assert.ok(worker.includes("revoked_at_ms"));
  assert.ok(worker.includes("INSERT INTO admin_web_sessions"));
  assert.ok(worker.includes("handleAdminWebSessionRevoke"));
  assert.ok(worker.includes("/api/admin/session/revoke"));
});

test("expired and long-revoked owner web sessions are pruned by the scheduled Worker", () => {
  assert.match(worker, /async function pruneAdminWebSessions\(env\)/);
  assert.match(worker, /DELETE FROM admin_web_sessions WHERE expires_at_ms <= \?/);
  assert.match(worker, /admin_web_session_cleanup_failed/);
});

test("order status, payment and pickup events attribute Telegram and web actors", () => {
  assert.match(worker, /setOrderStatusTransactional\(env,found\.order\.order_id,status,actor\)/);
  assert.match(worker, /approvePaymentTransactional\(env,found\.order\.order_id,actor\)/);
  assert.match(worker, /rejectPaymentTransactional\(env,found\.order\.order_id,actor\)/);
  assert.match(worker, /markPickedUpTransactional\(env,found\.order\.order_id,actor\)/);
  assert.match(worker, /"telegram:" \+ \(userId \|\| chatId\)/);
  assert.match(worker, /"web-admin"/);
});

test("Telegram admin actions create a content-safe activity trail", () => {
  assert.match(worker, /async function recordAdminActivity\(env, entry\)/);
  assert.match(worker, /INSERT INTO admin_activity_audit/);
  assert.match(worker, /HANDOFF_CLAIMED/);
  assert.match(worker, /HANDOFF_REPLY_QUEUED/);
  assert.match(worker, /HANDOFF_DECLINED/);
  assert.match(worker, /PRODUCT_CREATED/);
  assert.match(worker, /PRODUCT_UPDATED/);
  assert.match(worker, /PRODUCT_DELETED/);
  assert.match(worker, /REPORT_EXPORT_SENT/);
  assert.match(worker, /message_characters: handoffCommand\.message\.length/);
  assert.doesNotMatch(worker, /summary:\s*\{[^}]*message:\s*handoffCommand\.message/);
});

test("Telegram admin access is recorded and lifecycle activity is de-duplicated", () => {
  assert.match(worker, /action: "ADMIN_MENU_OPENED"/);
  assert.match(worker, /const auditedOrderEvents = new Set\(\)/);
  assert.match(worker, /auditedOrderEvents\.has\(orderAuditKey\(/);
  assert.match(worker, /adminAuditRows\.add|for \(const row of adminAuditRows\)/);
  assert.match(worker, /transition_type: action === "PAYMENT_REJECTED" \? "payment_confirmation" : "order_status"/);
});

test("operational audit endpoint is authenticated and reads order events plus admin activity", () => {
  assert.match(worker, /url\.pathname === "\/api\/admin\/activity-audit"/);
  assert.match(worker, /if \(!\(await verifyDashboardAccess\(request, env\)\)\)/);
  assert.match(worker, /FROM order_events WHERE event_type IN \('PAYMENT_APPROVED','PAYMENT_REJECTED','STATUS_CHANGED','PICKED_UP'\)/);
  assert.match(worker, /FROM admin_activity_audit ORDER BY created_at_ms DESC LIMIT \?/);
});


test("Telegram storefront uses branded menus and grouped admin navigation", () => {
  assert.match(worker, /SEITON_LOGO_URL = "https:\/\/seiton\.biz\.id\/logo-horizontal\.png"/);
  assert.match(worker, /sendSeitonWelcome\(env, chatId, true\)/);
  assert.match(worker, /sendSeitonWelcome\(env, chatId, false\)/);
  assert.match(worker, /callback_data: "adm:orders"/);
  assert.match(worker, /callback_data: "adm:products"/);
  assert.match(worker, /callback_data: "adm:reports"/);
  assert.match(worker, /callback_data: "adm:support"/);
  assert.match(worker, /function adminOrdersKeyboard\(\)/);
  assert.match(worker, /function adminProductsKeyboard\(\)/);
  assert.match(worker, /async function showCustomerCategoryMenu\(env, message\)/);
  assert.match(worker, /callback_data: "cat:items:"/);
  assert.match(worker, /callback_data: "view:"/);
  assert.match(worker, /data === "nav:guide"/);
});

test("QRIS checkout uses internal static-payload composition and unique-code receipt review", () => {
  assert.match(worker, /getQrisCheckoutMode/);
  assert.match(worker, /QRIS_CHECKOUT_NOT_CONFIGURED/);
  assert.match(worker, /buildDynamicQrisPayload/);
  assert.match(worker, /generateQrisUniqueCode/);
  assert.match(worker, /MAX_QRIS_TRANSACTION_AMOUNT/);
  assert.match(worker, /generateQrisUniqueCode\(\s*Math\.min\(999, MAX_QRIS_TRANSACTION_AMOUNT - baseAmount\)/);
  assert.match(worker, /expected_amount/);
  assert.match(worker, /runQrisReceiptOcr/);
  assert.match(worker, /ocr_status/);
  assert.match(worker, /OCR hanya mencocokkan isi gambar/);
  assert.match(worker, /WAJIB cocokkan mutasi\/riwayat transaksi merchant/);
  assert.doesNotMatch(worker, /handleMidtransWebhook/);
  assert.doesNotMatch(worker, /\/webhooks\/midtrans/);
  assert.match(worker, /callback_data: "qris:check:"/);
  assert.match(worker, /callback_data: "pc:req:" \+ order\.orderId/);
  assert.match(worker, /approvePaymentTransactional\(env,found\.order\.order_id,actor\)/);
  assert.doesNotMatch(worker, /UPDATE qris_payments SET status='PAID'/);
});

test("admin QRIS preview composes a real merchant QR without creating an order or payment row", () => {
  const start = worker.indexOf('if (/^\\/qris_test');
  const end = worker.indexOf('if (text.startsWith("/approve"))', start);
  assert.ok(start >= 0 && end > start, "admin QRIS preview command exists");
  const command = worker.slice(start, end);
  assert.match(command, /message\.chat\.type !== "private"/);
  assert.match(command, /isAdmin\(customerId, env\)/);
  assert.match(command, /buildDynamicQrisPayload\(env\.QRIS_STATIC_PAYLOAD, amount\)/);
  assert.match(command, /amount > MAX_QRIS_TRANSACTION_AMOUNT/);
  assert.match(command, /Rp1 sampai Rp10\.000\.000/);
  assert.match(command, /if \(!merchant\.merchantName\)/);
  assert.match(command, /qris_payments WHERE expected_amount/);
  assert.match(command, /QRIS_TEST_QR_GENERATED/);
  assert.doesNotMatch(command, /INSERT INTO qris_payments|createOrder\(/);
});

test("customer catalog shows unavailable products but only provides purchase buttons for sellable items", () => {
  assert.match(worker, /function customerCatalogProducts\(rows\)/);
  assert.match(worker, /function customerProductCanBeOrdered\(row\)/);
  assert.match(worker, /NONAKTIF/);
  assert.match(worker, /STOK HABIS/);
  assert.match(worker, /Produk nonaktif\/stok habis tidak dapat dibeli/);
  assert.match(worker, /customerCatalogProducts\(rows\)/);
});

test("Telegram product management uses durable step-by-step form drafts instead of pipe-separated fields", () => {
  assert.match(worker, /async function promptAdminProduct/);
  assert.match(worker, /async function handleAdminProductWizardReply/);
  assert.match(worker, /async function handleAdminProductWizardConfirm/);
  assert.match(worker, /admin_product_drafts/);
  assert.match(worker, /FIELD=/);
  assert.match(worker, /callback_data:"adm:productform:save:"\+formId/);
  assert.doesNotMatch(worker, /async function handleAdminProductForm\(/);
  assert.doesNotMatch(worker, /Kirim satu pesan dengan 7 kolom dipisahkan tanda/);
});

test("QRIS checkout presents dynamic mode first and static manual amount fallback", () => {
  assert.match(worker, /getQrisCheckoutMode\(env\)/);
  assert.match(worker, /STATIC_FALLBACK/);
  assert.match(worker, /QRIS STATIS SEITON\.ID/);
  assert.match(worker, /TRANSFER PERSIS:/);
  assert.match(worker, /qris_mode/);
  assert.match(worker, /QRIS \(Nominal Manual\)/);
});

test("customers can re-display their own active dynamic QRIS from Pesanan Saya", () => {
  assert.match(worker, /async function handleQrisPaymentShow\(env, message, chatId, userId, orderId\)/);
  assert.match(worker, /data\.startsWith\("qris:show:"\)/);
  assert.match(worker, /callback_data: "qris:show:" \+ orderId/);
  assert.match(worker, /text: "📲 Tampilkan QR " \+ orderId\.slice\(-8\)/);
  assert.match(worker, /String\(order\.customer_id\) !== String\(userId\)/);
  assert.match(worker, /payment\.status === "PAID"/);
  const handler = worker.slice(worker.indexOf("async function handleQrisPaymentShow"), worker.indexOf("async function handleQrisStatusCheck"));
  assert.ok(handler.includes('CANCELLED_ORDER_STATUSES.includes(String(order.status || "").toUpperCase())'));
  assert.ok(handler.includes("QRIS tidak dapat ditampilkan kembali"));
});


test("owner-only bot diagnostics validates Telegram API and reads transactional catalog/order health", () => {
  assert.match(worker, /async function handleAdminBotDiagnostics\(request, env\)/);
  assert.match(worker, /verifyDashboardAccess\(request, env\)[\s\S]{0,120}401/);
  assert.match(worker, /getMe/);
  assert.match(worker, /getWebhookInfo/);
  assert.match(worker, /telegram\.webhook_configured = webhookUrl === expectedWebhookUrl/);
  assert.match(worker, /FROM catalog_products/);
  assert.match(worker, /FROM orders/);
  assert.match(worker, /last_error_message/);
  assert.doesNotMatch(worker, /telegram_token:/i);
});

test("bot diagnostics endpoint is only exposed under an authenticated admin route", () => {
  assert.match(worker, /url\.pathname === "\/api\/admin\/bot\/diagnostics"[\s\S]{0,150}handleAdminBotDiagnostics/);
  assert.match(worker, /async function handleAdminBotDiagnostics/);
});


test("admin can manage payment methods and bank destinations through authenticated APIs", () => {
  assert.match(worker, /async function handleAdminPaymentMethods/);
  assert.match(worker, /verifyDashboardAccess\(request, env\)/);
  assert.match(worker, /payment_method_settings/);
  assert.match(worker, /payment_bank_accounts/);
  assert.match(worker, /data-method-toggle/);
  assert.match(worker, /data-bank-toggle/);
  assert.match(worker, /bankAccountForm/);
  const methodHandler = worker.slice(worker.indexOf("async function handleAdminPaymentMethods"), worker.indexOf("async function handleAdminPaymentAction"));
  assert.ok(methodHandler.includes("const enabled = body.enabled === undefined ? true : body.enabled"));
  assert.ok(methodHandler.includes('typeof enabled !== "boolean"'));
});

test("checkout only offers admin-enabled methods and transfer requires an active destination", () => {
  assert.match(worker, /async function getAvailablePaymentMethods/);
  assert.match(worker, /method\.available/);
  assert.match(worker, /accounts\.filter\(account => account\.enabled\)/);
  assert.match(worker, /availableMethods\.includes\(method\)/);
  assert.match(worker, /Metode pembayaran tersebut baru saja dinonaktifkan/);
  assert.ok(transactionLayer.includes("payment_method_settings pms"));
  assert.ok(transactionLayer.includes("payment_bank_accounts pba WHERE pba.enabled = 1"));
  assert.ok(transactionLayer.includes("createdAt, sku, qty, method, method"));
});

test("QRIS approval blocks amount and receipt mismatches and verifies payload amount", () => {
  assert.match(worker, /ocrStatus === "MISMATCH"/);
  assert.match(worker, /expectedAmount !== baseAmount \+ uniqueCode/);
  assert.match(worker, /parsedPayload\.amount !== expectedAmount/);
  assert.match(worker, /Bukti QRIS terdeteksi tidak cocok dengan nominal tagihan/);
});

test("repeated payment approval never sends a second receipt or digital fulfillment", () => {
  assert.match(worker, /if \(approved\.alreadyApproved\) \{[\s\S]{0,300}Tidak ada persetujuan atau pengiriman resi kedua/);
  assert.match(worker, /already_approved:true/);
  assert.match(worker, /Sudah disetujui sebelumnya; tidak ada persetujuan ulang/);
});


test("operational alerts are opt-in and report failed mirrors plus stale payment reviews", () => {
  assert.match(worker, /OPERATIONAL_ALERTS_ENABLED/);
  assert.match(worker, /async function dispatchOperationalAlerts\(env\)/);
  assert.match(worker, /operational_alert_state/);
  assert.match(worker, /status='FAILED'[\s\S]{0,120}SHEET_MIRROR/);
  assert.match(worker, /payment_requested_at<>''[\s\S]{0,120}2\.0\/24\.0/);
  assert.match(worker, /dispatchOperationalAlerts\(env\)/);
  assert.match(worker, /failed_mirror_outbox/);
  assert.match(worker, /stale_payment_verification/);
});

test("owner operations CRM never records a refund larger than net confirmed payments", async () => {
  const ownerOps = fs.readFileSync(path.join(root, "site-admin/owner-operations.js"), "utf8");
  assert.match(ownerOps, /type==="PENGEMBALIAN"/);
  assert.match(ownerOps, /Nominal pengembalian melebihi pembayaran bersih/);
  assert.match(ownerOps, /confirmedReceived!==true/);
});
