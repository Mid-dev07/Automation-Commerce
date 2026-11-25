/**
 * Single source of truth for Reply Keyboards, color-coded Inline Keyboards,
 * and structured callback_data (< 64 bytes) for Seiton.id Telegram Bot.
 * Supports bilingual mode ('id' / 'en') and flexible local + international payment methods.
 */

import { formatRp, truncateText } from "./formatters.mjs";
import {
  MENU_LABELS_BY_LANG,
  convertIdrToStars,
  convertIdrToUsdt,
  getMenuLabels,
  isAnyMainMenuLabel,
  normalizeLang
} from "./i18n.mjs";

export const MENU_LABELS = MENU_LABELS_BY_LANG.id;
export const MENU_LABELS_EN = MENU_LABELS_BY_LANG.en;

export const SUPPORTED_CHECKOUT_METHODS = Object.freeze([
  "QRIS",
  "USDT",
  "TRANSFER",
  "PAYPAL",
  "STARS",
  "COD"
]);

export const CATALOG_PAGE_SIZE = 6;
export const STOCK_PAGE_SIZE = 6;
export const HISTORY_PAGE_SIZE = 5;

export function buttonStylesEnabled(env) {
  return String(env?.ENABLE_BUTTON_STYLES ?? "true").toLowerCase() !== "false";
}

function styledButton(button, style, env) {
  if (!style || !buttonStylesEnabled(env)) return button;
  return { ...button, style };
}

export function isMainMenuLabel(text) {
  return isAnyMainMenuLabel(text);
}

/**
 * Strips non-standard `style` keys from inline_keyboard or keyboard markups
 * for graceful retry if Telegram Bot API returns HTTP 400 on button style fields.
 */
export function stripButtonStyles(replyMarkup) {
  if (!replyMarkup || typeof replyMarkup !== "object") return replyMarkup;
  const copy = { ...replyMarkup };
  if (Array.isArray(copy.inline_keyboard)) {
    copy.inline_keyboard = copy.inline_keyboard.map((row) =>
      row.map((btn) => {
        if (!btn || typeof btn !== "object" || !("style" in btn)) return btn;
        const { style: _ignored, ...rest } = btn;
        return rest;
      })
    );
  }
  if (Array.isArray(copy.keyboard)) {
    copy.keyboard = copy.keyboard.map((row) =>
      row.map((btn) => {
        if (!btn || typeof btn !== "object" || !("style" in btn)) return btn;
        const { style: _ignored, ...rest } = btn;
        return rest;
      })
    );
  }
  return copy;
}

export function hasButtonStyles(replyMarkup) {
  if (!replyMarkup || typeof replyMarkup !== "object") return false;
  const rows = [
    ...(Array.isArray(replyMarkup.inline_keyboard) ? replyMarkup.inline_keyboard : []),
    ...(Array.isArray(replyMarkup.keyboard) ? replyMarkup.keyboard : [])
  ];
  return rows.some((row) => Array.isArray(row) && row.some((btn) => btn && typeof btn === "object" && "style" in btn));
}

/**
 * Persistent Reply Keyboard (Opsi A — direct payment without Saldo/Wallet).
 * Layout: 2-2-2 grid (with quick Language toggle button).
 */
export function buildMainReplyKeyboard(env = {}, lang = "id") {
  const labels = getMenuLabels(lang);
  const isEn = normalizeLang(lang) === "en";
  return {
    keyboard: [
      [
        styledButton({ text: labels.LIST_PRODUCTS }, "primary", env),
        styledButton({ text: labels.CHECK_STOCK }, "primary", env)
      ],
      [
        styledButton({ text: labels.HISTORY }, "primary", env),
        styledButton({ text: labels.HOW_TO_ORDER }, "primary", env)
      ],
      [
        styledButton({ text: labels.SEARCH_PRODUCTS }, "primary", env),
        styledButton({ text: labels.LANGUAGE }, "primary", env)
      ]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: isEn
      ? "Choose a menu below or search products…"
      : "Pilih menu di bawah atau cari produk…"
  };
}

/**
 * Dynamic 3-column numeric keypad (1..N) for List Produk screen.
 */
export function buildCatalogKeypadKeyboard(itemCount, env = {}, lang = "id") {
  const labels = getMenuLabels(lang);
  const isEn = normalizeLang(lang) === "en";
  const count = Math.max(0, Math.min(9, Number(itemCount) || 0));
  const rows = [];
  for (let i = 1; i <= count; i += 3) {
    const row = [];
    for (let j = i; j < i + 3 && j <= count; j++) {
      row.push(styledButton({ text: String(j) }, "primary", env));
    }
    rows.push(row);
  }
  rows.push([
    styledButton({ text: labels.SEARCH_PRODUCTS }, "primary", env),
    styledButton({ text: labels.MAIN_MENU }, "primary", env)
  ]);
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: count > 0
      ? (isEn ? `Pick number 1–${count} or type search…` : "Pilih nomor 1–" + count + " atau ketik cari…")
      : (isEn ? "Return to Main Menu…" : "Kembali ke Menu Utama…")
  };
}

export function buildHomeInlineKeyboard(env = {}, lang = "id") {
  const isEn = normalizeLang(lang) === "en";
  return {
    inline_keyboard: [
      [
        styledButton({
          text: (!isEn ? "✓ " : "") + "🇮🇩 Indonesia",
          callback_data: "lang:set:id"
        }, !isEn ? "success" : "primary", env),
        styledButton({
          text: (isEn ? "✓ " : "") + "🇬🇧 English",
          callback_data: "lang:set:en"
        }, isEn ? "success" : "primary", env)
      ],
      [
        styledButton({
          text: isEn ? "🛍️ Browse Products" : "🛍️ Lihat Produk",
          callback_data: "cat:page:0"
        }, "success", env),
        styledButton({
          text: isEn ? "📜 My Orders" : "📜 Riwayat Pesanan",
          callback_data: "nav:orders"
        }, "primary", env)
      ]
    ]
  };
}

export function encodeBackOrigin(backCallback = "") {
  const cb = String(backCallback || "").trim();
  if (cb.startsWith("cat:page:")) {
    return "c" + Math.max(0, Number(cb.slice("cat:page:".length)) || 0);
  }
  if (cb.startsWith("stock:tab:avail:")) {
    return "sa" + Math.max(0, Number(cb.slice("stock:tab:avail:".length)) || 0);
  }
  if (cb.startsWith("stock:tab:empty:")) {
    return "se" + Math.max(0, Number(cb.slice("stock:tab:empty:".length)) || 0);
  }
  if (cb === "search:open") {
    return "sr";
  }
  return "";
}

export function decodeBackOrigin(origin = "") {
  const token = String(origin || "").trim();
  if (/^c\d{1,3}$/.test(token)) return "cat:page:" + Number(token.slice(1));
  if (/^sa\d{1,3}$/.test(token)) return "stock:tab:avail:" + Number(token.slice(2));
  if (/^se\d{1,3}$/.test(token)) return "stock:tab:empty:" + Number(token.slice(2));
  if (token === "sr") return "search:open";
  return "";
}

export function buildCatalogInlineKeyboard({ page = 0, totalPages = 1, items = [], lang = "id" }, env = {}) {
  const isEn = normalizeLang(lang) === "en";
  const safePage = Math.max(0, Number(page) || 0);
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const rows = [];

  (items || []).forEach((item, idx) => {
    const inStock = item.stock === null || Number(item.stock) > 0;
    const outSuffix = isEn ? " (Out)" : " (Habis)";
    const title = truncateText(item.name || item.sku, 32);
    const priceLabel = inStock ? " · " + formatRp(item.price) : outSuffix;
    const safeSku = String(item.sku || "").slice(0, 40);
    rows.push([
      styledButton({
        text: `${idx + 1}. ${title}${priceLabel}`,
        callback_data: `prod:view:${safeSku}:c${safePage}`
      }, inStock ? "success" : "danger", env)
    ]);
  });

  if (safeTotalPages > 1) {
    const navRow = [];
    if (safePage > 0) {
      navRow.push(styledButton({ text: isEn ? "◀️ Prev" : "◀️ Sebelumnya", callback_data: "cat:page:" + (safePage - 1) }, "primary", env));
    }
    navRow.push(styledButton({ text: (isEn ? "Page " : "Hal ") + (safePage + 1) + "/" + safeTotalPages, callback_data: "noop" }, "primary", env));
    if (safePage + 1 < safeTotalPages) {
      navRow.push(styledButton({ text: isEn ? "Next ▶️" : "Berikutnya ▶️", callback_data: "cat:page:" + (safePage + 1) }, "primary", env));
    }
    rows.push(navRow);
  }
  rows.push([
    styledButton({ text: isEn ? "🔍 Search" : "🔍 Cari", callback_data: "search:open" }, "primary", env),
    styledButton({ text: isEn ? "📦 Check Stock" : "📦 Cek Stok", callback_data: "stock:tab:avail:0" }, "primary", env)
  ]);
  rows.push([
    styledButton({ text: isEn ? "🏠 Main Menu" : "🏠 Menu Utama", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildStockInlineKeyboard({ tab, availCount, emptyCount, page, totalPages, items, lang = "id" }, env = {}) {
  const isEn = normalizeLang(lang) === "en";
  const rows = [];
  const activeTab = tab === "empty" ? "empty" : "avail";
  const safePage = Math.max(0, Number(page) || 0);
  const originCode = (activeTab === "empty" ? "se" : "sa") + safePage;
  rows.push([
    styledButton({
      text: (activeTab === "avail" ? "✓ " : "") + (isEn ? `Available (${availCount})` : "Tersedia (" + availCount + ")"),
      callback_data: "stock:tab:avail:0"
    }, "success", env),
    styledButton({
      text: (activeTab === "empty" ? "✓ " : "") + (isEn ? `Out of Stock (${emptyCount})` : "Habis (" + emptyCount + ")"),
      callback_data: "stock:tab:empty:0"
    }, "danger", env)
  ]);

  (items || []).forEach((item, idx) => {
    const inStock = item.stock === null || item.stock > 0;
    const outSuffix = isEn ? " (Out)" : " (Habis)";
    const priceSuffix = item.price != null && inStock ? " · " + formatRp(item.price) : (inStock ? "" : outSuffix);
    const label = `${idx + 1}. ${truncateText(item.name || item.sku, 32)}${priceSuffix}`;
    rows.push([
      styledButton({
        text: label,
        callback_data: "prod:view:" + String(item.sku).slice(0, 40) + ":" + originCode
      }, inStock ? "success" : "danger", env)
    ]);
  });

  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) {
      nav.push(styledButton({ text: isEn ? "◀️ Prev" : "◀️ Sebelumnya", callback_data: "stock:tab:" + activeTab + ":" + (safePage - 1) }, "primary", env));
    }
    nav.push(styledButton({ text: (isEn ? "Page " : "Hal ") + (safePage + 1) + "/" + totalPages, callback_data: "noop" }, "primary", env));
    if (safePage + 1 < totalPages) {
      nav.push(styledButton({ text: isEn ? "Next ▶️" : "Berikutnya ▶️", callback_data: "stock:tab:" + activeTab + ":" + (safePage + 1) }, "primary", env));
    }
    rows.push(nav);
  }

  rows.push([
    styledButton({ text: isEn ? "🔄 Refresh" : "🔄 Perbarui", callback_data: "stock:refresh:" + activeTab + ":" + safePage }, "primary", env)
  ]);
  rows.push([
    styledButton({ text: isEn ? "🔍 Search" : "🔍 Cari", callback_data: "search:open" }, "primary", env),
    styledButton({ text: isEn ? "🏠 Home" : "🏠 Beranda", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildCheckoutInlineKeyboard(
  { sku, qty, maxQty, availableMethods, qrisMode, backCallback, totalAmount = 0, intlConfig = {}, lang = "id" },
  env = {}
) {
  const isEn = normalizeLang(lang) === "en";
  const rows = [];
  const safeSku = String(sku || "").slice(0, 36);
  const canBuy = maxQty === null || maxQty > 0;
  const safeQty = Math.max(1, Number(qty) || 1);
  const originSuffix = backCallback ? (encodeBackOrigin(backCallback) ? ":" + encodeBackOrigin(backCallback) : "") : "";

  if (canBuy) {
    const decAllowed = safeQty > 1;
    const incAllowed = maxQty === null ? safeQty < 99 : safeQty < Math.min(99, maxQty);
    rows.push([
      styledButton({
        text: "➖",
        callback_data: decAllowed ? "chk:qty:" + safeSku + ":" + (safeQty - 1) + originSuffix : "noop:min"
      }, decAllowed ? "primary" : "danger", env),
      styledButton({
        text: "Qty: " + safeQty,
        callback_data: "noop"
      }, "primary", env),
      styledButton({
        text: "➕",
        callback_data: incAllowed ? "chk:qty:" + safeSku + ":" + (safeQty + 1) + originSuffix : "noop:max"
      }, incAllowed ? "primary" : "danger", env)
    ]);

    const methods = Array.isArray(availableMethods) ? availableMethods : [];
    const usdtText = totalAmount > 0 ? ` (${convertIdrToUsdt(totalAmount, intlConfig?.usd_exchange_rate)} USDT)` : "";
    const usdText = totalAmount > 0 ? ` ($${convertIdrToUsdt(totalAmount, intlConfig?.usd_exchange_rate)})` : "";
    const starsText = totalAmount > 0 ? ` (⭐ ${convertIdrToStars(totalAmount, intlConfig?.stars_exchange_rate)})` : "";

    if (methods.includes("QRIS")) {
      const qrisLabel = isEn
        ? (qrisMode === "DYNAMIC" ? "⚡ Pay with QRIS (IDR)" : "📷 Pay with QRIS (Manual)")
        : (qrisMode === "DYNAMIC" ? "⚡ Bayar QRIS" : "📷 Bayar QRIS (Manual)");
      rows.push([
        styledButton({
          text: qrisLabel,
          callback_data: "chk:pay:QRIS:" + safeSku + ":" + safeQty
        }, "success", env)
      ]);
    }
    if (methods.includes("USDT")) {
      rows.push([
        styledButton({
          text: (isEn ? "💎 Pay with USDT" : "💎 Bayar USDT") + usdtText,
          callback_data: "chk:pay:USDT:" + safeSku + ":" + safeQty
        }, "success", env)
      ]);
    }
    if (methods.includes("PAYPAL")) {
      rows.push([
        styledButton({
          text: (isEn ? "🅿️ Pay with PayPal" : "🅿️ Bayar PayPal") + usdText,
          callback_data: "chk:pay:PAYPAL:" + safeSku + ":" + safeQty
        }, "primary", env)
      ]);
    }
    if (methods.includes("STARS")) {
      rows.push([
        styledButton({
          text: (isEn ? "⭐ Pay with Telegram Stars" : "⭐ Bayar Telegram Stars") + starsText,
          callback_data: "chk:pay:STARS:" + safeSku + ":" + safeQty
        }, "primary", env)
      ]);
    }
    if (methods.includes("TRANSFER")) {
      rows.push([
        styledButton({
          text: isEn ? "🏦 Bank Transfer (IDR)" : "🏦 Bayar Transfer Bank",
          callback_data: "chk:pay:TRANSFER:" + safeSku + ":" + safeQty
        }, "primary", env)
      ]);
    }
    if (methods.includes("COD")) {
      rows.push([
        styledButton({
          text: isEn ? "💵 Cash on Delivery (COD)" : "💵 Pesan COD",
          callback_data: "chk:pay:COD:" + safeSku + ":" + safeQty
        }, "primary", env)
      ]);
    }
  }

  rows.push([
    styledButton({ text: isEn ? "⬅️ Back" : "⬅️ Kembali", callback_data: backCallback || "cat:page:0" }, "primary", env),
    styledButton({ text: isEn ? "🏠 Home" : "🏠 Beranda", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildHistoryInlineKeyboard({ orders, page, totalPages, qrisAvailable, lang = "id" }, env = {}) {
  const isEn = normalizeLang(lang) === "en";
  const rows = [];
  for (const order of orders || []) {
    const orderId = String(order.order_id || "");
    const suffix = orderId.slice(-8);
    const payConfirm = String(order.payment_confirmation_status || "").toUpperCase();
    const status = String(order.status || "").toUpperCase();
    const method = String(order.payment_method || "").toUpperCase();
    if (payConfirm === "DISETUJUI" && order.receipt_code) {
      rows.push([
        styledButton({
          text: (isEn ? "💬 Claim Product " : "💬 Klaim Produk ") + suffix,
          callback_data: "claim:bot:" + orderId
        }, "success", env),
        styledButton({
          text: (isEn ? "🎟️ Receipt " : "🎟️ Lihat Resi ") + suffix,
          callback_data: "ticket:" + orderId
        }, "primary", env)
      ]);
    } else if (payConfirm === "MENUNGGU_VERIFIKASI") {
      rows.push([styledButton({ text: (isEn ? "📎 Send Proof " : "📎 Perbarui Bukti ") + suffix, callback_data: "pc:req:" + orderId }, "primary", env)]);
    } else if (payConfirm === "DITOLAK" && !["DIBATALKAN", "CANCELLED", "CANCELED"].includes(status)) {
      rows.push([styledButton({ text: (isEn ? "🔁 Re-upload Proof " : "🔁 Kirim Ulang Bukti ") + suffix, callback_data: "pc:req:" + orderId }, "danger", env)]);
    } else if (status === "MENUNGGU_PEMBAYARAN" && method === "QRIS" && qrisAvailable) {
      rows.push([
        styledButton({ text: "📲 QR " + suffix, callback_data: "qris:show:" + orderId }, "success", env),
        styledButton({ text: (isEn ? "⚡ Check " : "⚡ Cek ") + suffix, callback_data: "qris:check:" + orderId }, "primary", env)
      ]);
    } else if (status === "MENUNGGU_PEMBAYARAN" && method !== "COD") {
      rows.push([styledButton({ text: (isEn ? "📎 Upload Proof " : "💳 Konfirmasi ") + suffix, callback_data: "pc:req:" + orderId }, "success", env)]);
    }
  }

  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push(styledButton({ text: isEn ? "◀️ Prev" : "◀️ Sebelumnya", callback_data: "hist:page:" + (page - 1) }, "primary", env));
    nav.push(styledButton({ text: (isEn ? "Page " : "Hal ") + (page + 1) + "/" + totalPages, callback_data: "noop" }, "primary", env));
    if (page + 1 < totalPages) nav.push(styledButton({ text: isEn ? "Next ▶️" : "Berikutnya ▶️", callback_data: "hist:page:" + (page + 1) }, "primary", env));
    rows.push(nav);
  }
  rows.push([
    styledButton({ text: isEn ? "🛍️ Products" : "🛍️ List Produk", callback_data: "cat:page:0" }, "success", env),
    styledButton({ text: isEn ? "🏠 Main Menu" : "🏠 Menu Utama", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildGuideInlineKeyboard(env = {}, lang = "id") {
  const isEn = normalizeLang(lang) === "en";
  const rows = [];
  const supportUrl = String(env?.SUPPORT_URL || "https://seiton.biz.id/kontak/").trim();
  if (/^https:\/\//i.test(supportUrl)) {
    rows.push([styledButton({ text: isEn ? "💬 Contact Support ↗" : "💬 Bantuan ↗", url: supportUrl }, "primary", env)]);
  }
  rows.push([
    styledButton({ text: isEn ? "🌐 Switch Language" : "🌐 Ganti Bahasa", callback_data: "lang:open" }, "primary", env)
  ]);
  rows.push([
    styledButton({ text: isEn ? "🛍️ Products" : "🛍️ List Produk", callback_data: "cat:page:0" }, "success", env),
    styledButton({ text: isEn ? "🏠 Main Menu" : "🏠 Menu Utama", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildSearchPromptInlineKeyboard(env = {}, lang = "id") {
  const isEn = normalizeLang(lang) === "en";
  return {
    inline_keyboard: [
      [styledButton({ text: isEn ? "❌ Cancel" : "❌ Batal", callback_data: "search:cancel" }, "danger", env)]
    ]
  };
}

export function buildSearchResultsInlineKeyboard(items, env = {}, lang = "id") {
  const isEn = normalizeLang(lang) === "en";
  const outSuffix = isEn ? " (Out)" : " (Habis)";
  const rows = [];
  (items || []).slice(0, 8).forEach((item, idx) => {
    const inStock = item.stock === null || item.stock > 0;
    const priceSuffix = item.price != null && inStock ? " · " + formatRp(item.price) : (inStock ? "" : outSuffix);
    rows.push([
      styledButton({
        text: `${idx + 1}. ${truncateText(item.name || item.sku, 32)}${priceSuffix}`,
        callback_data: "prod:view:" + String(item.sku).slice(0, 40) + ":sr"
      }, inStock ? "success" : "danger", env)
    ]);
  });
  rows.push([
    styledButton({ text: isEn ? "🔍 Search Again" : "🔍 Cari Lagi", callback_data: "search:open" }, "primary", env),
    styledButton({ text: isEn ? "🏠 Main Menu" : "🏠 Menu Utama", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

/**
 * Structured callback_data parser for the hybrid UI routes.
 * Returns null if callback belongs to legacy/admin routes handled elsewhere.
 */
export function parseUiCallback(raw) {
  const data = String(raw || "");
  if (data === "noop" || data === "noop:min" || data === "noop:max") {
    return { type: "NOOP", reason: data.split(":")[1] || "" };
  }
  if (data === "lang:open") return { type: "LANG_OPEN" };
  if (data === "lang:set:id" || data === "lang:set:en") {
    return { type: "LANG_SET", lang: data.slice("lang:set:".length) };
  }
  if (data.startsWith("claim:bot:")) {
    const orderId = data.slice("claim:bot:".length).trim();
    return orderId ? { type: "CLAIM_BOT", orderId } : null;
  }
  if (data === "search:open") return { type: "SEARCH_OPEN" };
  if (data === "search:cancel") return { type: "SEARCH_CANCEL" };
  if (data.startsWith("stock:tab:")) {
    const parts = data.split(":");
    return { type: "STOCK_TAB", tab: parts[2] === "empty" ? "empty" : "avail", page: Math.max(0, Number(parts[3]) || 0) };
  }
  if (data.startsWith("stock:refresh:")) {
    const parts = data.split(":");
    return { type: "STOCK_REFRESH", tab: parts[2] === "empty" ? "empty" : "avail", page: Math.max(0, Number(parts[3]) || 0) };
  }
  if (data.startsWith("prod:view:")) {
    const parts = data.split(":");
    const sku = String(parts[2] || "").trim();
    if (!sku) return null;
    const backCallback = decodeBackOrigin(parts[3] || "");
    return backCallback ? { type: "PROD_VIEW", sku, backCallback } : { type: "PROD_VIEW", sku };
  }
  if (data.startsWith("chk:qty:")) {
    const parts = data.split(":");
    const sku = String(parts[2] || "").trim();
    const qty = Number(parts[3]);
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 1000) return null;
    const backCallback = decodeBackOrigin(parts[4] || "");
    return backCallback ? { type: "CHK_QTY", sku, qty, backCallback } : { type: "CHK_QTY", sku, qty };
  }
  if (data.startsWith("chk:pay:")) {
    const parts = data.split(":");
    const method = String(parts[2] || "").toUpperCase();
    const sku = String(parts[3] || "").trim();
    const qty = Number(parts[4]);
    if (!SUPPORTED_CHECKOUT_METHODS.includes(method) || !sku || !Number.isInteger(qty) || qty < 1 || qty > 1000) return null;
    return { type: "CHK_PAY", method, sku, qty };
  }
  if (data.startsWith("hist:page:")) {
    return { type: "HIST_PAGE", page: Math.max(0, Number(data.slice("hist:page:".length)) || 0) };
  }
  return null;
}
