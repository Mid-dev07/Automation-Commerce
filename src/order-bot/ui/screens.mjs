/**
 * Pure screen renderers for Seiton.id Telegram Bot (HTML parse mode).
 * Every screen follows a framed instrument card pattern:
 *   Header + live readout (<blockquote> / <pre>) + operational hint + controls.
 */

import {
  escapeHtml,
  formatRp,
  renderBlockquote,
  renderHint,
  renderMonospaceTable,
  truncateText
} from "./formatters.mjs";
import {
  buildCatalogInlineKeyboard,
  buildCatalogKeypadKeyboard,
  buildCheckoutInlineKeyboard,
  buildGuideInlineKeyboard,
  buildHistoryInlineKeyboard,
  buildMainReplyKeyboard,
  buildSearchPromptInlineKeyboard,
  buildSearchResultsInlineKeyboard,
  buildStockInlineKeyboard
} from "./keyboards.mjs";

export function renderHomeScreen({ user = {}, stats = {}, storeName = "Seiton.id Store" } = {}, env = {}) {
  const firstName = escapeHtml(truncateText(user.firstName || "Pelanggan", 48));
  const userId = escapeHtml(String(user.id || "-"));
  const username = user.username ? "@" + escapeHtml(truncateText(user.username, 32)) : "-";

  const accountBlock = renderBlockquote([
    "<b>Info Akun</b>",
    "• Telegram ID: <code>" + userId + "</code>",
    "• Username: " + username
  ]);

  const statsBlock = renderBlockquote([
    "<b>Statistik Toko</b>",
    "• Total transaksi: <b>" + escapeHtml(formatRp(stats.totalRevenue || 0)) + "</b>",
    "• Transaksi sukses: <b>" + Number(stats.successTx || 0) + "</b>",
    "• Produk terjual: <b>" + Number(stats.soldUnits || 0) + " unit</b>",
    "• Produk aktif: <b>" + Number(stats.activeProducts || 0) + "</b> • Pengguna: <b>" + Number(stats.totalUsers || 0) + "</b>"
  ]);

  const text = [
    "🛍️ <b>" + escapeHtml(storeName) + "</b>",
    "Halo, <b>" + firstName + "</b>. Pilih produk, periksa detail, lalu lanjutkan pembayaran langsung.",
    "",
    accountBlock,
    statsBlock,
    "",
    renderHint("Pilih menu melalui keyboard di bawah kolom chat.")
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    replyKeyboard: buildMainReplyKeyboard(env)
  };
}

export function renderCatalogScreen({ items = [], page = 0, totalPages = 1, totalItems = 0 } = {}, env = {}) {
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const safePage = Math.max(0, Math.min(safeTotalPages - 1, Number(page) || 0));

  if (!items.length) {
    return {
      text: [
        "🛍️ <b>Daftar Produk</b>",
        "",
        renderBlockquote(["Belum ada produk aktif di katalog saat ini."]),
        "",
        renderHint("Kembali ke Menu Utama atau hubungi admin untuk info produk terbaru.")
      ].join("\n"),
      parseMode: "HTML",
      inlineKeyboard: buildCatalogInlineKeyboard({ page: 0, totalPages: 1 }, env),
      replyKeyboard: buildCatalogKeypadKeyboard(0, env)
    };
  }

  const rows = items.map((item, idx) => [
    String(idx + 1),
    item.name || item.sku,
    formatRp(item.price).replace(/^Rp /, "")
  ]);
  const table = renderMonospaceTable(
    [
      { label: "No", width: 2, align: "right" },
      { label: "Produk", width: 18, align: "left" },
      { label: "Harga", width: 10, align: "right" }
    ],
    rows
  );

  const text = [
    "🛍️ <b>Daftar Produk</b> (" + totalItems + " aktif)",
    table,
    renderHint("Halaman " + (safePage + 1) + "/" + safeTotalPages + ". Pilih nomor 1–" + items.length + " lewat keypad di bawah.")
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildCatalogInlineKeyboard({ page: safePage, totalPages: safeTotalPages }, env),
    replyKeyboard: buildCatalogKeypadKeyboard(items.length, env)
  };
}

export function renderStockScreen(
  { tab = "avail", items = [], availCount = 0, emptyCount = 0, page = 0, totalPages = 1 } = {},
  env = {}
) {
  const activeTab = tab === "empty" ? "empty" : "avail";
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const safePage = Math.max(0, Math.min(safeTotalPages - 1, Number(page) || 0));
  const label = activeTab === "avail" ? "Stok Tersedia" : "Stok Habis";

  const summary = "Tersedia: <b>" + availCount + "</b> produk • Habis: <b>" + emptyCount + "</b> produk";
  let contentBlock;
  if (!items.length) {
    contentBlock = renderBlockquote([
      activeTab === "avail"
        ? "Saat ini seluruh produk sedang habis."
        : "Tidak ada produk yang habis stok."
    ]);
  } else {
    const rows = items.map((item) => [
      item.name || item.sku,
      item.stock === null ? "∞" : String(item.stock),
      String(Number(item.soldUnits || 0))
    ]);
    contentBlock = renderMonospaceTable(
      [
        { label: "Produk", width: 18, align: "left" },
        { label: "Stok", width: 5, align: "right" },
        { label: "Jual", width: 6, align: "right" }
      ],
      rows
    );
  }

  const text = [
    "📦 <b>Cek Stok</b>",
    summary,
    "",
    "<b>" + label + "</b>",
    contentBlock,
    renderHint("Hal " + (safePage + 1) + "/" + safeTotalPages + " (" + label + "). Stok dapat berubah sampai pesanan dibuat.")
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildStockInlineKeyboard(
      { tab: activeTab, availCount, emptyCount, page: safePage, totalPages: safeTotalPages, items },
      env
    )
  };
}

export function renderProductCheckoutScreen(
  { product, qty = 1, availableMethods = [], qrisMode = "STATIC_FALLBACK", backCallback = "cat:page:0" },
  env = {}
) {
  const maxQty = product.stock === null ? null : Math.max(0, Number(product.stock) || 0);
  const canBuy = maxQty === null || maxQty > 0;
  const clampedQty = canBuy
    ? Math.max(1, maxQty === null ? Math.min(99, Number(qty) || 1) : Math.min(maxQty, Number(qty) || 1))
    : 0;
  const unitPrice = Math.max(0, Number(product.price) || 0);
  const totalAmount = unitPrice * clampedQty;

  const stockLabel = product.stock === null
    ? "Tidak dibatasi"
    : maxQty === 0
      ? "Habis (0)"
      : maxQty + " unit tersedia";

  const cardLines = [
    "<b>" + escapeHtml(product.name || product.sku) + "</b>",
    "• SKU: <code>" + escapeHtml(product.sku) + "</code>",
    "• Harga satuan: <b>" + escapeHtml(formatRp(unitPrice)) + "</b>",
    "• Stok: <b>" + escapeHtml(stockLabel) + "</b>"
  ];
  if (product.description) {
    cardLines.push("• Detail: " + escapeHtml(truncateText(product.description, 220)));
  }
  if (canBuy) {
    cardLines.push("• Jumlah: <b>" + clampedQty + " unit</b>");
    cardLines.push("• Total Bayar: <b>" + escapeHtml(formatRp(totalAmount)) + "</b>");
  }

  const noMethodsWarning = canBuy && (!availableMethods || availableMethods.length === 0)
    ? "\n⚠️ <i>Belum ada metode pembayaran aktif. Hubungi admin.</i>"
    : "";

  const text = [
    "🧾 <b>Checkout Produk</b>",
    "",
    renderBlockquote(cardLines) + noMethodsWarning,
    "",
    renderHint(
      canBuy
        ? "Atur jumlah dengan ➖ / ➕ lalu pilih metode pembayaran di bawah."
        : "Stok produk sedang habis. Periksa produk lain di Daftar Produk atau Cek Stok."
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
        backCallback
      },
      env
    )
  };
}

function formatOrderStatusBadge(order) {
  const status = String(order.status || "").toUpperCase();
  const payConfirm = String(order.payment_confirmation_status || "").toUpperCase();
  if (payConfirm === "DISETUJUI") return "✅ Lunas";
  if (payConfirm === "MENUNGGU_VERIFIKASI") return "⏳ Verifikasi";
  if (payConfirm === "DITOLAK") return "❌ Bukti Ditolak";
  if (status === "MENUNGGU_PEMBAYARAN") return "💳 Belum Bayar";
  if (status === "DIBATALKAN") return "⛔ Batal";
  return escapeHtml(status || "-");
}

export function renderHistoryScreen(
  { orders = [], page = 0, totalPages = 1, totalCount = 0, qrisAvailable = true } = {},
  env = {}
) {
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const safePage = Math.max(0, Math.min(safeTotalPages - 1, Number(page) || 0));

  if (!orders.length) {
    return {
      text: [
        "📜 <b>Riwayat Pesanan</b>",
        "",
        renderBlockquote(["Belum ada pesanan. Mulai belanja melalui Daftar Produk."]),
        "",
        renderHint("Pesanan dan resi otomatis muncul di sini setelah checkout.")
      ].join("\n"),
      parseMode: "HTML",
      inlineKeyboard: buildHistoryInlineKeyboard({ orders: [], page: 0, totalPages: 1, qrisAvailable }, env)
    };
  }

  const cards = orders.map((order) => {
    const id = escapeHtml(String(order.order_id || "-"));
    const prod = escapeHtml(truncateText(order.product_name || order.sku || "-", 28));
    const qty = Number(order.quantity || 1);
    const total = escapeHtml(formatRp(order.total || 0));
    const badge = formatOrderStatusBadge(order);
    return "• <code>" + id + "</code> — " + badge + "\n  " + prod + " ×" + qty + " • <b>" + total + "</b>";
  });

  const text = [
    "📜 <b>Riwayat Pesanan</b> (" + totalCount + " total • Hal " + (safePage + 1) + "/" + safeTotalPages + ")",
    "",
    renderBlockquote(cards),
    "",
    renderHint("Barang / resi dikirim setelah pembayaran terverifikasi.")
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildHistoryInlineKeyboard({ orders, page: safePage, totalPages: safeTotalPages, qrisAvailable }, env)
  };
}

export function renderGuideScreen(env = {}) {
  const steps = renderBlockquote([
    "1. Tekan <b>🛍️ List Produk</b> atau <b>📦 Cek Stok</b> untuk memilih produk.",
    "2. Pilih nomor produk lewat keypad bawah atau tombol inline.",
    "3. Atur jumlah (<b>➖ / ➕</b>) dan periksa <b>Total Bayar</b>.",
    "4. Pilih metode bayar (<b>QRIS</b>, <b>Transfer Bank</b>, atau <b>COD</b>).",
    "5. Selesaikan pembayaran, unggah bukti, lalu pantau resi di <b>📜 Riwayat</b>."
  ]);

  const text = [
    "📖 <b>Cara Order</b>",
    "",
    steps,
    "",
    renderHint("Baca detail produk dan pastikan total sebelum membayar.")
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: buildGuideInlineKeyboard(env)
  };
}

export function renderSearchPromptScreen(env = {}) {
  return {
    text: [
      "🔍 <b>Cari Produk</b>",
      "",
      renderBlockquote(["Ketik nama produk atau kode SKU yang ingin dicari."]),
      "",
      renderHint("Mode pencarian aktif 5 menit. Tekan ❌ Batal untuk keluar.")
    ].join("\n"),
    parseMode: "HTML",
    inlineKeyboard: buildSearchPromptInlineKeyboard(env)
  };
}

export function renderSearchResultsScreen({ query = "", items = [] } = {}, env = {}) {
  const safeQuery = escapeHtml(truncateText(query, 40));
  if (!items.length) {
    return {
      text: [
        "🔍 <b>Hasil Pencarian:</b> <code>" + safeQuery + "</code>",
        "",
        renderBlockquote(["Tidak ditemukan produk yang cocok dengan kata kunci tersebut."]),
        "",
        renderHint("Coba kata kunci lebih singkat atau buka Daftar Produk.")
      ].join("\n"),
      parseMode: "HTML",
      inlineKeyboard: buildSearchResultsInlineKeyboard([], env)
    };
  }

  const rows = items.slice(0, 8).map((item) => [
    item.name || item.sku,
    item.stock === null ? "∞" : String(item.stock),
    formatRp(item.price).replace(/^Rp /, "")
  ]);
  const table = renderMonospaceTable(
    [
      { label: "Produk", width: 16, align: "left" },
      { label: "Stok", width: 4, align: "right" },
      { label: "Harga", width: 10, align: "right" }
    ],
    rows
  );

  return {
    text: [
      "🔍 <b>Hasil Pencarian:</b> <code>" + safeQuery + "</code> (" + items.length + ")",
      table,
      renderHint("Pilih produk di bawah untuk langsung melihat detail & checkout.")
    ].join("\n"),
    parseMode: "HTML",
    inlineKeyboard: buildSearchResultsInlineKeyboard(items, env)
  };
}
