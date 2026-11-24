/**
 * Bilingual (Indonesian 'id' / English 'en') dictionary, international payment
 * currency converters (IDR -> USDT / USD / Telegram Stars), and post-payment
 * Direct-to-Admin product claim screens.
 */

import { escapeHtml, formatRp, renderBlockquote, renderHint, truncateText } from "./formatters.mjs";

export const SUPPORTED_LANGS = Object.freeze(["id", "en"]);

export const MENU_LABELS_BY_LANG = Object.freeze({
  id: Object.freeze({
    LIST_PRODUCTS: "🛍️ List Produk",
    CHECK_STOCK: "📦 Cek Stok",
    HISTORY: "📜 Riwayat",
    HOW_TO_ORDER: "📖 Cara Order",
    SEARCH_PRODUCTS: "🔍 Cari Produk",
    LANGUAGE: "🌐 Bahasa / EN",
    MAIN_MENU: "🏠 Menu Utama"
  }),
  en: Object.freeze({
    LIST_PRODUCTS: "🛍️ Products",
    CHECK_STOCK: "📦 Check Stock",
    HISTORY: "📜 My Orders",
    HOW_TO_ORDER: "📖 How to Order",
    SEARCH_PRODUCTS: "🔍 Search",
    LANGUAGE: "🌐 Language / ID",
    MAIN_MENU: "🏠 Main Menu"
  })
});

export const DEFAULT_INTL_PAYMENT_CONFIG = Object.freeze({
  usdt_enabled: true,
  usdt_network: "TRC20 / BEP20 (BSC)",
  usdt_wallet_address: "",
  paypal_enabled: false,
  paypal_address: "",
  stars_enabled: false,
  usd_exchange_rate: 16000,
  stars_exchange_rate: 350,
  admin_telegram_username: "",
  auto_verify_qris_ocr: true,
  auto_verify_non_qris_proof: true
});

export function normalizeLang(lang) {
  return String(lang || "").trim().toLowerCase() === "en" ? "en" : "id";
}

export function getMenuLabels(lang = "id") {
  return MENU_LABELS_BY_LANG[normalizeLang(lang)];
}

export function resolveMenuIntent(text) {
  const trimmed = String(text || "").trim();
  for (const lang of SUPPORTED_LANGS) {
    const labels = MENU_LABELS_BY_LANG[lang];
    for (const [intent, label] of Object.entries(labels)) {
      if (trimmed === label) return intent;
    }
  }
  if (trimmed === "🌐 Bahasa" || trimmed === "🌐 Language") return "LANGUAGE";
  return null;
}

export function isAnyMainMenuLabel(text) {
  return resolveMenuIntent(text) !== null;
}

export function convertIdrToUsdt(idrAmount, usdExchangeRate = DEFAULT_INTL_PAYMENT_CONFIG.usd_exchange_rate) {
  const idr = Math.max(0, Number(idrAmount) || 0);
  const rate = Math.max(100, Number(usdExchangeRate) || DEFAULT_INTL_PAYMENT_CONFIG.usd_exchange_rate);
  if (idr === 0) return "0.00";
  const raw = Math.max(0.01, idr / rate);
  return raw.toFixed(2);
}

export function convertIdrToStars(idrAmount, starsExchangeRate = DEFAULT_INTL_PAYMENT_CONFIG.stars_exchange_rate) {
  const idr = Math.max(0, Number(idrAmount) || 0);
  const rate = Math.max(10, Number(starsExchangeRate) || DEFAULT_INTL_PAYMENT_CONFIG.stars_exchange_rate);
  if (idr === 0) return 0;
  return Math.max(1, Math.ceil(idr / rate));
}

export function formatDualPrice(idrAmount, config = {}, lang = "id") {
  const rp = formatRp(idrAmount);
  const usdt = convertIdrToUsdt(idrAmount, config?.usd_exchange_rate);
  if (normalizeLang(lang) === "en" || config?.usdt_enabled || config?.paypal_enabled) {
    return `${rp} (≈ ${usdt} USDT)`;
  }
  return rp;
}

function parseBoolFlag(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  if (typeof val === "boolean") return val;
  const s = String(val).trim().toLowerCase();
  if (["true", "1", "yes", "ya", "on", "aktif"].includes(s)) return true;
  if (["false", "0", "no", "tidak", "off", "nonaktif"].includes(s)) return false;
  return fallback;
}

export async function loadIntlPaymentConfig(env = {}) {
  let dbPatch = {};
  if (env?.DB) {
    try {
      const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'payment_intl_config_v1' LIMIT 1").first();
      if (row?.value) {
        const parsed = JSON.parse(String(row.value));
        if (parsed && typeof parsed === "object") dbPatch = parsed;
      }
    } catch {
      // Safe fallback when app_meta is not yet initialized.
    }
  }

  const usdRate = Number(dbPatch.usd_exchange_rate ?? env?.USD_EXCHANGE_RATE ?? DEFAULT_INTL_PAYMENT_CONFIG.usd_exchange_rate);
  const starsRate = Number(dbPatch.stars_exchange_rate ?? env?.STARS_EXCHANGE_RATE ?? DEFAULT_INTL_PAYMENT_CONFIG.stars_exchange_rate);
  const usdtWallet = String(dbPatch.usdt_wallet_address ?? env?.USDT_WALLET_ADDRESS ?? "").trim();
  const usdtNetwork = String(dbPatch.usdt_network ?? env?.USDT_NETWORK ?? DEFAULT_INTL_PAYMENT_CONFIG.usdt_network).trim();
  const paypalAddress = String(dbPatch.paypal_address ?? env?.PAYPAL_ADDRESS ?? "").trim();
  const adminUsername = String(dbPatch.admin_telegram_username ?? env?.ADMIN_TELEGRAM_USERNAME ?? "")
    .trim()
    .replace(/^@+/, "");

  return {
    usdt_enabled: parseBoolFlag(dbPatch.usdt_enabled ?? env?.USDT_ENABLED, DEFAULT_INTL_PAYMENT_CONFIG.usdt_enabled),
    usdt_network: usdtNetwork || DEFAULT_INTL_PAYMENT_CONFIG.usdt_network,
    usdt_wallet_address: usdtWallet,
    paypal_enabled: parseBoolFlag(dbPatch.paypal_enabled ?? env?.PAYPAL_ENABLED, Boolean(paypalAddress)),
    paypal_address: paypalAddress,
    stars_enabled: parseBoolFlag(dbPatch.stars_enabled ?? env?.STARS_ENABLED, DEFAULT_INTL_PAYMENT_CONFIG.stars_enabled),
    usd_exchange_rate: Number.isFinite(usdRate) && usdRate >= 100 ? Math.round(usdRate) : DEFAULT_INTL_PAYMENT_CONFIG.usd_exchange_rate,
    stars_exchange_rate: Number.isFinite(starsRate) && starsRate >= 10 ? Math.round(starsRate) : DEFAULT_INTL_PAYMENT_CONFIG.stars_exchange_rate,
    admin_telegram_username: adminUsername,
    auto_verify_qris_ocr: parseBoolFlag(dbPatch.auto_verify_qris_ocr ?? env?.AUTO_VERIFY_QRIS_OCR, true),
    auto_verify_non_qris_proof: parseBoolFlag(dbPatch.auto_verify_non_qris_proof ?? env?.AUTO_VERIFY_NON_QRIS_PROOF, true)
  };
}

export async function saveIntlPaymentConfig(env, patch = {}) {
  if (!env?.DB) throw new Error("D1_BINDING_MISSING");
  const current = await loadIntlPaymentConfig(env);
  const merged = { ...current, ...patch };
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO app_meta(key, value, updated_at) VALUES ('payment_intl_config_v1', ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(JSON.stringify(merged), nowIso).run();
  return merged;
}

export function buildAdminClaimUrl(env = {}, config = {}, orderInfo = {}, lang = "id") {
  const isEn = normalizeLang(lang) === "en";
  const orderId = String(orderInfo.orderId || "-");
  const product = String(orderInfo.product || orderInfo.sku || "-");
  const qty = Number(orderInfo.quantity || 1);
  const receipt = String(orderInfo.receiptCode || "-");

  const claimMessage = isEn
    ? `Hello Admin, I have completed payment for my order and would like to claim my product:\n• Order ID: ${orderId}\n• Product: ${product} (x${qty})\n• Receipt Code: ${receipt}`
    : `Halo Admin, saya sudah menyelesaikan pembayaran dan ingin klaim produk yang saya beli:\n• ID Pesanan: ${orderId}\n• Produk: ${product} (x${qty})\n• Kode Resi: ${receipt}`;

  const rawUsername = String(config?.admin_telegram_username || env?.ADMIN_TELEGRAM_USERNAME || "")
    .trim()
    .replace(/^@+/, "");
  if (rawUsername && /^[A-Za-z0-9_]{4,32}$/.test(rawUsername)) {
    return `https://t.me/${rawUsername}?text=${encodeURIComponent(claimMessage)}`;
  }

  const supportUrl = String(env?.SUPPORT_URL || "https://seiton.biz.id/kontak/").trim();
  const tgMatch = supportUrl.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{4,32})\/?$/i);
  if (tgMatch) {
    return `https://t.me/${tgMatch[1]}?text=${encodeURIComponent(claimMessage)}`;
  }
  return /^https:\/\//i.test(supportUrl) ? supportUrl : "https://seiton.biz.id/kontak/";
}

export function renderLanguageSelectScreen(currentLang = "id") {
  const lang = normalizeLang(currentLang);
  const text = [
    "🌐 <b>Pilih Bahasa / Select Language</b>",
    "",
    renderBlockquote([
      "🇮🇩 <b>Bahasa Indonesia</b> — Gunakan antarmuka dan panduan pembayaran dalam Bahasa Indonesia.",
      "🇬🇧 <b>English</b> — Use the store interface and international payment instructions in English."
    ]),
    "",
    renderHint(
      lang === "en"
        ? "Current language: English. Tap below to switch."
        : "Bahasa saat ini: Bahasa Indonesia. Ketuk di bawah untuk mengganti."
    )
  ].join("\n");

  return {
    text,
    parseMode: "HTML",
    inlineKeyboard: {
      inline_keyboard: [
        [
          {
            text: (lang === "id" ? "✓ " : "") + "🇮🇩 Bahasa Indonesia",
            callback_data: "lang:set:id",
            style: lang === "id" ? "success" : "primary"
          },
          {
            text: (lang === "en" ? "✓ " : "") + "🇬🇧 English",
            callback_data: "lang:set:en",
            style: lang === "en" ? "success" : "primary"
          }
        ],
        [
          {
            text: lang === "en" ? "🏠 Back to Home" : "🏠 Kembali ke Beranda",
            callback_data: "nav:home",
            style: "primary"
          }
        ]
      ]
    }
  };
}

export function renderIntlPaymentInstructionsScreen({ order, method, config = {}, bankAccounts = [], lang = "id" }) {
  const isEn = normalizeLang(lang) === "en";
  const upperMethod = String(method || order?.paymentMethod || "").toUpperCase();
  const orderId = escapeHtml(String(order?.orderId || order?.order_id || "-"));
  const product = escapeHtml(truncateText(String(order?.product || order?.product_name || order?.sku || "-"), 48));
  const qty = Number(order?.quantity || 1);
  const totalIdr = Number(order?.total || 0);
  const usdtAmount = convertIdrToUsdt(totalIdr, config?.usd_exchange_rate);
  const starsAmount = convertIdrToStars(totalIdr, config?.stars_exchange_rate);

  const summaryLines = isEn
    ? [
      "<b>Order Summary</b>",
      `• Order ID: <code>${orderId}</code>`,
      `• Product: <b>${product}</b> × ${qty}`,
      `• Total (IDR): <b>${escapeHtml(formatRp(totalIdr))}</b>`
    ]
    : [
      "<b>Ringkasan Pesanan</b>",
      `• ID Pesanan: <code>${orderId}</code>`,
      `• Produk: <b>${product}</b> × ${qty}`,
      `• Total (IDR): <b>${escapeHtml(formatRp(totalIdr))}</b>`
    ];

  let instructionLines = [];
  if (upperMethod === "USDT") {
    summaryLines.push(
      isEn
        ? `• Amount to Send: <b>${usdtAmount} USDT</b> (Rate: 1 USDT = ${escapeHtml(formatRp(config?.usd_exchange_rate || 16000))})`
        : `• Nominal Transfer: <b>${usdtAmount} USDT</b> (Kurs: 1 USDT = ${escapeHtml(formatRp(config?.usd_exchange_rate || 16000))})`
    );
    const wallet = config?.usdt_wallet_address
      ? `<code>${escapeHtml(config.usdt_wallet_address)}</code>`
      : isEn
        ? "<i>(Ask Admin via button below for wallet address)</i>"
        : "<i>(Hubungi Admin lewat tombol di bawah untuk alamat wallet)</i>";
    instructionLines = isEn
      ? [
        "💎 <b>USDT CRYPTO PAYMENT</b>",
        `• Network: <b>${escapeHtml(config?.usdt_network || "TRC20 / BEP20 (BSC)")}</b>`,
        `• Wallet Address:\n${wallet}`,
        `• Exact Amount: <code>${usdtAmount}</code> USDT`,
        "",
        "📸 <b>Automatic Validation:</b> Send your payment screenshot directly in this chat (or tap the button below). Our system will validate your proof and direct you to Admin to claim your product."
      ]
      : [
        "💎 <b>PEMBAYARAN USDT (CRYPTO)</b>",
        `• Jaringan: <b>${escapeHtml(config?.usdt_network || "TRC20 / BEP20 (BSC)")}</b>`,
        `• Alamat Wallet:\n${wallet}`,
        `• Nominal Tepat: <code>${usdtAmount}</code> USDT`,
        "",
        "📸 <b>Validasi Otomatis:</b> Kirim screenshot bukti transfer langsung di chat ini (atau tekan tombol di bawah). Sistem akan memvalidasi bukti Anda otomatis dan mengarahkan Anda ke chat Admin untuk klaim produk."
      ];
  } else if (upperMethod === "PAYPAL") {
    summaryLines.push(
      isEn
        ? `• Amount to Send: <b>$${usdtAmount} USD</b>`
        : `• Nominal Transfer: <b>$${usdtAmount} USD</b>`
    );
    const dest = config?.paypal_address
      ? `<code>${escapeHtml(config.paypal_address)}</code>`
      : isEn ? "<i>(Contact Admin for PayPal destination)</i>" : "<i>(Hubungi Admin untuk tujuan PayPal)</i>";
    instructionLines = isEn
      ? [
        "🅿️ <b>PAYPAL PAYMENT</b>",
        `• PayPal Account / Link: ${dest}`,
        `• Exact Amount: <code>$${usdtAmount} USD</code>`,
        `• Note / Reference: <code>${orderId}</code>`,
        "",
        "📸 <b>Automatic Validation:</b> Send your payment screenshot directly in this chat. The system will validate your screenshot and direct you to Admin to claim your product."
      ]
      : [
        "🅿️ <b>PEMBAYARAN PAYPAL</b>",
        `• Akun / Link PayPal: ${dest}`,
        `• Nominal Tepat: <code>$${usdtAmount} USD</code>`,
        `• Catatan: <code>${orderId}</code>`,
        "",
        "📸 <b>Validasi Otomatis:</b> Kirim screenshot bukti pembayaran langsung di chat ini. Sistem akan memvalidasi screenshot dan mengarahkan Anda ke Admin untuk meminta produk."
      ];
  } else if (upperMethod === "STARS") {
    summaryLines.push(
      isEn
        ? `• Stars Amount: <b>⭐ ${starsAmount} Stars (XTR)</b>`
        : `• Nominal Stars: <b>⭐ ${starsAmount} Stars (XTR)</b>`
    );
    instructionLines = isEn
      ? [
        "⭐ <b>TELEGRAM STARS PAYMENT</b>",
        `• Total Stars: <b>${starsAmount} XTR</b>`,
        "Send your Stars payment screenshot in this chat to auto-validate and claim your product with Admin."
      ]
      : [
        "⭐ <b>PEMBAYARAN TELEGRAM STARS</b>",
        `• Total Stars: <b>${starsAmount} XTR</b>`,
        "Kirim screenshot bukti pembayaran Stars di chat ini untuk validasi otomatis dan klaim produk ke Admin."
      ];
  } else if (upperMethod === "TRANSFER") {
    const accounts = (bankAccounts || []).filter((a) => a.enabled);
    const accLines = accounts.map((acc, idx) =>
      `${idx + 1}. <b>${escapeHtml(acc.bank_name)}</b> — <code>${escapeHtml(acc.account_number)}</code>\n   a.n. ${escapeHtml(acc.account_holder)}${acc.note ? ` (${escapeHtml(acc.note)})` : ""}`
    );
    instructionLines = isEn
      ? [
        "🏦 <b>BANK TRANSFER PAYMENT</b>",
        ...(accLines.length ? accLines : ["<i>Contact Admin for active bank details.</i>"]),
        "",
        "📸 <b>Automatic Validation:</b> Send your transfer screenshot directly in this chat. Our system will auto-validate it and direct you to Admin to receive your product."
      ]
      : [
        "🏦 <b>REKENING RESMI SEITON.ID</b>",
        ...(accLines.length ? accLines : ["<i>Hubungi Admin untuk rekening aktif.</i>"]),
        "",
        "📸 <b>Validasi Otomatis:</b> Kirim screenshot bukti transfer langsung di chat ini. Sistem akan memvalidasi bukti otomatis dan mengarahkan Anda ke Admin untuk meminta produk."
      ];
  }

  const header = isEn
    ? "✅ <b>ORDER RECORDED — SEITON.ID</b>"
    : "✅ <b>PESANAN DICATAT — SEITON.ID</b>";

  const rawId = String(order?.orderId || order?.order_id || "");
  const keyboard = {
    inline_keyboard: [
      [
        {
          text: isEn ? "📎 I Have Paid — Send Screenshot" : "📎 Saya Sudah Bayar — Kirim Bukti",
          callback_data: "pc:req:" + rawId,
          style: "success"
        }
      ],
      [
        {
          text: isEn ? "📜 My Orders" : "📜 Riwayat Pesanan",
          callback_data: "nav:orders",
          style: "primary"
        },
        {
          text: isEn ? "🏠 Main Menu" : "🏠 Menu Utama",
          callback_data: "nav:home",
          style: "primary"
        }
      ]
    ]
  };

  return {
    text: [
      header,
      "",
      renderBlockquote(summaryLines),
      ...(instructionLines.length ? ["", renderBlockquote(instructionLines)] : [])
    ].join("\n"),
    parseMode: "HTML",
    replyMarkup: keyboard
  };
}

export function renderVerifiedClaimScreen(
  { orderId, product, quantity = 1, total = 0, paymentMethod = "", receiptCode = "", config = {}, lang = "id" },
  env = {}
) {
  const isEn = normalizeLang(lang) === "en";
  const safeId = String(orderId || "-");
  const safeProd = String(product || "-");
  const safeReceipt = String(receiptCode || "-");
  const claimUrl = buildAdminClaimUrl(env, config, {
    orderId: safeId,
    product: safeProd,
    quantity,
    receiptCode: safeReceipt
  }, lang);

  const details = isEn
    ? [
      "<b>Verified Order Details</b>",
      `• Order ID: <code>${escapeHtml(safeId)}</code>`,
      `• Product: <b>${escapeHtml(truncateText(safeProd, 54))}</b> × ${Number(quantity || 1)}`,
      `• Total Paid: <b>${escapeHtml(formatDualPrice(total, config, "en"))}</b>`,
      `• Method: <b>${escapeHtml(paymentMethod || "-")}</b>`,
      `• Verification / Claim Code: <code>${escapeHtml(safeReceipt)}</code>`
    ]
    : [
      "<b>Detail Pesanan Terverifikasi</b>",
      `• ID Pesanan: <code>${escapeHtml(safeId)}</code>`,
      `• Produk: <b>${escapeHtml(truncateText(safeProd, 54))}</b> × ${Number(quantity || 1)}`,
      `• Total Dibayar: <b>${escapeHtml(formatDualPrice(total, config, "id"))}</b>`,
      `• Metode: <b>${escapeHtml(paymentMethod || "-")}</b>`,
      `• Kode Klaim / Resi: <code>${escapeHtml(safeReceipt)}</code>`
    ];

  const nextStepBlock = isEn
    ? [
      "💬 <b>Next Step — Claim Your Product</b>",
      "Your payment has been verified! Tap <b>Chat Admin — Claim Product</b> below to message our Admin directly with your Order ID and receive your product."
    ]
    : [
      "💬 <b>Langkah Selanjutnya — Klaim Produk Anda</b>",
      "Pembayaran Anda telah terverifikasi! Tekan tombol <b>Chat Admin — Klaim Produk</b> di bawah untuk langsung chat Admin dan meminta produk yang Anda beli."
    ];

  const text = [
    isEn ? "✅ <b>PAYMENT VERIFIED — SEITON.ID</b>" : "✅ <b>PEMBAYARAN TERVERIFIKASI — SEITON.ID</b>",
    "",
    renderBlockquote(details),
    "",
    renderBlockquote(nextStepBlock)
  ].join("\n");

  const inline_keyboard = [
    [
      {
        text: isEn ? "💬 Chat Admin — Claim Product ↗" : "💬 Chat Admin — Klaim Produk ↗",
        url: claimUrl,
        style: "success"
      }
    ],
    [
      {
        text: isEn ? "🔔 Notify Admin in Bot" : "🔔 Panggil Admin di Bot",
        callback_data: "claim:bot:" + safeId.slice(0, 48),
        style: "primary"
      }
    ],
    [
      {
        text: isEn ? "📜 My Orders" : "📜 Riwayat Pesanan",
        callback_data: "nav:orders",
        style: "primary"
      },
      {
        text: isEn ? "🏠 Main Menu" : "🏠 Menu Utama",
        callback_data: "nav:home",
        style: "primary"
      }
    ]
  ];

  return {
    text,
    parseMode: "HTML",
    replyMarkup: { inline_keyboard }
  };
}
