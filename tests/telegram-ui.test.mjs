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
  buildCatalogKeypadKeyboard,
  buildCheckoutInlineKeyboard,
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
