import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  MENU_LABELS_BY_LANG,
  buildAdminClaimUrl,
  convertIdrToStars,
  convertIdrToUsdt,
  formatDualPrice,
  loadIntlPaymentConfig,
  renderIntlPaymentInstructionsScreen,
  renderLanguageSelectScreen,
  renderVerifiedClaimScreen,
  resolveMenuIntent,
  saveIntlPaymentConfig
} from "../src/order-bot/ui/i18n.mjs";
import {
  buildCheckoutInlineKeyboard,
  buildMainReplyKeyboard,
  parseUiCallback
} from "../src/order-bot/ui/keyboards.mjs";
import {
  renderCatalogScreen,
  renderGuideScreen,
  renderHistoryScreen,
  renderHomeScreen,
  renderProductCheckoutScreen,
  renderStockScreen
} from "../src/order-bot/ui/screens.mjs";
import {
  getPendingProofOrder,
  getUserLang,
  setPendingProofOrder,
  setUserLang
} from "../src/order-bot/ui/state.mjs";
import {
  handleCustomerHybridCallback,
  handleCustomerHybridMessage
} from "../src/order-bot/ui/controller.mjs";
import {
  parseQuickQrisCommand,
  renderQuickQrisCaptionHtml
} from "../src/order-bot/ui/admin-screens.mjs";

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

test("bilingual menu intents and language selector work for both Indonesian and English", async () => {
  assert.equal(resolveMenuIntent(MENU_LABELS_BY_LANG.id.LIST_PRODUCTS), "LIST_PRODUCTS");
  assert.equal(resolveMenuIntent(MENU_LABELS_BY_LANG.en.LIST_PRODUCTS), "LIST_PRODUCTS");
  assert.equal(resolveMenuIntent(MENU_LABELS_BY_LANG.id.LANGUAGE), "LANGUAGE");
  assert.equal(resolveMenuIntent(MENU_LABELS_BY_LANG.en.LANGUAGE), "LANGUAGE");

  const enKb = buildMainReplyKeyboard({ ENABLE_BUTTON_STYLES: "true" }, "en");
  const enTexts = enKb.keyboard.flat().map((b) => b.text);
  assert.ok(enTexts.includes("🛍️ Products"));
  assert.ok(enTexts.includes("📦 Check Stock"));
  assert.ok(enTexts.includes("📜 My Orders"));
  assert.ok(enTexts.includes("🌐 Language / ID"));

  const langScreen = renderLanguageSelectScreen("en");
  assert.equal(langScreen.parseMode, "HTML");
  assert.match(langScreen.text, /Select Language/);
  assert.deepEqual(parseUiCallback("lang:set:en"), { type: "LANG_SET", lang: "en" });
  assert.deepEqual(parseUiCallback("lang:set:id"), { type: "LANG_SET", lang: "id" });
  assert.deepEqual(parseUiCallback("lang:open"), { type: "LANG_OPEN" });
});

test("IDR to USDT and Telegram Stars conversion plus D1 international config persistence", async () => {
  assert.equal(convertIdrToUsdt(80000, 16000), "5.00");
  assert.equal(convertIdrToUsdt(25000, 16000), "1.56");
  assert.equal(convertIdrToStars(35000, 350), 100);
  assert.equal(formatDualPrice(80000, { usd_exchange_rate: 16000, usdt_enabled: true }, "en"), "Rp 80.000 (≈ 5.00 USDT)");

  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);");
  const env = { DB: createMemoryD1(sqlite) };

  await saveIntlPaymentConfig(env, {
    usdt_enabled: true,
    usdt_network: "TRC20",
    usdt_wallet_address: "TSeitonWallet999999999",
    usd_exchange_rate: 15800,
    admin_telegram_username: "@seiton_owner"
  });

  const cfg = await loadIntlPaymentConfig(env);
  assert.equal(cfg.usdt_enabled, true);
  assert.equal(cfg.usdt_network, "TRC20");
  assert.equal(cfg.usdt_wallet_address, "TSeitonWallet999999999");
  assert.equal(cfg.usd_exchange_rate, 15800);
  assert.equal(cfg.admin_telegram_username, "seiton_owner");
});

test("international checkout keyboard, payment instructions, and post-payment direct-to-Admin claim screen", () => {
  const chkKb = buildCheckoutInlineKeyboard(
    {
      sku: "MUSE-PRO",
      qty: 2,
      maxQty: 10,
      availableMethods: ["QRIS", "USDT", "PAYPAL", "STARS", "TRANSFER"],
      qrisMode: "DYNAMIC",
      totalAmount: 160000,
      intlConfig: { usd_exchange_rate: 16000, stars_exchange_rate: 400 },
      lang: "en"
    },
    { ENABLE_BUTTON_STYLES: "true" }
  );
  const allButtons = chkKb.inline_keyboard.flat();
  assert.ok(allButtons.some((b) => b.callback_data === "chk:pay:USDT:MUSE-PRO:2" && b.text.includes("10.00 USDT")));
  assert.ok(allButtons.some((b) => b.callback_data === "chk:pay:PAYPAL:MUSE-PRO:2" && b.text.includes("$10.00")));
  assert.ok(allButtons.some((b) => b.callback_data === "chk:pay:STARS:MUSE-PRO:2" && b.text.includes("400")));
  assert.deepEqual(parseUiCallback("chk:pay:USDT:MUSE-PRO:2"), {
    type: "CHK_PAY",
    method: "USDT",
    sku: "MUSE-PRO",
    qty: 2
  });

  const usdtScreen = renderIntlPaymentInstructionsScreen({
    order: { orderId: "SEI-20261124-ABCD", product: "Muse Pro <AI>", quantity: 2, total: 160000 },
    method: "USDT",
    config: { usdt_network: "TRC20", usdt_wallet_address: "TWallet12345", usd_exchange_rate: 16000 },
    lang: "en"
  });
  assert.equal(usdtScreen.parseMode, "HTML");
  assert.match(usdtScreen.text, /10\.00 USDT/);
  assert.match(usdtScreen.text, /TWallet12345/);
  assert.ok(!usdtScreen.text.includes("<AI>"), "Must escape HTML in product name");

  const claimUrl = buildAdminClaimUrl(
    { SUPPORT_URL: "https://seiton.biz.id/kontak/" },
    { admin_telegram_username: "seiton_admin" },
    { orderId: "SEI-20261124-ABCD", product: "Muse Pro", quantity: 2, receiptCode: "SEI-RCP-99" },
    "en"
  );
  assert.ok(claimUrl.startsWith("https://t.me/seiton_admin?text="));
  assert.ok(decodeURIComponent(claimUrl).includes("SEI-20261124-ABCD"));
  assert.ok(decodeURIComponent(claimUrl).includes("SEI-RCP-99"));

  const claimScreen = renderVerifiedClaimScreen(
    {
      orderId: "SEI-20261124-ABCD",
      product: "Muse Pro",
      quantity: 2,
      total: 160000,
      paymentMethod: "USDT",
      receiptCode: "SEI-RCP-99",
      config: { admin_telegram_username: "seiton_admin", usd_exchange_rate: 16000 },
      lang: "en"
    },
    {}
  );
  assert.match(claimScreen.text, /PAYMENT VERIFIED/);
  assert.match(claimScreen.text, /Chat Admin — Claim Product/);
  const claimButtons = claimScreen.replyMarkup.inline_keyboard.flat();
  assert.ok(claimButtons.some((b) => b.url && b.url.startsWith("https://t.me/seiton_admin?text=")));
  assert.ok(claimButtons.some((b) => b.callback_data === "claim:bot:SEI-20261124-ABCD"));
  assert.deepEqual(parseUiCallback("claim:bot:SEI-20261124-ABCD"), {
    type: "CLAIM_BOT",
    orderId: "SEI-20261124-ABCD"
  });
});

test("first-time /start shows language chooser and switching to English renders English screens", async () => {
  const kv = createMemoryKv();
  const env = { MUSE_KV: kv, TELEGRAM_TOKEN: "test-token", ENABLE_BUTTON_STYLES: "true" };

  assert.deepEqual(await getUserLang(env, "u1"), { lang: "id", chosen: false });
  await setUserLang(env, "u1", "en");
  assert.deepEqual(await getUserLang(env, "u1"), { lang: "en", chosen: true });

  await setPendingProofOrder(env, "u1", "SEI-ORDER-77");
  const pending = await getPendingProofOrder(env, "u1");
  assert.equal(pending?.orderId, "SEI-ORDER-77");

  for (const screen of [
    renderHomeScreen({ user: { id: "u1", firstName: "Alice" }, stats: {}, lang: "en" }, env),
    renderCatalogScreen({ items: [{ sku: "S1", name: "Item 1", price: 32000 }], page: 0, totalPages: 1, totalItems: 1, lang: "en" }, env),
    renderStockScreen({ tab: "avail", items: [], availCount: 0, emptyCount: 0, page: 0, totalPages: 1, lang: "en" }, env),
    renderProductCheckoutScreen({ product: { sku: "S1", name: "Item 1", price: 32000, stock: 5 }, qty: 1, availableMethods: ["USDT"], intlConfig: { usd_exchange_rate: 16000 }, lang: "en" }, env),
    renderHistoryScreen({ orders: [], page: 0, totalPages: 1, totalCount: 0, lang: "en" }, env),
    renderGuideScreen(env, "en")
  ]) {
    assert.equal(screen.parseMode, "HTML");
    assert.ok(!screen.text.includes("undefined") && !screen.text.includes("NaN"));
  }
});

test("handleCustomerHybridCallback switches language and triggers claim:bot handler", async () => {
  const kv = createMemoryKv();
  const tgCalls = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      const method = String(url).split("/").pop();
      const body = JSON.parse(init.body);
      tgCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
    };
    const env = { MUSE_KV: kv, TELEGRAM_TOKEN: "test-token", ENABLE_BUTTON_STYLES: "true" };
    let claimedOrder = "";
    const deps = {
      isAdmin: () => false,
      readTelegramCatalogRows: async () => [],
      getAvailablePaymentMethods: async () => ["QRIS", "USDT"],
      createOrder: async () => ({ orderId: "ORD-1" }),
      deliverOrderCheckout: async () => {},
      handleClaimProductBot: async (_env, _ctx, _q, orderId) => {
        claimedOrder = orderId;
      }
    };

    const switched = await handleCustomerHybridCallback(env, null, {
      id: "cb-lang",
      from: { id: 501, first_name: "John" },
      message: { chat: { id: 501 }, message_id: 12 },
      data: "lang:set:en"
    }, deps);
    assert.equal(switched, true);
    assert.deepEqual(await getUserLang(env, "501"), { lang: "en", chosen: true });

    const claimed = await handleCustomerHybridCallback(env, null, {
      id: "cb-claim",
      from: { id: 501, first_name: "John" },
      message: { chat: { id: 501 }, message_id: 13 },
      data: "claim:bot:SEI-20261124-001"
    }, deps);
    assert.equal(claimed, true);
    assert.equal(claimedOrder, "SEI-20261124-001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin /qris+nominal and /qris <nominal> [note] command parser and HTML caption renderer", () => {
  assert.deepEqual(parseQuickQrisCommand("/qris+50000"), { ok: true, amount: 50000, note: "" });
  assert.deepEqual(parseQuickQrisCommand("/qris+150.000"), { ok: true, amount: 150000, note: "" });
  assert.deepEqual(parseQuickQrisCommand("/qris 75000"), { ok: true, amount: 75000, note: "" });
  assert.deepEqual(parseQuickQrisCommand("/qris+250000 Jasa Setup Website"), {
    ok: true,
    amount: 250000,
    note: "Jasa Setup Website"
  });
  assert.deepEqual(parseQuickQrisCommand("/qris@seiton_bot+88.500 Paket Pro"), {
    ok: true,
    amount: 88500,
    note: "Paket Pro"
  });
  assert.equal(parseQuickQrisCommand("/qris_test 10000"), null);
  assert.equal(parseQuickQrisCommand("/start"), null);
  assert.equal(parseQuickQrisCommand("/qris").ok, false);
  assert.equal(parseQuickQrisCommand("/qris+0").ok, false);
  assert.equal(parseQuickQrisCommand("/qris+15000000").ok, false);

  const caption = renderQuickQrisCaptionHtml({
    amount: 150000,
    merchantName: "SEITON.ID",
    merchantCity: "JEMBER",
    note: "Transaksi <Luar Bot>"
  });
  assert.match(caption, /<b>QRIS PEMBAYARAN — SEITON\.ID<\/b>/);
  assert.match(caption, /Rp 150\.000/);
  assert.match(caption, /SEITON\.ID \(JEMBER\)/);
  assert.ok(!caption.includes("<Luar Bot>"), "Must escape HTML in note");
  assert.ok(caption.includes("&lt;Luar Bot&gt;"));
});


