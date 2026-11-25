import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  MOBILE_TABLE_MAX_WIDTH,
  escapeHtml,
  formatRp,
  renderMonospaceTable,
  truncateText
} from "../src/order-bot/ui/formatters.mjs";
import {
  MENU_LABELS,
  buildCatalogInlineKeyboard,
  buildCatalogKeypadKeyboard,
  buildCheckoutInlineKeyboard,
  buildHistoryInlineKeyboard,
  buildMainReplyKeyboard,
  buildStockInlineKeyboard,
  hasButtonStyles,
  parseUiCallback,
  stripButtonStyles
} from "../src/order-bot/ui/keyboards.mjs";
import {
  renderCatalogScreen,
  renderGuideScreen,
  renderHistoryScreen,
  renderHomeScreen,
  renderProductCheckoutScreen,
  renderSearchResultsScreen,
  renderStockScreen
} from "../src/order-bot/ui/screens.mjs";
import {
  getBannerFileId,
  getCatalogMapping,
  getUiMode,
  listCustomerOrdersPage
} from "../src/order-bot/ui/state.mjs";
import {
  handleCustomerHybridCallback,
  handleCustomerHybridMessage
} from "../src/order-bot/ui/controller.mjs";
import {
  prepareTelegramContent,
  telegramApiRequest,
  updateTelegramMessage
} from "../src/order-bot/telegram-api.mjs";

function createMemoryKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const val = store.get(key);
      return type === "json" ? JSON.parse(val) : val;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    }
  };
}

function createMemoryD1(sqliteDb) {
  const makePrepared = (sql, params = []) => ({
    bind(...next) {
      return makePrepared(sql, next);
    },
    async first(col) {
      const row = sqliteDb.prepare(sql).get(...params);
      if (!row) return null;
      return col ? row[col] : row;
    },
    async all() {
      return { success: true, results: sqliteDb.prepare(sql).all(...params) };
    },
    async run() {
      const info = sqliteDb.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes || 0) } };
    }
  });
  return { prepare: (sql) => makePrepared(sql, []) };
}

function collectCallbackButtons(replyMarkup) {
  const rows = replyMarkup?.inline_keyboard || [];
  return rows.flat().filter((btn) => typeof btn?.callback_data === "string");
}

test("escapeHtml & formatRp sanitize dynamic values and avoid NaN/undefined", () => {
  assert.equal(escapeHtml(`<script>alert("x" & 'y')</script>`), "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;");
  assert.equal(formatRp(88500), "Rp 88.500");
  assert.equal(formatRp(0), "Rp 0");
  assert.equal(formatRp(null), "Rp 0");
  assert.equal(formatRp(undefined), "Rp 0");
  assert.equal(formatRp(Number.NaN), "Rp 0");
  assert.equal(formatRp(-500), "Rp 0");
  assert.equal(truncateText("Produk Sangat Panjang Sekali Untuk Layar HP", 12).length, 12);
});

test("monospace table stays within mobile 32-character budget and escapes HTML", () => {
  const html = renderMonospaceTable(
    [
      { label: "No", width: 2, align: "right" },
      { label: "Produk", width: 18, align: "left" },
      { label: "Harga", width: 10, align: "right" }
    ],
    [["1", "<Super> Long Product Name <b>Test</b>", "1.107.000"]]
  );
  assert.ok(html.startsWith("<pre>") && html.endsWith("</pre>"));
  assert.ok(!html.includes("<Super>") && !html.includes("<b>"));
  const inner = html.slice(5, -6).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const line of inner.split("\n")) {
    assert.ok(line.length <= MOBILE_TABLE_MAX_WIDTH, `line exceeded ${MOBILE_TABLE_MAX_WIDTH} chars: "${line}" (${line.length})`);
  }
});

test("keyboard builders enforce Opsi A (no Saldo), styles, <64B callbacks, and style stripping", () => {
  const mainKb = buildMainReplyKeyboard({ ENABLE_BUTTON_STYLES: "true" });
  assert.equal(mainKb.is_persistent, true);
  assert.equal(mainKb.resize_keyboard, true);
  assert.equal(hasButtonStyles(mainKb), true);
  const labels = mainKb.keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes(MENU_LABELS.LIST_PRODUCTS));
  assert.ok(labels.includes(MENU_LABELS.CHECK_STOCK));
  assert.ok(labels.includes(MENU_LABELS.HISTORY));
  assert.ok(labels.includes(MENU_LABELS.HOW_TO_ORDER));
  assert.ok(!labels.some((l) => /saldo/i.test(l)), "Opsi A must not show Saldo button");

  const strippedMain = stripButtonStyles(mainKb);
  assert.equal(hasButtonStyles(strippedMain), false);

  const keypad = buildCatalogKeypadKeyboard(6, { ENABLE_BUTTON_STYLES: "true" });
  assert.deepEqual(keypad.keyboard[0].map((b) => b.text), ["1", "2", "3"]);
  assert.deepEqual(keypad.keyboard[1].map((b) => b.text), ["4", "5", "6"]);
  assert.deepEqual(keypad.keyboard[2].map((b) => b.text), [MENU_LABELS.SEARCH_PRODUCTS, MENU_LABELS.MAIN_MENU]);

  const stockKb = buildStockInlineKeyboard({
    tab: "avail",
    availCount: 2,
    emptyCount: 1,
    page: 0,
    totalPages: 2,
    items: [{ sku: "SEI-VERY-LONG-PRODUCT-SKU-001", name: "Produk Panjang", stock: 5 }]
  });
  assert.equal(stockKb.inline_keyboard[0][0].style, "success");
  assert.equal(stockKb.inline_keyboard[0][1].style, "danger");
  for (const btn of collectCallbackButtons(stockKb)) {
    assert.ok(Buffer.byteLength(btn.callback_data, "utf8") < 64, "callback_data too long: " + btn.callback_data);
  }

  const chkKb = buildCheckoutInlineKeyboard({
    sku: "SEI-001",
    qty: 2,
    maxQty: 2,
    availableMethods: ["QRIS", "TRANSFER"],
    qrisMode: "DYNAMIC"
  });
  for (const btn of collectCallbackButtons(chkKb)) {
    assert.ok(Buffer.byteLength(btn.callback_data, "utf8") < 64);
  }
  // At maxQty=2, increment button must be noop:max (clamped)
  assert.equal(chkKb.inline_keyboard[0][2].callback_data, "noop:max");
});

test("parseUiCallback parses structured routes and rejects invalid payloads", () => {
  assert.deepEqual(parseUiCallback("stock:tab:empty:2"), { type: "STOCK_TAB", tab: "empty", page: 2 });
  assert.deepEqual(parseUiCallback("stock:refresh:avail:0"), { type: "STOCK_REFRESH", tab: "avail", page: 0 });
  assert.deepEqual(parseUiCallback("prod:view:MUSE-STARTER"), { type: "PROD_VIEW", sku: "MUSE-STARTER" });
  assert.deepEqual(parseUiCallback("chk:qty:SEI-001:3"), { type: "CHK_QTY", sku: "SEI-001", qty: 3 });
  assert.deepEqual(parseUiCallback("chk:pay:QRIS:SEI-001:2"), { type: "CHK_PAY", method: "QRIS", sku: "SEI-001", qty: 2 });
  assert.deepEqual(parseUiCallback("hist:page:1"), { type: "HIST_PAGE", page: 1 });
  assert.equal(parseUiCallback("chk:qty:SEI-001:0"), null);
  assert.equal(parseUiCallback("chk:pay:BITCOIN:SEI-001:1"), null);
  assert.equal(parseUiCallback("adm:home"), null);
});

test("all screens handle empty states safely without undefined/NaN and fit caption budgets", () => {
  const home = renderHomeScreen({ user: { id: "12345", firstName: "<Budi>", username: "" }, stats: {} });
  assert.ok(home.text.length <= 1024, "Home screen caption must fit Telegram 1024-char photo caption limit");
  assert.ok(home.text.includes("&lt;Budi&gt;"));
  assert.ok(home.text.includes("• Username: -"));
  assert.ok(!home.text.includes("undefined") && !home.text.includes("NaN"));

  for (const screen of [
    renderCatalogScreen({ items: [], page: 0, totalPages: 1, totalItems: 0 }),
    renderStockScreen({ tab: "avail", items: [], availCount: 0, emptyCount: 0, page: 0, totalPages: 1 }),
    renderStockScreen({ tab: "empty", items: [], availCount: 0, emptyCount: 0, page: 0, totalPages: 1 }),
    renderHistoryScreen({ orders: [], page: 0, totalPages: 1, totalCount: 0 }),
    renderGuideScreen({ SUPPORT_URL: "https://seiton.biz.id/kontak/" }),
    renderSearchResultsScreen({ query: "<kosong>", items: [] }),
    renderProductCheckoutScreen({ product: { sku: "HABIS-1", name: "Produk Habis", price: 50000, stock: 0 }, qty: 5, availableMethods: ["QRIS"] })
  ]) {
    assert.equal(screen.parseMode, "HTML");
    assert.ok(!screen.text.includes("undefined") && !screen.text.includes("NaN"), "Found undefined/NaN in: " + screen.text);
  }
});

test("telegramApiRequest retries once without button style on HTTP 400 and swallows message-not-modified", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ ok: false, description: "Bad Request: invalid button style field" }), { status: 400 });
      }
      if (calls.length === 2) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, description: "Bad Request: message is not modified" }), { status: 400 });
    };

    const env = { TELEGRAM_TOKEN: "test-token" };
    const styled = buildMainReplyKeyboard({ ENABLE_BUTTON_STYLES: "true" });
    const res = await telegramApiRequest(env, "sendMessage", { chat_id: "1", text: "Hi", reply_markup: styled });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 2, "must retry once with stripped button styles");
    assert.equal(hasButtonStyles(calls[0].body.reply_markup), true);
    assert.equal(hasButtonStyles(calls[1].body.reply_markup), false);

    // Silent handling of "message is not modified"
    const noopRes = await updateTelegramMessage(env, { chat: { id: "1" }, message_id: 99 }, { text: "Same", parseMode: "HTML" });
    assert.equal(noopRes.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("end-to-end hybrid UI flow caches banner file_id, maps keypad 1..N, edits stock in-place, and paginates orders per customer", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_transaction_core.sql", import.meta.url), "utf8"));
  sqlite.exec(`
    INSERT INTO app_meta(key, value, updated_at) VALUES ('transaction_store_state', 'READY', '2026-11-21T00:00:00+07:00');
    INSERT INTO catalog_products(sku, name, price, stock, active, photo_url, description, updated_at)
    VALUES
      ('SEI-001', 'Website Katalog', 259000, 5, 1, '', 'Katalog UMKM', '2026-11-21T00:00:00+07:00'),
      ('SEI-002', 'Bot Habis', 499000, 0, 1, '', 'Sedang habis', '2026-11-21T00:00:00+07:00');
    INSERT INTO orders(order_id, idempotency_key, created_at, created_ms, channel, customer_id, customer_name, sku, product_name, quantity, unit_price, subtotal, shipping, total, payment_method, status, updated_at)
    VALUES
      ('ORD-U1-1', 'k1', '2026-11-21T01:00:00+07:00', 1000, 'telegram', '777', 'User 1', 'SEI-001', 'Website Katalog', 1, 259000, 259000, 0, 259000, 'QRIS', 'DIBAYAR', '2026-11-21T01:00:00+07:00'),
      ('ORD-U2-1', 'k2', '2026-11-21T02:00:00+07:00', 2000, 'telegram', '888', 'User 2', 'SEI-001', 'Website Katalog', 2, 259000, 518000, 0, 518000, 'QRIS', 'DIBAYAR', '2026-11-21T02:00:00+07:00');
  `);

  const kv = createMemoryKv();
  const db = createMemoryD1(sqlite);
  const bgTasks = [];
  const ctx = { waitUntil: (p) => bgTasks.push(p) };
  const tgCalls = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url, init) => {
      const method = String(url).split("/").pop();
      const body = JSON.parse(init.body);
      tgCalls.push({ method, body });
      if (method === "sendPhoto") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 10, photo: [{ file_id: "CACHED_BANNER_FID" }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } }), { status: 200 });
    };

    const env = {
      TELEGRAM_TOKEN: "test-token",
      BOT_BANNER_URL: "https://seiton.biz.id/logo-horizontal.png",
      MUSE_KV: kv,
      DB: db
    };
    const deps = {
      isAdmin: () => false,
      readTelegramCatalogRows: async () => [],
      getAvailablePaymentMethods: async () => ["QRIS", "TRANSFER"],
      createOrder: async () => ({ orderId: "ORD-NEW" }),
      deliverOrderCheckout: async () => {}
    };

    // 1. First /start uploads URL and caches file_id via ctx.waitUntil
    await handleCustomerHybridMessage(env, ctx, { chat: { id: "777" }, from: { id: 777, first_name: "Budi", username: "budi" } }, "/start", deps);
    await Promise.all(bgTasks);
    assert.equal(tgCalls[0].method, "sendPhoto");
    assert.equal(tgCalls[0].body.photo, "https://seiton.biz.id/logo-horizontal.png");
    const cachedBanner = await getBannerFileId(env, "https://seiton.biz.id/logo-horizontal.png");
    assert.equal(cachedBanner.fileId, "CACHED_BANNER_FID");

    // 2. Second /start reuses cached Telegram file_id (zero re-upload)
    await handleCustomerHybridMessage(env, ctx, { chat: { id: "777" }, from: { id: 777, first_name: "Budi" } }, MENU_LABELS.MAIN_MENU, deps);
    assert.equal(tgCalls[1].method, "sendPhoto");
    assert.equal(tgCalls[1].body.photo, "CACHED_BANNER_FID");

    // 3. List Produk -> stores keypad mapping -> pressing "1" opens checkout card
    await handleCustomerHybridMessage(env, ctx, { chat: { id: "777" }, from: { id: 777, first_name: "Budi" } }, MENU_LABELS.LIST_PRODUCTS, deps);
    await Promise.all(bgTasks);
    const mapping = await getCatalogMapping(env, "777");
    assert.equal(mapping.skus.length, 2);

    const handledNum = await handleCustomerHybridMessage(env, ctx, { chat: { id: "777" }, from: { id: 777, first_name: "Budi" } }, "1", deps);
    assert.equal(handledNum, true);
    const lastSent = tgCalls[tgCalls.length - 1];
    assert.equal(lastSent.method, "sendMessage");
    assert.match(lastSent.body.text, /Checkout Produk/);

    // 4. Stock refresh callback edits in-place & answers with toast
    const beforeCount = tgCalls.length;
    const handledCb = await handleCustomerHybridCallback(env, ctx, {
      id: "cb-1",
      from: { id: 777, first_name: "Budi" },
      message: { chat: { id: 777 }, message_id: 42 },
      data: "stock:refresh:avail:0"
    }, deps);
    assert.equal(handledCb, true);
    const cbMethods = tgCalls.slice(beforeCount).map((c) => c.method);
    assert.ok(cbMethods.includes("answerCallbackQuery"));
    assert.ok(cbMethods.includes("editMessageText"));
    const ackCall = tgCalls.slice(beforeCount).find((c) => c.method === "answerCallbackQuery");
    assert.equal(ackCall.body.text, "✅ Stok diperbarui");

    // 5. Search mode set -> cleared when user hits Menu Utama
    await handleCustomerHybridMessage(env, ctx, { chat: { id: "777" }, from: { id: 777, first_name: "Budi" } }, MENU_LABELS.SEARCH_PRODUCTS, deps);
    await Promise.all(bgTasks);
    assert.equal((await getUiMode(env, "777"))?.mode, "WAITING_SEARCH");
    await handleCustomerHybridMessage(env, ctx, { chat: { id: "777" }, from: { id: 777, first_name: "Budi" } }, MENU_LABELS.MAIN_MENU, deps);
    await Promise.all(bgTasks);
    assert.equal(await getUiMode(env, "777"), null);

    // 6. Per-customer order pagination isolates customer 777 from customer 888
    const hist = await listCustomerOrdersPage(env, "777", 0, 5);
    assert.equal(hist.totalCount, 1);
    assert.equal(hist.orders[0].order_id, "ORD-U1-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog, stock, and search render full product names without <pre> SALIN KODE truncation and paginate in a single message", async () => {
  const longVariants = [
    { sku: "GEM-1M-PRIV", name: "Akun Gemini Pro 1 Bulan (Private Full Garansi)", price: 100000, stock: 12 },
    { sku: "GEM-1Y-PRIV", name: "Akun Gemini Pro 1 Tahun (Private Full Garansi)", price: 150000, stock: 8 },
    { sku: "GEM-2TB-FAM", name: "Akun Gemini Pro 2TB + Google One Family Plan", price: 175000, stock: null },
    { sku: "JP-GEM-1M", name: "Jaspay Gemini Pro 1 Bulan Via Invite Link", price: 100000, stock: 5 },
    { sku: "JP-GEM-3M", name: "Jaspay Gemini Pro 3 Bulan Via Login Akun", price: 125000, stock: 3 },
    { sku: "JP-GEM-1Y", name: "Jaspay Gemini Pro 1 Tahun Full Garansi Resmi", price: 150000, stock: 4 },
    { sku: "CLAUDE-PRO-1M", name: "Akun Claude 3.7 Sonnet Pro 1 Bulan Private", price: 320000, stock: 2 }
  ];

  const catScreen = renderCatalogScreen({
    items: longVariants.slice(0, 6),
    page: 0,
    totalPages: 2,
    totalItems: 7,
    lang: "id"
  });
  assert.doesNotMatch(catScreen.text, /<pre>/, "Catalog must not use <pre> (prevents Telegram SALIN KODE bar)");
  assert.match(catScreen.text, /<blockquote>/);
  // Every distinguishing variant title must appear in full without 18-char truncation!
  for (const item of longVariants.slice(0, 6)) {
    assert.ok(catScreen.text.includes(item.name), `Missing full product name: ${item.name}`);
  }
  const catCallbacks = collectCallbackButtons(catScreen.inlineKeyboard).map((b) => b.callback_data);
  assert.ok(catCallbacks.includes("prod:view:GEM-1M-PRIV:c0"));
  assert.ok(catCallbacks.includes("cat:page:1"));
  for (const cb of catCallbacks) {
    assert.ok(Buffer.byteLength(cb, "utf8") < 64, `Callback too long: ${cb}`);
  }

  const stockScreen = renderStockScreen({
    tab: "avail",
    items: longVariants.slice(0, 3),
    availCount: 7,
    emptyCount: 0,
    page: 0,
    totalPages: 2,
    lang: "id"
  });
  assert.doesNotMatch(stockScreen.text, /<pre>/, "Stock screen must not use <pre>");
  assert.ok(stockScreen.text.includes("Akun Gemini Pro 1 Bulan (Private Full Garansi)"));
  assert.ok(stockScreen.text.includes("Akun Gemini Pro 1 Tahun (Private Full Garansi)"));

  const searchScreen = renderSearchResultsScreen({
    query: "Gemini",
    items: longVariants.slice(0, 2),
    lang: "id"
  });
  assert.doesNotMatch(searchScreen.text, /<pre>/, "Search results must not use <pre>");
  assert.ok(searchScreen.text.includes("Akun Gemini Pro 1 Bulan (Private Full Garansi)"));
  assert.ok(searchScreen.text.includes("Akun Gemini Pro 1 Tahun (Private Full Garansi)"));

  // Verify multi-page List Produk sends ONLY ONE message (no duplicate stacked catalog!) and syncs page 2
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_transaction_core.sql", import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO app_meta(key, value, updated_at) VALUES ('transaction_store_state', 'READY', '2026-11-25T00:00:00+07:00');");
  const insertStmt = sqlite.prepare(
    "INSERT INTO catalog_products(sku, name, price, stock, active, photo_url, description, updated_at) VALUES (?, ?, ?, ?, 1, '', '', '2026-11-25T00:00:00+07:00')"
  );
  for (const v of longVariants) {
    insertStmt.run(v.sku, v.name, v.price, v.stock);
  }

  const kv = createMemoryKv();
  const db = createMemoryD1(sqlite);
  const bg = [];
  const ctx = { waitUntil: (p) => bg.push(p) };
  const tgCalls = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      const method = String(url).split("/").pop();
      const body = JSON.parse(init.body);
      tgCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), { status: 200 });
    };
    const env = { TELEGRAM_TOKEN: "test-token", MUSE_KV: kv, DB: db };
    const deps = {
      isAdmin: () => true, // Also verifies Admin testing Customer UI!
      readTelegramCatalogRows: async () => [],
      getAvailablePaymentMethods: async () => ["QRIS", "USDT"],
      createOrder: async () => ({ orderId: "ORD-X" }),
      deliverOrderCheckout: async () => {}
    };

    await handleCustomerHybridMessage(env, ctx, { chat: { id: "999" }, from: { id: 999, first_name: "Owner" } }, MENU_LABELS.LIST_PRODUCTS, deps);
    await Promise.all(bg);

    // Must send strictly 1 message (zero extra navigation message!)
    assert.equal(tgCalls.length, 1);
    assert.equal(tgCalls[0].method, "sendMessage");
    assert.ok(Array.isArray(tgCalls[0].body.reply_markup?.inline_keyboard));

    // Clicking Berikutnya (cat:page:1) edits that single message in-place & updates mapping to page 2
    await handleCustomerHybridCallback(env, ctx, {
      id: "cb-p2",
      from: { id: 999, first_name: "Owner" },
      message: { chat: { id: 999 }, message_id: 55 },
      data: "cat:page:1"
    }, deps);
    await Promise.all(bg);

    // getCatalogSnapshot sorts by name COLLATE NOCASE -> 7th item on page 2 is "Jaspay Gemini Pro 3 Bulan Via Login Akun" (JP-GEM-3M)
    const editCall = tgCalls.find((c) => c.method === "editMessageText");
    assert.ok(editCall, "Page 2 navigation must edit message in-place");
    assert.ok(editCall.body.text.includes("Jaspay Gemini Pro 3 Bulan Via Login Akun"));

    const page2Mapping = await getCatalogMapping(env, "999");
    assert.equal(page2Mapping.page, 1);
    assert.deepEqual(page2Mapping.skus, ["JP-GEM-3M"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("origin backCallback survives quantity changes, DITOLAK history shows re-upload button, and HTML captions >1024 never slice mid-tag", () => {
  // 1. Origin preservation across PROD_VIEW and CHK_QTY
  const viewParsed = parseUiCallback("prod:view:GEM-1Y-PRIV:c1");
  assert.deepEqual(viewParsed, { type: "PROD_VIEW", sku: "GEM-1Y-PRIV", backCallback: "cat:page:1" });

  const chkKb = buildCheckoutInlineKeyboard({
    sku: "GEM-1Y-PRIV",
    qty: 1,
    maxQty: 5,
    availableMethods: ["QRIS"],
    qrisMode: "DYNAMIC",
    backCallback: viewParsed.backCallback
  });
  const incBtn = chkKb.inline_keyboard[0][2];
  assert.equal(incBtn.callback_data, "chk:qty:GEM-1Y-PRIV:2:c1");
  const qtyParsed = parseUiCallback(incBtn.callback_data);
  assert.deepEqual(qtyParsed, { type: "CHK_QTY", sku: "GEM-1Y-PRIV", qty: 2, backCallback: "cat:page:1" });

  // 2. Rejected proof (DITOLAK) in Order History displays re-upload button
  const histKb = buildHistoryInlineKeyboard({
    orders: [{
      order_id: "SEI-20261125-REJ1",
      status: "DITOLAK",
      payment_confirmation_status: "DITOLAK",
      payment_method: "QRIS"
    }],
    page: 0,
    totalPages: 1,
    qrisAvailable: true,
    lang: "id"
  });
  const histCallbacks = collectCallbackButtons(histKb).map((b) => b.callback_data);
  assert.ok(histCallbacks.includes("pc:req:SEI-20261125-REJ1"), "Rejected order must offer pc:req re-upload button");

  // 3. Long HTML caption > 1024 chars safely strips HTML instead of leaving unclosed tags
  const hugeHtml = "<b>Judul Penting</b>\n<blockquote>" + "Detail produk lengkap sekali ".repeat(45) + "</blockquote>";
  assert.ok(hugeHtml.length > 1024);
  const safe = prepareTelegramContent(hugeHtml, 1024, "HTML");
  assert.ok(safe.text.length <= 1024);
  assert.equal(safe.parseMode, null);
  assert.ok(!safe.text.includes("<blockquote>") && !safe.text.includes("<b>"));
});
