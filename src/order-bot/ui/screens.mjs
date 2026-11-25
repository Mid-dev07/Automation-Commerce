/**
 * Pure screen renderers for Seiton.id Telegram Bot (HTML parse mode).
 * Every screen follows a framed instrument card pattern:
 *   Header + live readout (<blockquote> / <pre>) + operational hint + controls.
 * Supports bilingual mode ('id' / 'en') and dual IDR + USDT pricing.
 */

import {
  escapeHtml,
  formatRp,
  renderBlockquote,
  renderHint,
  truncateText
} from "./formatters.mjs";
import { convertIdrToUsdt, formatDualPrice, normalizeLang } from "./i18n.mjs";
import {
  buildCatalogInlineKeyboard,
  buildCatalogKeypadKeyboard,
  buildCheckoutInlineKeyboard,
  buildGuideInlineKeyboard,
  buildHistoryInlineKeyboard,
  buildHomeInlineKeyboard,
  buildMainReplyKeyboard,
  buildSearchPromptInlineKeyboard,
  buildSearchResultsInlineKeyboard,
  buildStockInlineKeyboard
} from "./keyboards.mjs";

export function renderHomeScreen({ user = {}, stats = {}, storeName = "Seiton.id Store", lang = "id" } = {}, env = {}) {
  const isEn = normalizeLang(lang) === "en";
  const firstName = escapeHtml(truncateText(user.firstName || (isEn ? "Customer" : "Pelanggan"), 48));
  const userId = escapeHtml(String(user.id || "-"));
  const username = user.username ? "@" + escapeHtml(truncateText(user.username, 32)) : "-";

  const accountBlock = renderBlockquote(
    isEn
      ? [
        "<b>Account Info</b>",
        "• Telegram ID: <code>" + userId + "</code>",
        "• Username: " + username
      ]
      : [
        "<b>Info Akun</b>",
        "• Telegram ID: <code>" + userId + "</code>",
        "• Username: " + username
      ]
  );

  const statsBlock = renderBlockquote(
    isEn
      ? [
        "<b>Store Statistics</b>",
        "• Total volume: <b>" + escapeHtml(formatRp(stats.totalRevenue || 0)) + "</b>",
        "• Completed orders: <b>" + Number(stats.successTx || 0) + "</b>",
        "• Units sold: <b>" + Number(stats.soldUnits || 0) + " units</b>",
        "• Active products: <b>" + Number(stats.activeProducts || 0) + "</b> • Users: <b>" + Number(stats.totalUsers || 0) + "</b>"
      ]
      : [
        "<b>Statistik Toko</b>",
        "• Total transaksi: <b>" + escapeHtml(formatRp(stats.totalRevenue || 0)) + "</b>",
        "• Transaksi sukses: <b>" + Number(stats.successTx || 0) + "</b>",
        "• Produk terjual: <b>" + Number(stats.soldUnits || 0) + " unit</b>",
        "• Produk aktif: <b>" + Number(stats.activeProducts || 0) + "</b> • Pengguna: <b>" + Number(stats.totalUsers || 0) + "</b>"
      ]
  );

  const text = [
    "🛍️ <b>" + escapeHtml(storeName) + "</b>",
    isEn
      ? "Hello, <b>" + firstName + "</b>. Select a product, complete payment (QRIS / USDT / Bank), and claim your item directly with Admin."
      : "Halo, <b>" + firstName + "</b>. Pilih produk, periksa detail, lalu lanjutkan pembayaran langsung.",
    "",
    accountBlock,
    statsBlock,
    "",
    renderHint(
      isEn
        ? "Choose your language or use the menu keyboard below the chat box."
        : "Pilih bahasa atau menu melalui keyboard di bawah kolom chat."
    )
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildHomeInlineKeyboard(env, lang),
    replyKeyboard: buildMainReplyKeyboard(env, lang)
  };
}

export function renderCatalogScreen({ items = [], page = 0, totalPages = 1, totalItems = 0, lang = "id" } = {}, env = {}) {
  const isEn = normalizeLang(lang) === "en";
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const safePage = Math.max(0, Math.min(safeTotalPages - 1, Number(page) || 0));

  if (!items.length) {
    return {
      text: [
        isEn ? "🛍️ <b>Product Catalog</b>" : "🛍️ <b>Daftar Produk</b>",
        "",
        renderBlockquote([isEn ? "No active products available right now." : "Belum ada produk aktif di katalog saat ini."]),
        "",
        renderHint(
          isEn
            ? "Return to Main Menu or contact Admin for the latest catalog."
            : "Kembali ke Menu Utama atau hubungi admin untuk info produk terbaru."
        )
      ].join("\n"),
      parseMode: "HTML",
      inlineKeyboard: buildCatalogInlineKeyboard({ page: 0, totalPages: 1, lang }, env),
      replyKeyboard: buildCatalogKeypadKeyboard(0, env, lang)
    };
  }

  const itemLines = items.map((item, idx) => {
    const fullName = escapeHtml(truncateText(item.name || item.sku, 100));
    const priceText = isEn
      ? `${formatRp(item.price)} (≈ ${convertIdrToUsdt(item.price, env?.USD_EXCHANGE_RATE)} USDT)`
      : formatRp(item.price);
    const stockBadge = item.stock === null
      ? "♾️ Unlimited"
      : Number(item.stock) > 0
        ? (isEn ? `📦 Stock: ${Number(item.stock)}` : `📦 Stok: ${Number(item.stock)}`)
        : (isEn ? "❌ Out of stock" : "❌ Habis");
    return `<b>${idx + 1}. ${fullName}</b>\n   💰 <b>${escapeHtml(priceText)}</b> • ${stockBadge}`;
  });

  const text = [
    isEn
      ? "🛍️ <b>Product Catalog</b> (" + totalItems + " active)"
      : "🛍️ <b>Daftar Produk</b> (" + totalItems + " aktif)",
    "",
    renderBlockquote(itemLines),
    "",
    renderHint(
      isEn
        ? "Page " + (safePage + 1) + "/" + safeTotalPages + ". Tap a product button below (or type 1–" + items.length + ") to order."
        : "Halaman " + (safePage + 1) + "/" + safeTotalPages + ". Ketuk tombol produk di bawah (atau ketik 1–" + items.length + ") untuk beli."
    )
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildCatalogInlineKeyboard({ page: safePage, totalPages: safeTotalPages, items, lang }, env),
    replyKeyboard: buildCatalogKeypadKeyboard(items.length, env, lang)
  };
}

export function renderStockScreen(
  { tab = "avail", items = [], availCount = 0, emptyCount = 0, page = 0, totalPages = 1, lang = "id" } = {},
  env = {}
) {
  const isEn = normalizeLang(lang) === "en";
  const activeTab = tab === "empty" ? "empty" : "avail";
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const safePage = Math.max(0, Math.min(safeTotalPages - 1, Number(page) || 0));
  const label = isEn
    ? (activeTab === "avail" ? "Available Stock" : "Out of Stock")
    : (activeTab === "avail" ? "Stok Tersedia" : "Stok Habis");

  const summary = isEn
    ? "Available: <b>" + availCount + "</b> items • Out of Stock: <b>" + emptyCount + "</b> items"
    : "Tersedia: <b>" + availCount + "</b> produk • Habis: <b>" + emptyCount + "</b> produk";
  let contentBlock;
  if (!items.length) {
    contentBlock = renderBlockquote([
      isEn
        ? (activeTab === "avail" ? "All products are currently out of stock." : "No products are out of stock.")
        : (activeTab === "avail" ? "Saat ini seluruh produk sedang habis." : "Tidak ada produk yang habis stok.")
    ]);
  } else {
    const stockLines = items.map((item, idx) => {
      const fullName = escapeHtml(truncateText(item.name || item.sku, 100));
      const priceStr = escapeHtml(formatRp(item.price || 0));
      const stockStr = item.stock === null
        ? "♾️ Unlimited"
        : Number(item.stock) > 0
          ? (isEn ? `📦 ${Number(item.stock)} units` : `📦 ${Number(item.stock)} unit`)
          : (isEn ? "❌ Out of stock (0)" : "❌ Habis (0)");
      const soldStr = isEn
        ? `Sold: ${Number(item.soldUnits || 0)}`
        : `Terjual: ${Number(item.soldUnits || 0)}`;
      return `<b>${idx + 1}. ${fullName}</b>\n   💰 ${priceStr} • ${stockStr} • ${soldStr}`;
    });
    contentBlock = renderBlockquote(stockLines);
  }

  const text = [
    isEn ? "📦 <b>Stock Status</b>" : "📦 <b>Cek Stok</b>",
    summary,
    "",
    "<b>" + label + "</b>",
    contentBlock,
    "",
    renderHint(
      isEn
        ? "Page " + (safePage + 1) + "/" + safeTotalPages + " (" + label + "). Tap any item below to order."
        : "Hal " + (safePage + 1) + "/" + safeTotalPages + " (" + label + "). Ketuk produk di bawah untuk langsung checkout."
    )
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildStockInlineKeyboard(
      { tab: activeTab, availCount, emptyCount, page: safePage, totalPages: safeTotalPages, items, lang },
      env
    )
  };
}

export function renderProductCheckoutScreen(
  { product, qty = 1, availableMethods = [], qrisMode = "STATIC_FALLBACK", backCallback = "cat:page:0", intlConfig = {}, lang = "id" },
  env = {}
) {
  const isEn = normalizeLang(lang) === "en";
  const maxQty = product.stock === null ? null : Math.max(0, Number(product.stock) || 0);
  const canBuy = maxQty === null || maxQty > 0;
  const clampedQty = canBuy
    ? Math.max(1, maxQty === null ? Math.min(99, Number(qty) || 1) : Math.min(maxQty, Number(qty) || 1))
    : 0;
  const unitPrice = Math.max(0, Number(product.price) || 0);
  const totalAmount = unitPrice * clampedQty;

  const stockLabel = product.stock === null
    ? (isEn ? "Unlimited" : "Tidak dibatasi")
    : maxQty === 0
      ? (isEn ? "Out of Stock (0)" : "Habis (0)")
      : maxQty + (isEn ? " units available" : " unit tersedia");

  const showDual = isEn || availableMethods.includes("USDT") || availableMethods.includes("PAYPAL");
  const unitPriceText = showDual
    ? `${formatRp(unitPrice)} (≈ ${convertIdrToUsdt(unitPrice, intlConfig?.usd_exchange_rate)} USDT)`
    : formatRp(unitPrice);
  const totalPriceText = showDual
    ? formatDualPrice(totalAmount, intlConfig, lang)
    : formatRp(totalAmount);

  const cardLines = [
    "<b>" + escapeHtml(truncateText(product.name || product.sku, 100)) + "</b>",
    "• SKU: <code>" + escapeHtml(product.sku) + "</code>",
    (isEn ? "• Unit price: <b>" : "• Harga satuan: <b>") + escapeHtml(unitPriceText) + "</b>",
    (isEn ? "• Stock: <b>" : "• Stok: <b>") + escapeHtml(stockLabel) + "</b>"
  ];
  if (product.description) {
    cardLines.push((isEn ? "• Details: " : "• Detail: ") + escapeHtml(truncateText(product.description, 180)));
  }
  if (canBuy) {
    cardLines.push((isEn ? "• Quantity: <b>" : "• Jumlah: <b>") + clampedQty + (isEn ? " units</b>" : " unit</b>"));
    cardLines.push((isEn ? "• Total Payment: <b>" : "• Total Bayar: <b>") + escapeHtml(totalPriceText) + "</b>");
  }

  const noMethodsWarning = canBuy && (!availableMethods || availableMethods.length === 0)
    ? (isEn ? "\n⚠️ <i>No active payment methods configured. Contact Admin.</i>" : "\n⚠️ <i>Belum ada metode pembayaran aktif. Hubungi admin.</i>")
    : "";

  const text = [
    isEn ? "🧾 <b>Product Checkout</b>" : "🧾 <b>Checkout Produk</b>",
    "",
    renderBlockquote(cardLines) + noMethodsWarning,
    "",
    renderHint(
      canBuy
        ? (isEn ? "Adjust quantity with ➖ / ➕ then choose a payment method below." : "Atur jumlah dengan ➖ / ➕ lalu pilih metode pembayaran di bawah.")
        : (isEn ? "This product is currently out of stock." : "Stok produk sedang habis. Periksa produk lain di Daftar Produk atau Cek Stok.")
    )
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    clampedQty,
    inlineKeyboard: buildCheckoutInlineKeyboard(
      {
        sku: product.sku,
        qty: clampedQty || 1,
        maxQty,
        availableMethods,
        qrisMode,
        backCallback,
        totalAmount,
        intlConfig,
        lang
      },
      env
    )
  };
}

function formatOrderStatusBadge(order, lang = "id") {
  const isEn = normalizeLang(lang) === "en";
  const status = String(order.status || "").toUpperCase();
  const payConfirm = String(order.payment_confirmation_status || "").toUpperCase();
  if (payConfirm === "DISETUJUI") return isEn ? "✅ Paid & Verified" : "✅ Lunas";
  if (payConfirm === "MENUNGGU_VERIFIKASI") return isEn ? "⏳ Verifying" : "⏳ Verifikasi";
  if (payConfirm === "DITOLAK") return isEn ? "❌ Proof Rejected" : "❌ Bukti Ditolak";
  if (status === "MENUNGGU_PEMBAYARAN") return isEn ? "💳 Unpaid" : "💳 Belum Bayar";
  if (status === "DIBATALKAN") return isEn ? "⛔ Cancelled" : "⛔ Batal";
  return escapeHtml(status || "-");
}

export function renderHistoryScreen(
  { orders = [], page = 0, totalPages = 1, totalCount = 0, qrisAvailable = true, lang = "id" } = {},
  env = {}
) {
  const isEn = normalizeLang(lang) === "en";
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const safePage = Math.max(0, Math.min(safeTotalPages - 1, Number(page) || 0));

  if (!orders.length) {
    return {
      text: [
        isEn ? "📜 <b>Order History</b>" : "📜 <b>Riwayat Pesanan</b>",
        "",
        renderBlockquote([isEn ? "You have no orders yet. Browse Products to get started." : "Belum ada pesanan. Mulai belanja melalui Daftar Produk."]),
        "",
        renderHint(isEn ? "Your orders and claim links will appear here after checkout." : "Pesanan dan resi otomatis muncul di sini setelah checkout.")
      ].join("\n"),
      parseMode: "HTML",
      inlineKeyboard: buildHistoryInlineKeyboard({ orders: [], page: 0, totalPages: 1, qrisAvailable, lang }, env)
    };
  }

  const cards = orders.map((order) => {
    const id = escapeHtml(String(order.order_id || "-"));
    const prod = escapeHtml(truncateText(order.product_name || order.sku || "-", 80));
    const qty = Number(order.quantity || 1);
    const total = escapeHtml(formatRp(order.total || 0));
    const badge = formatOrderStatusBadge(order, lang);
    return "• <code>" + id + "</code> — " + badge + "\n  " + prod + " ×" + qty + " • <b>" + total + "</b>";
  });

  const text = [
    isEn
      ? "📜 <b>Order History</b> (" + totalCount + " total • Page " + (safePage + 1) + "/" + safeTotalPages + ")"
      : "📜 <b>Riwayat Pesanan</b> (" + totalCount + " total • Hal " + (safePage + 1) + "/" + safeTotalPages + ")",
    "",
    renderBlockquote(cards),
    "",
    renderHint(
      isEn
        ? "Once verified, tap Claim Product to contact Admin and receive your item."
        : "Barang / resi dikirim atau diklaim ke Admin setelah pembayaran terverifikasi."
    )
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildHistoryInlineKeyboard({ orders, page: safePage, totalPages: safeTotalPages, qrisAvailable, lang }, env)
  };
}

export function renderGuideScreen(env = {}, lang = "id") {
  const isEn = normalizeLang(lang) === "en";
  const steps = renderBlockquote(
    isEn
      ? [
        "1. Tap <b>🛍️ Products</b> or <b>📦 Check Stock</b> to browse full product names & prices.",
        "2. Tap your desired product button directly (or type its item number).",
        "3. Adjust quantity (<b>➖ / ➕</b>) and check the <b>Total Payment</b> (IDR / USDT).",
        "4. Choose your payment method (<b>QRIS</b>, <b>USDT</b>, <b>PayPal</b>, <b>Bank Transfer</b>, or <b>COD</b>).",
        "5. Send your payment screenshot directly in this chat — our system auto-validates it and directs you to <b>Chat Admin</b> to claim your product."
      ]
      : [
        "1. Tekan <b>🛍️ List Produk</b> atau <b>📦 Cek Stok</b> untuk melihat nama lengkap & harga produk.",
        "2. Ketuk tombol produk pilihan Anda (atau ketik nomor urut produk).",
        "3. Atur jumlah (<b>➖ / ➕</b>) dan periksa <b>Total Bayar</b> (IDR / USDT).",
        "4. Pilih metode bayar (<b>QRIS</b>, <b>USDT</b>, <b>PayPal</b>, <b>Transfer Bank</b>, atau <b>COD</b>).",
        "5. Kirim screenshot bukti bayar langsung di chat — sistem memvalidasi otomatis dan mengarahkan Anda ke <b>Chat Admin</b> untuk meminta produk."
      ]
  );

  const text = [
    isEn ? "📖 <b>How to Order</b>" : "📖 <b>Cara Order</b>",
    "",
    steps,
    "",
    renderHint(
      isEn
        ? "Review product details and exact total before completing payment."
        : "Baca detail produk dan pastikan total sebelum membayar."
    )
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildGuideInlineKeyboard(env, lang)
  };
}

export function renderSearchPromptScreen(env = {}, lang = "id") {
  const isEn = normalizeLang(lang) === "en";
  return {
    text: [
      isEn ? "🔍 <b>Search Products</b>" : "🔍 <b>Cari Produk</b>",
      "",
      renderBlockquote([isEn ? "Type the product name or SKU code you want to find." : "Ketik nama produk atau kode SKU yang ingin dicari."]),
      "",
      renderHint(isEn ? "Search mode is active for 5 minutes. Tap ❌ Cancel to exit." : "Mode pencarian aktif 5 menit. Tekan ❌ Batal untuk keluar.")
    ].join("\n"),
    parseMode: "HTML",
    inlineKeyboard: buildSearchPromptInlineKeyboard(env, lang)
  };
}

export function renderSearchResultsScreen({ query = "", items = [], lang = "id" } = {}, env = {}) {
  const isEn = normalizeLang(lang) === "en";
  const safeQuery = escapeHtml(truncateText(query, 40));
  if (!items.length) {
    return {
      text: [
        (isEn ? "🔍 <b>Search Results:</b> <code>" : "🔍 <b>Hasil Pencarian:</b> <code>") + safeQuery + "</code>",
        "",
        renderBlockquote([isEn ? "No matching products found for that keyword." : "Tidak ditemukan produk yang cocok dengan kata kunci tersebut."]),
        "",
        renderHint(isEn ? "Try a shorter keyword or open Product Catalog." : "Coba kata kunci lebih singkat atau buka Daftar Produk.")
      ].join("\n"),
      parseMode: "HTML",
      inlineKeyboard: buildSearchResultsInlineKeyboard([], env, lang)
    };
  }

  const resultLines = items.slice(0, 8).map((item, idx) => {
    const fullName = escapeHtml(truncateText(item.name || item.sku, 100));
    const priceStr = escapeHtml(formatRp(item.price));
    const stockBadge = item.stock === null
      ? "♾️ Unlimited"
      : Number(item.stock) > 0
        ? (isEn ? `📦 Stock: ${Number(item.stock)}` : `📦 Stok: ${Number(item.stock)}`)
        : (isEn ? "❌ Out of stock" : "❌ Habis");
    return `<b>${idx + 1}. ${fullName}</b>\n   💰 <b>${priceStr}</b> • ${stockBadge}`;
  });

  return {
    text: [
      (isEn ? "🔍 <b>Search Results:</b> <code>" : "🔍 <b>Hasil Pencarian:</b> <code>") + safeQuery + "</code> (" + items.length + ")",
      "",
      renderBlockquote(resultLines),
      "",
      renderHint(
        isEn
          ? "Tap a product below to view details & checkout."
          : "Pilih produk di bawah untuk langsung melihat detail & checkout."
      )
    ].join("\n"),
    parseMode: "HTML",
    inlineKeyboard: buildSearchResultsInlineKeyboard(items, env, lang)
  };
}
