import {
  escapeHtml,
  formatRp,
  renderBlockquote,
  truncateText
} from "./formatters.mjs";

const ADMIN_DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━";

function withStyle(button, style) {
  if (!style) return button;
  return { ...button, style };
}

function adminHomeKeyboard() {
  return {
    inline_keyboard: [
      [
        withStyle({ text: "💳 Verifikasi Bayar", callback_data: "adm:paymentchecks" }, "primary"),
        { text: "🧾 Pesanan", callback_data: "adm:orders" }
      ],
      [
        { text: "🛍️ Produk & Katalog", callback_data: "adm:products" },
        { text: "🎟️ Pengambilan", callback_data: "adm:pickup" }
      ],
      [
        { text: "📊 Laporan & Dashboard", callback_data: "adm:reports" },
        { text: "💬 Bantuan Pelanggan", callback_data: "adm:support" }
      ],
      [{ text: "🛒 Tampilan Pelanggan", callback_data: "nav:home" }]
    ]
  };
}

function adminOrdersInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        withStyle({ text: "💳 Verifikasi Bayar", callback_data: "adm:paymentchecks" }, "primary"),
        { text: "📋 Pesanan Terbaru", callback_data: "adm:recent" }
      ],
      [
        { text: "🔄 Ubah Status", callback_data: "adm:statuslist" },
        { text: "🎟️ Antrean Ambil", callback_data: "adm:pickup" }
      ],
      [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
    ]
  };
}

function adminProductsInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        withStyle({ text: "➕ Tambah Produk", callback_data: "adm:addproduct" }, "success"),
        withStyle({ text: "🗂️ Kelola Katalog", callback_data: "adm:catalog" }, "primary")
      ],
      [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
    ]
  };
}

function adminReportsInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        withStyle({ text: "📊 Ringkasan Penjualan", callback_data: "adm:report" }, "primary"),
        { text: "📈 Dashboard Web", callback_data: "adm:dashboard" }
      ],
      [{ text: "📥 Unduh Laporan CSV", callback_data: "adm:exports" }],
      [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
    ]
  };
}

function adminSupportInlineKeyboard() {
  return {
    inline_keyboard: [
      [withStyle({ text: "🆘 Antrean Bantuan Pelanggan", callback_data: "adm:handoff" }, "primary")],
      [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
    ]
  };
}

function renderAdminHomeScreen() {
  const text = [
    "🛠️ <b>SEITON.ID · PANEL ADMIN</b>",
    ADMIN_DIVIDER,
    "<blockquote>Pusat kendali operasional bot Telegram. Pilih area kerja untuk memproses pembayaran, pesanan, katalog, laporan, atau bantuan pelanggan.</blockquote>",
    "• <b>Verifikasi &amp; Pesanan</b> — cek bukti bayar &amp; ubah status",
    "• <b>Produk &amp; Pengambilan</b> — kelola stok, harga, dan resi",
    "• <b>Laporan &amp; Bantuan</b> — rekap omset, CSV, dan handoff"
  ].join("\n");
  return { text, parseMode: "HTML", replyMarkup: adminHomeKeyboard() };
}

function renderAdminSubmenuScreen(section) {
  const map = {
    orders: {
      title: "🧾 KELOLA PESANAN",
      desc: "Pantau pesanan masuk, verifikasi bukti bayar, ubah status operasional, dan kelola antrean pengambilan.",
      replyMarkup: adminOrdersInlineKeyboard()
    },
    products: {
      title: "🛍️ KELOLA PRODUK",
      desc: "Atur katalog aktif, harga jual, stok, foto produk, atau tambah SKU baru langsung ke Cloudflare D1.",
      replyMarkup: adminProductsInlineKeyboard()
    },
    reports: {
      title: "📊 LAPORAN &amp; ANALITIK",
      desc: "Lihat ringkasan omset terverifikasi, buka Dashboard Web interaktif, atau unduh laporan CSV.",
      replyMarkup: adminReportsInlineKeyboard()
    },
    support: {
      title: "💬 LAYANAN PELANGGAN",
      desc: "Tinjau antrean permintaan bantuan pelanggan dan ambil alih percakapan secara terkendali.",
      replyMarkup: adminSupportInlineKeyboard()
    }
  };
  const cfg = map[section] || map.orders;
  const text = [
    `<b>${cfg.title}</b>`,
    ADMIN_DIVIDER,
    `<blockquote>${cfg.desc}</blockquote>`,
    "Pilih tindakan di bawah:"
  ].join("\n");
  return { text, parseMode: "HTML", replyMarkup: cfg.replyMarkup };
}

function shortStatusLabel(rawStatus) {
  const s = String(rawStatus || "BARU").trim().toUpperCase();
  const labels = {
    MENUNGGU_PEMBAYARAN: "WAIT_PAY",
    MENUNGGU_VERIFIKASI: "VERIF",
    DIBAYAR: "PAID",
    DIPROSES: "PROSES",
    DIKIRIM: "KIRIM",
    SELESAI: "SELESAI",
    DIBATALKAN: "BATAL"
  };
  return labels[s] || truncateText(s, 8);
}

function renderAdminRecentOrdersScreen(recent = [], mode = "recent") {
  if (!recent.length) {
    return {
      text: [
        mode === "statuslist" ? "🔄 <b>UBAH STATUS PESANAN</b>" : "📋 <b>PESANAN TERBARU</b>",
        ADMIN_DIVIDER,
        "<i>Belum ada pesanan tercatat.</i>"
      ].join("\n"),
      parseMode: "HTML",
      replyMarkup: adminHomeKeyboard()
    };
  }
  const itemLines = recent.map((entry, idx) => {
    const orderId = escapeHtml(String(entry.r[0] || "-"));
    const prodName = escapeHtml(truncateText(String(entry.r[5] || "-"), 56));
    const totalStr = escapeHtml(formatRp(entry.r[10]));
    const statusStr = escapeHtml(shortStatusLabel(entry.r[12]));
    return `<b>${idx + 1}.</b> <code>${orderId}</code> • <code>${statusStr}</code>\n   ${prodName} — <b>${totalStr}</b>`;
  });
  const listBlock = renderBlockquote(itemLines);
  const title = mode === "statuslist" ? "🔄 <b>PILIH PESANAN — UBAH STATUS</b>" : "📋 <b>10 PESANAN TERBARU</b>";
  const subtitle = mode === "statuslist"
    ? "Pilih pesanan di bawah untuk memperbarui status operasional:"
    : "Ketuk nomor/ID pesanan untuk melihat rincian lengkap:";
  const buttons = recent.map((x) => [{
    text: `${truncateText(String(x.r[0] || "-"), 22)} · ${shortStatusLabel(x.r[12])}`,
    callback_data: (mode === "statuslist" ? "st:" : "detail:") + x.reference
  }]);
  buttons.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
  return {
    text: [title, ADMIN_DIVIDER, listBlock, subtitle].join("\n"),
    parseMode: "HTML",
    replyMarkup: { inline_keyboard: buttons }
  };
}

function renderAdminOrderDetailScreen(row, reference) {
  const text = [
    "🧾 <b>DETAIL PESANAN</b>",
    ADMIN_DIVIDER,
    `• <b>ID:</b> <code>${escapeHtml(row[0] || "-")}</code>`,
    `• <b>Pelanggan:</b> ${escapeHtml(row[4] || "-")} (<code>${escapeHtml(row[3] || "-")}</code>)`,
    `• <b>Produk:</b> ${escapeHtml(row[5] || "-")}`,
    `• <b>Jumlah:</b> ${escapeHtml(row[6] ?? 0)} pcs`,
    `• <b>Total:</b> <b>${escapeHtml(formatRp(row[10]))}</b>`,
    `• <b>Pembayaran:</b> ${escapeHtml(row[11] || "-")}`,
    `• <b>Status:</b> <code>${escapeHtml(row[12] || "-")}</code>`
  ].join("\n");
  return {
    text,
    parseMode: "HTML",
    replyMarkup: {
      inline_keyboard: [
        [withStyle({ text: "🔄 Perbarui Status", callback_data: "st:" + reference }, "primary")],
        [{ text: "⬅️ Pesanan Terbaru", callback_data: "adm:recent" }]
      ]
    }
  };
}

function renderAdminPaymentQueueScreen({ subset = [], current = 0, pages = 1, total = 0 }) {
  const keyboard = subset.map((x) => [
    withStyle({
      text: `${truncateText(String(x.r[0] || "-"), 18)} · ${formatRp(x.r[10])}${x.r[14] ? " 📎" : " ⏳"}`,
      callback_data: "payview:" + x.reference
    }, x.r[14] ? "primary" : undefined)
  ]);
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "paylist:" + (current - 1) });
  if (current < pages - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "paylist:" + (current + 1) });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);

  if (!total) {
    return {
      text: [
        "💳 <b>VERIFIKASI PEMBAYARAN</b>",
        ADMIN_DIVIDER,
        "✅ <i>Tidak ada permintaan verifikasi pembayaran yang menunggu.</i>"
      ].join("\n"),
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: keyboard }
    };
  }
  const items = subset.map((x, idx) => {
    const proof = x.r[14] ? "📎 Bukti ada" : "⏳ Belum unggah";
    return `${idx + 1}. <code>${escapeHtml(x.r[0])}</code> · ${escapeHtml(truncateText(x.r[4] || "Pelanggan", 16))}\n   <b>${escapeHtml(formatRp(x.r[10]))}</b> · ${proof}`;
  });
  return {
    text: [
      `💳 <b>VERIFIKASI PEMBAYARAN</b> (${current + 1}/${pages})`,
      ADMIN_DIVIDER,
      `Total menunggu: <b>${total}</b>`,
      "",
      ...items
    ].join("\n"),
    parseMode: "HTML",
    replyMarkup: { inline_keyboard: keyboard }
  };
}

function renderAdminPaymentDetailScreen({ row, reference, qrisPayment = null, qrisMismatch = false }) {
  const lines = [
    "🔎 <b>VERIFIKASI PEMBAYARAN</b>",
    ADMIN_DIVIDER,
    `• <b>Pesanan:</b> <code>${escapeHtml(row[0] || "-")}</code>`,
    `• <b>Pelanggan:</b> ${escapeHtml(row[4] || "-")} (<code>${escapeHtml(row[3] || "-")}</code>)`,
    `• <b>Produk:</b> ${escapeHtml(row[5] || "-")} × ${escapeHtml(row[6] || 0)}`,
    `• <b>Total pesanan:</b> <b>${escapeHtml(formatRp(row[10]))}</b>`,
    `• <b>Metode:</b> ${escapeHtml(row[11] || "-")}`,
    `• <b>Bukti:</b> ${row[14] ? (row[15] === "PHOTO" ? "Foto tersedia" : "Dokumen tersedia") : "Tidak diunggah"}`
  ];
  if (qrisPayment) {
    lines.push(
      "",
      "<b>Detail QRIS &amp; OCR</b>",
      `• Nominal QRIS: <b>${escapeHtml(formatRp(qrisPayment.expected_amount))}</b> (kode unik <code>${escapeHtml(String(qrisPayment.unique_code).padStart(3, "0"))}</code>)`,
      `• Status OCR: <code>${escapeHtml(qrisPayment.ocr_status || "NOT_RUN")}</code>`,
      `• Nominal terbaca: ${qrisPayment.ocr_amount == null ? "Tidak terbaca" : `<b>${escapeHtml(formatRp(qrisPayment.ocr_amount))}</b>`}`,
      `• Merchant: ${escapeHtml(qrisPayment.ocr_merchant_name || "Tidak terbaca")}`,
      `• Waktu: ${escapeHtml(qrisPayment.ocr_transaction_at || "Tidak terbaca")}`,
      `• Ref: <code>${escapeHtml(qrisPayment.ocr_reference || "-")}</code>`,
      "",
      qrisMismatch
        ? "<blockquote>⛔ <b>BUKTI / NOMINAL TERDETEKSI TIDAK COCOK.</b> Persetujuan dikunci; minta pelanggan mengunggah bukti yang benar.</blockquote>"
        : "<blockquote>⚠️ OCR hanya membaca isi screenshot. WAJIB cocokkan mutasi/riwayat transaksi merchant sebelum menyetujui. OCR bukan konfirmasi settlement.</blockquote>"
    );
  }
  const keyboard = {
    inline_keyboard: [
      ...(qrisMismatch ? [] : [[withStyle({ text: "✅ Setujui Pembayaran", callback_data: "payapprove:" + reference }, "success")]]),
      [withStyle({ text: "❌ Tolak / Minta Ulang", callback_data: "payreject:" + reference }, "danger")],
      [{ text: "⬅️ Daftar Verifikasi", callback_data: "adm:paymentchecks" }]
    ]
  };
  return { text: lines.join("\n"), parseMode: "HTML", replyMarkup: keyboard };
}

function renderAdminPickupQueueScreen({ subset = [], current = 0, pages = 1, total = 0 }) {
  const buttons = subset.map((x) => [
    withStyle({
      text: `${truncateText(String(x.r[0] || "-"), 18)} · ${truncateText(String(x.r[4] || "Pelanggan"), 16)}`,
      callback_data: "pickupview:" + x.reference
    }, "primary")
  ]);
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "picklist:" + (current - 1) });
  if (current < pages - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "picklist:" + (current + 1) });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);

  const text = total
    ? [
      `🎟️ <b>ANTREAN PENGAMBILAN</b> (${current + 1}/${pages})`,
      ADMIN_DIVIDER,
      `Total pesanan lunas belum diambil: <b>${total}</b>`,
      "Pilih pesanan untuk melihat resi dan menandai sudah diambil:"
    ].join("\n")
    : [
      "🎟️ <b>ANTREAN PENGAMBILAN</b>",
      ADMIN_DIVIDER,
      "✅ <i>Tidak ada pesanan lunas yang menunggu pengambilan.</i>"
    ].join("\n");
  return { text, parseMode: "HTML", replyMarkup: { inline_keyboard: buttons } };
}

function renderAdminPickupDetailScreen({ row, reference, ticketUrl, picked = false }) {
  const buttons = picked
    ? []
    : [[withStyle({ text: "✅ Tandai Sudah Diambil", callback_data: "pickupdone:" + String(reference) }, "success")]];
  buttons.push([withStyle({ text: "🔗 Buka Verifikasi QR", url: ticketUrl }, "primary")]);
  buttons.push([{ text: "⬅️ Antrean Pengambilan", callback_data: "adm:pickup" }]);
  const text = [
    "🎟️ <b>DETAIL PENGAMBILAN</b>",
    ADMIN_DIVIDER,
    `• <b>Pesanan:</b> <code>${escapeHtml(row[0] || "-")}</code>`,
    `• <b>Pelanggan:</b> ${escapeHtml(row[4] || "-")} (<code>${escapeHtml(row[3] || "-")}</code>)`,
    `• <b>Produk:</b> ${escapeHtml(row[5] || "-")} × ${escapeHtml(row[6] ?? 0)}`,
    `• <b>Total:</b> <b>${escapeHtml(formatRp(row[10]))}</b>`,
    `• <b>Kode Resi:</b> <code>${escapeHtml(row[18] || "-")}</code>`,
    `• <b>Status:</b> ${picked ? "✅ SUDAH DIAMBIL" : "⏳ BELUM DIAMBIL"}`
  ].join("\n");
  return { text, parseMode: "HTML", replyMarkup: { inline_keyboard: buttons } };
}

function renderAdminCatalogItemScreen({ row, current = 0, total = 1 }) {
  const sku = String(row[0] || "").trim();
  const active = String(row[4] ?? "TRUE").toUpperCase() !== "FALSE";
  const stockText = row[3] === "" || row[3] == null ? "Tidak dibatasi" : `${row[3]} unit`;
  const text = [
    `🛍️ <b>KATALOG ADMIN</b> (${current + 1}/${total})`,
    ADMIN_DIVIDER,
    `<b>${escapeHtml(row[1] || sku)}</b>`,
    `• <b>SKU:</b> <code>${escapeHtml(sku)}</code>`,
    `• <b>Harga:</b> <b>${escapeHtml(formatRp(row[2]))}</b>`,
    `• <b>Stok:</b> ${escapeHtml(stockText)}`,
    `• <b>Status:</b> ${active ? "🟢 Aktif" : "⚪ Nonaktif"}`,
    ...(row[6] ? ["", `<blockquote>${escapeHtml(truncateText(String(row[6]), 240))}</blockquote>`] : [])
  ].join("\n");
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "adm:catalog:" + (current - 1) });
  if (current < total - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "adm:catalog:" + (current + 1) });
  const keyboard = {
    inline_keyboard: [
      [
        withStyle({ text: "✏️ Atur Produk", callback_data: "prod:edit:" + sku }, "primary"),
        withStyle({ text: "🗑️ Hapus", callback_data: "prod:delete:" + sku }, "danger")
      ],
      ...(nav.length ? [nav] : []),
      [withStyle({ text: "➕ Tambah Produk", callback_data: "adm:addproduct" }, "success")],
      [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
    ]
  };
  return { text, parseMode: "HTML", replyMarkup: keyboard };
}

function renderAdminDeleteConfirmScreen(sku) {
  return {
    text: [
      "⚠️ <b>KONFIRMASI ARSIP PRODUK</b>",
      ADMIN_DIVIDER,
      `Yakin ingin mengarsipkan produk <code>${escapeHtml(sku)}</code>?`,
      "<blockquote>Produk akan dinonaktifkan dari katalog agar riwayat pesanan tetap utuh.</blockquote>"
    ].join("\n"),
    parseMode: "HTML",
    replyMarkup: {
      inline_keyboard: [
        [withStyle({ text: "🗑️ Ya, arsipkan produk", callback_data: "prod:delok:" + sku }, "danger")],
        [{ text: "Batal", callback_data: "adm:catalog" }]
      ]
    }
  };
}

function renderAdminDashboardLinkScreen(link) {
  return {
    text: [
      "📈 <b>DASHBOARD ADMIN WEB</b>",
      ADMIN_DIVIDER,
      "Tautan akses aman siap dibuka di browser.",
      "<blockquote>🔒 Berlaku 4 jam · Jangan teruskan tautan ini kepada pihak lain.</blockquote>"
    ].join("\n"),
    parseMode: "HTML",
    replyMarkup: {
      inline_keyboard: [
        [withStyle({ text: "📈 Buka Dashboard Interaktif", url: link }, "primary")],
        [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
      ]
    }
  };
}

function renderAdminExportsScreen() {
  return {
    text: [
      "📥 <b>UNDUH LAPORAN CSV</b>",
      ADMIN_DIVIDER,
      "<blockquote>Pilih berkas laporan yang ingin dikirim. Semua file berformat CSV siap dibuka di Excel atau Google Sheets.</blockquote>"
    ].join("\n"),
    parseMode: "HTML",
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "📋 Data Pesanan", callback_data: "exp:orders" },
          { text: "💰 Buku Kas", callback_data: "exp:finance" }
        ],
        [
          { text: "📅 Ringkasan Harian", callback_data: "exp:daily" },
          { text: "📦 Stok & Katalog", callback_data: "exp:inventory" }
        ],
        [withStyle({ text: "🗂️ Paket Lengkap (4 file)", callback_data: "exp:all" }, "primary")],
        [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
      ]
    }
  };
}

function renderAdminSalesReportHtml({ dateLabel, revenue, paidCount, todayRevenue, todayCount, bestProduct, paymentTotals = {}, target = 0 }) {
  const pct = target > 0 ? Math.min(100, Math.floor((todayRevenue / target) * 100)) : 0;
  const filled = Math.round(pct / 10);
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
  const methodEntries = Object.entries(paymentTotals);
  const breakdownBlock = methodEntries.length
    ? renderBlockquote(
      methodEntries.map(([k, v]) => `• <b>${escapeHtml(truncateText(k, 28))}:</b> ${escapeHtml(formatRp(v))}`)
    )
    : "<blockquote><i>Belum ada transaksi dibayar.</i></blockquote>";

  return [
    "📊 <b>REKAP PENJUALAN SEITON.ID</b>",
    `<i>${escapeHtml(dateLabel)}</i>`,
    ADMIN_DIVIDER,
    `• <b>Total Omset:</b> ${escapeHtml(formatRp(revenue))}`,
    `• <b>Order Dibayar:</b> ${escapeHtml(Number(paidCount || 0).toLocaleString("id-ID"))}`,
    `• <b>Omset Hari Ini:</b> ${escapeHtml(formatRp(todayRevenue))}`,
    `• <b>Order Hari Ini:</b> ${escapeHtml(Number(todayCount || 0).toLocaleString("id-ID"))}`,
    `• <b>Produk Terlaris:</b> ${bestProduct ? `${escapeHtml(bestProduct[0])} (${escapeHtml(bestProduct[1])} pcs)` : "Belum ada data"}`,
    "",
    "<b>Distribusi Pembayaran</b>",
    breakdownBlock,
    "",
    `🎯 <b>Target Harian:</b> ${target ? escapeHtml(formatRp(target)) : "Belum diatur"}`,
    `<code>[${bar}] ${pct}%</code>`,
    "<blockquote>ℹ️ Omset hanya menghitung pesanan berstatus terbayar/selesai.</blockquote>"
  ].join("\n");
}

function parseQuickQrisCommand(rawText, maxAmount = 10_000_000) {
  const text = String(rawText || "").trim();
  if (/^\/qris_test(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text)) return null;
  const cmdMatch = text.match(/^\/qris(?:@[a-z0-9_]+)?(?:(?:\+|\s+)([\s\S]*))?$/i);
  if (!cmdMatch) return null;
  const rest = String(cmdMatch[1] || "").trim().replace(/^\++/, "").trim();
  if (!rest) {
    return { ok: false, error: "Format: /qris+nominal atau /qris <nominal> [keterangan]\nContoh: /qris+50000 atau /qris 150.000 Jasa Setup" };
  }
  const tokenMatch = rest.match(/^(?:rp\.?\s*)?([0-9][0-9.,]*)(?:\s+([\s\S]+))?$/i);
  if (!tokenMatch) {
    return { ok: false, error: "Nominal tidak valid. Contoh: /qris+50000 atau /qris 50.000" };
  }
  const rawDigits = tokenMatch[1].replace(/[.,]/g, "");
  if (!/^\d{1,8}$/.test(rawDigits)) {
    return { ok: false, error: "⚠️ Nominal QRIS harus antara Rp1 sampai Rp10.000.000." };
  }
  const amount = Number(rawDigits);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxAmount) {
    return { ok: false, error: "⚠️ Nominal QRIS harus antara Rp1 sampai Rp10.000.000." };
  }
  const note = String(tokenMatch[2] || "").trim().slice(0, 120);
  return { ok: true, amount, note };
}

function renderQuickQrisCaptionHtml({ amount, merchantName = "SEITON.ID", merchantCity = "", note = "" }) {
  const lines = [
    "⚡ <b>QRIS PEMBAYARAN — SEITON.ID</b>",
    ADMIN_DIVIDER,
    `• <b>Merchant:</b> ${escapeHtml(merchantName || "SEITON.ID")}${merchantCity ? ` (${escapeHtml(merchantCity)})` : ""}`,
    `• <b>Nominal Tagihan:</b> <b>${escapeHtml(formatRp(amount))}</b>`
  ];
  if (note) {
    lines.push(`• <b>Keterangan:</b> ${escapeHtml(note)}`);
  }
  lines.push(
    "",
    "<blockquote>📲 Pindai kode QRIS di atas menggunakan aplikasi mobile banking atau e-wallet. Nominal sudah terisi otomatis — mohon kirimkan screenshot bukti pembayaran setelah transaksi berhasil.</blockquote>"
  );
  return lines.join("\n");
}

export {
  adminHomeKeyboard,
  adminOrdersInlineKeyboard,
  adminProductsInlineKeyboard,
  adminReportsInlineKeyboard,
  adminSupportInlineKeyboard,
  renderAdminHomeScreen,
  renderAdminSubmenuScreen,
  renderAdminRecentOrdersScreen,
  renderAdminOrderDetailScreen,
  renderAdminPaymentQueueScreen,
  renderAdminPaymentDetailScreen,
  renderAdminPickupQueueScreen,
  renderAdminPickupDetailScreen,
  renderAdminCatalogItemScreen,
  renderAdminDeleteConfirmScreen,
  renderAdminDashboardLinkScreen,
  renderAdminExportsScreen,
  renderAdminSalesReportHtml,
  parseQuickQrisCommand,
  renderQuickQrisCaptionHtml
};
