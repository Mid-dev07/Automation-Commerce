/**
 * Single source of truth for Reply Keyboards, color-coded Inline Keyboards,
 * and structured callback_data (< 64 bytes) for Seiton.id Telegram Bot.
 */

export const MENU_LABELS = Object.freeze({
  LIST_PRODUCTS: "🛍️ List Produk",
  CHECK_STOCK: "📦 Cek Stok",
  HISTORY: "📜 Riwayat",
  HOW_TO_ORDER: "📖 Cara Order",
  SEARCH_PRODUCTS: "🔍 Cari Produk",
  MAIN_MENU: "🏠 Menu Utama"
});

const MENU_LABEL_SET = new Set(Object.values(MENU_LABELS));

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
  return MENU_LABEL_SET.has(String(text || "").trim());
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
 * Layout: 2-2-1 grid.
 */
export function buildMainReplyKeyboard(env = {}) {
  return {
    keyboard: [
      [
        styledButton({ text: MENU_LABELS.LIST_PRODUCTS }, "primary", env),
        styledButton({ text: MENU_LABELS.CHECK_STOCK }, "primary", env)
      ],
      [
        styledButton({ text: MENU_LABELS.HISTORY }, "primary", env),
        styledButton({ text: MENU_LABELS.HOW_TO_ORDER }, "primary", env)
      ],
      [
        styledButton({ text: MENU_LABELS.SEARCH_PRODUCTS }, "primary", env)
      ]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Pilih menu di bawah atau cari produk…"
  };
}

/**
 * Dynamic 3-column numeric keypad (1..N) for List Produk screen.
 */
export function buildCatalogKeypadKeyboard(itemCount, env = {}) {
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
    styledButton({ text: MENU_LABELS.SEARCH_PRODUCTS }, "primary", env),
    styledButton({ text: MENU_LABELS.MAIN_MENU }, "primary", env)
  ]);
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: count > 0 ? "Pilih nomor 1–" + count + " atau ketik cari…" : "Kembali ke Menu Utama…"
  };
}

export function buildCatalogInlineKeyboard({ page, totalPages }, env = {}) {
  const rows = [];
  if (totalPages > 1) {
    const navRow = [];
    if (page > 0) {
      navRow.push(styledButton({ text: "◀️ Sebelumnya", callback_data: "cat:page:" + (page - 1) }, "primary", env));
    }
    navRow.push(styledButton({ text: "Hal " + (page + 1) + "/" + totalPages, callback_data: "noop" }, "primary", env));
    if (page + 1 < totalPages) {
      navRow.push(styledButton({ text: "Berikutnya ▶️", callback_data: "cat:page:" + (page + 1) }, "primary", env));
    }
    rows.push(navRow);
  }
  rows.push([
    styledButton({ text: "📦 Cek Stok", callback_data: "stock:tab:avail:0" }, "primary", env),
    styledButton({ text: "🏠 Beranda", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildStockInlineKeyboard({ tab, availCount, emptyCount, page, totalPages, items }, env = {}) {
  const rows = [];
  const activeTab = tab === "empty" ? "empty" : "avail";
  rows.push([
    styledButton({
      text: (activeTab === "avail" ? "✓ " : "") + "Tersedia (" + availCount + ")",
      callback_data: "stock:tab:avail:0"
    }, "success", env),
    styledButton({
      text: (activeTab === "empty" ? "✓ " : "") + "Habis (" + emptyCount + ")",
      callback_data: "stock:tab:empty:0"
    }, "danger", env)
  ]);

  for (const item of items || []) {
    const inStock = item.stock === null || item.stock > 0;
    const label = String(item.name || item.sku).slice(0, 38) + (inStock ? "" : " (Habis)");
    rows.push([
      styledButton({
        text: label,
        callback_data: "prod:view:" + String(item.sku).slice(0, 48)
      }, inStock ? "success" : "danger", env)
    ]);
  }

  if (totalPages > 1) {
    const nav = [];
    if (page > 0) {
      nav.push(styledButton({ text: "◀️ Prev", callback_data: "stock:tab:" + activeTab + ":" + (page - 1) }, "primary", env));
    }
    nav.push(styledButton({ text: (page + 1) + "/" + totalPages, callback_data: "noop" }, "primary", env));
    if (page + 1 < totalPages) {
      nav.push(styledButton({ text: "Next ▶️", callback_data: "stock:tab:" + activeTab + ":" + (page + 1) }, "primary", env));
    }
    rows.push(nav);
  }

  rows.push([
    styledButton({ text: "🔄 Perbarui", callback_data: "stock:refresh:" + activeTab + ":" + page }, "primary", env)
  ]);
  rows.push([
    styledButton({ text: "🔍 Cari", callback_data: "search:open" }, "primary", env),
    styledButton({ text: "🏠 Beranda", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildCheckoutInlineKeyboard({ sku, qty, maxQty, availableMethods, qrisMode, backCallback }, env = {}) {
  const rows = [];
  const safeSku = String(sku || "").slice(0, 36);
  const canBuy = maxQty === null || maxQty > 0;
  const safeQty = Math.max(1, Number(qty) || 1);

  if (canBuy) {
    const decAllowed = safeQty > 1;
    const incAllowed = maxQty === null ? safeQty < 99 : safeQty < Math.min(99, maxQty);
    rows.push([
      styledButton({
        text: "➖",
        callback_data: decAllowed ? "chk:qty:" + safeSku + ":" + (safeQty - 1) : "noop:min"
      }, decAllowed ? "primary" : "danger", env),
      styledButton({
        text: "Qty: " + safeQty,
        callback_data: "noop"
      }, "primary", env),
      styledButton({
        text: "➕",
        callback_data: incAllowed ? "chk:qty:" + safeSku + ":" + (safeQty + 1) : "noop:max"
      }, incAllowed ? "primary" : "danger", env)
    ]);

    const methods = Array.isArray(availableMethods) ? availableMethods : [];
    if (methods.includes("QRIS")) {
      rows.push([
        styledButton({
          text: qrisMode === "DYNAMIC" ? "⚡ Bayar QRIS" : "📷 Bayar QRIS (Manual)",
          callback_data: "chk:pay:QRIS:" + safeSku + ":" + safeQty
        }, "success", env)
      ]);
    }
    if (methods.includes("TRANSFER")) {
      rows.push([
        styledButton({
          text: "🏦 Bayar Transfer Bank",
          callback_data: "chk:pay:TRANSFER:" + safeSku + ":" + safeQty
        }, "primary", env)
      ]);
    }
    if (methods.includes("COD")) {
      rows.push([
        styledButton({
          text: "💵 Pesan COD",
          callback_data: "chk:pay:COD:" + safeSku + ":" + safeQty
        }, "primary", env)
      ]);
    }
  }

  rows.push([
    styledButton({ text: "⬅️ Kembali", callback_data: backCallback || "cat:page:0" }, "primary", env),
    styledButton({ text: "🏠 Beranda", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildHistoryInlineKeyboard({ orders, page, totalPages, qrisAvailable }, env = {}) {
  const rows = [];
  for (const order of orders || []) {
    const orderId = String(order.order_id || "");
    const suffix = orderId.slice(-8);
    const payConfirm = String(order.payment_confirmation_status || "").toUpperCase();
    const status = String(order.status || "").toUpperCase();
    const method = String(order.payment_method || "").toUpperCase();
    if (payConfirm === "DISETUJUI" && order.receipt_code) {
      rows.push([styledButton({ text: "🎟️ Lihat Resi " + suffix, callback_data: "ticket:" + orderId }, "success", env)]);
    } else if (payConfirm === "MENUNGGU_VERIFIKASI") {
      rows.push([styledButton({ text: "📎 Perbarui Bukti " + suffix, callback_data: "pc:req:" + orderId }, "primary", env)]);
    } else if (status === "MENUNGGU_PEMBAYARAN" && method === "QRIS" && qrisAvailable) {
      rows.push([
        styledButton({ text: "📲 QR " + suffix, callback_data: "qris:show:" + orderId }, "success", env),
        styledButton({ text: "⚡ Cek " + suffix, callback_data: "qris:check:" + orderId }, "primary", env)
      ]);
    } else if (status === "MENUNGGU_PEMBAYARAN" && method !== "COD") {
      rows.push([styledButton({ text: "💳 Konfirmasi " + suffix, callback_data: "pc:req:" + orderId }, "success", env)]);
    }
  }

  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push(styledButton({ text: "◀️ Prev", callback_data: "hist:page:" + (page - 1) }, "primary", env));
    nav.push(styledButton({ text: (page + 1) + "/" + totalPages, callback_data: "noop" }, "primary", env));
    if (page + 1 < totalPages) nav.push(styledButton({ text: "Next ▶️", callback_data: "hist:page:" + (page + 1) }, "primary", env));
    rows.push(nav);
  }
  rows.push([
    styledButton({ text: "🛍️ List Produk", callback_data: "cat:page:0" }, "success", env),
    styledButton({ text: "🏠 Menu Utama", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildGuideInlineKeyboard(env = {}) {
  const rows = [];
  const supportUrl = String(env?.SUPPORT_URL || "https://seiton.biz.id/kontak/").trim();
  if (/^https:\/\//i.test(supportUrl)) {
    rows.push([styledButton({ text: "💬 Bantuan ↗", url: supportUrl }, "primary", env)]);
  }
  rows.push([
    styledButton({ text: "🛍️ List Produk", callback_data: "cat:page:0" }, "success", env),
    styledButton({ text: "🏠 Menu Utama", callback_data: "nav:home" }, "primary", env)
  ]);
  return { inline_keyboard: rows };
}

export function buildSearchPromptInlineKeyboard(env = {}) {
  return {
    inline_keyboard: [
      [styledButton({ text: "❌ Batal", callback_data: "search:cancel" }, "danger", env)]
    ]
  };
}

export function buildSearchResultsInlineKeyboard(items, env = {}) {
  const rows = [];
  for (const item of (items || []).slice(0, 8)) {
    const inStock = item.stock === null || item.stock > 0;
    rows.push([
      styledButton({
        text: String(item.name || item.sku).slice(0, 38) + (inStock ? "" : " (Habis)"),
        callback_data: "prod:view:" + String(item.sku).slice(0, 48)
      }, inStock ? "success" : "danger", env)
    ]);
  }
  rows.push([
    styledButton({ text: "🔍 Cari Lagi", callback_data: "search:open" }, "primary", env),
    styledButton({ text: "🏠 Menu Utama", callback_data: "nav:home" }, "primary", env)
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
    const sku = data.slice("prod:view:".length).trim();
    return sku ? { type: "PROD_VIEW", sku } : null;
  }
  if (data.startsWith("chk:qty:")) {
    const parts = data.split(":");
    const sku = String(parts[2] || "").trim();
    const qty = Number(parts[3]);
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 1000) return null;
    return { type: "CHK_QTY", sku, qty };
  }
  if (data.startsWith("chk:pay:")) {
    const parts = data.split(":");
    const method = String(parts[2] || "").toUpperCase();
    const sku = String(parts[3] || "").trim();
    const qty = Number(parts[4]);
    if (!["QRIS", "TRANSFER", "COD"].includes(method) || !sku || !Number.isInteger(qty) || qty < 1 || qty > 1000) return null;
    return { type: "CHK_PAY", method, sku, qty };
  }
  if (data.startsWith("hist:page:")) {
    return { type: "HIST_PAGE", page: Math.max(0, Number(data.slice("hist:page:".length)) || 0) };
  }
  return null;
}
