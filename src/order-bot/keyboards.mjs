import { parseCatalogProduct, rupiah } from "./utils.mjs";
import {
  adminHomeKeyboard,
  adminOrdersInlineKeyboard,
  adminProductsInlineKeyboard,
  adminReportsInlineKeyboard,
  adminSupportInlineKeyboard,
  renderAdminHomeScreen
} from "./ui/admin-screens.mjs";

function customerMenuText() {
  return [
    "🛍️ SEITON.ID",
    "Selamat datang! Pilih menu untuk mulai berbelanja.",
    "Katalog, pesanan, dan bantuan tersedia melalui tombol."
  ].join("\n");
}
function adminMenuText() {
  return renderAdminHomeScreen().text;
}
function customerMenuKeyboard() {
  return { inline_keyboard: [
    [
      { text: "🛍️ Katalog Produk", callback_data: "nav:catalog" },
      { text: "📦 Pesanan Saya", callback_data: "nav:orders" }
    ],
    [
      { text: "🧭 Cara Belanja", callback_data: "nav:guide" },
      { text: "💬 Bantuan", callback_data: "nav:help" }
    ]
  ] };
}
function adminMenuKeyboard() {
  return adminHomeKeyboard();
}
function adminOrdersKeyboard() {
  return adminOrdersInlineKeyboard();
}
function adminProductsKeyboard() {
  return adminProductsInlineKeyboard();
}
function adminReportsKeyboard() {
  return adminReportsInlineKeyboard();
}
function adminSupportKeyboard() {
  return { inline_keyboard: [
    [{ text: "🆘 Antrean Bantuan Pelanggan", callback_data: "adm:handoff", style: "primary" }],
    [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
  ] };
}
function adminCatalogKeyboard() {
  return { inline_keyboard: [
    [
      { text: "➕ Tambah Produk", callback_data: "adm:addproduct", style: "success" },
      { text: "⬅️ Menu Admin", callback_data: "adm:products" }
    ]
  ] };
}
const CUSTOMER_CATALOG_PAGE_SIZE = 5;
const CUSTOMER_CATEGORY_META = {
  digital: { title: "AI & Akun Digital", button: "🤖 AI & Digital" },
  email: { title: "Email & OTP", button: "✉️ Email & OTP" },
  website: { title: "Website & UMKM", button: "🌐 Website & UMKM" },
  automation: { title: "Bot & Otomasi", button: "⚙️ Bot & Otomasi" },
  other: { title: "Produk Lainnya", button: "📦 Produk Lainnya" }
};
const CUSTOMER_CATEGORY_ORDER = ["digital", "email", "website", "automation", "other"];
function customerCategoryForProduct(row) {
  const sku = String(row?.[0] || "").trim().toUpperCase();
  const text = [row?.[1], row?.[6]].map(value => String(value || "").toLowerCase()).join(" ");
  if (/^MUSE-|\bmuse\b|\bai\b|gemini|chatgpt|claude|grok|capcut|eleven.?labs/.test(sku + " " + text)) return "digital";
  if (/^OTP-|\botp\b|email|e-mail|mailbox|domain/.test(sku + " " + text)) return "email";
  if (/^SEI-|website|katalog|umkm/.test(sku + " " + text)) return "website";
  if (/^S-|bot|automation|automated|otomasi|integrasi/.test(sku + " " + text)) return "automation";
  return "other";
}
function customerCategoryTitle(key) {
  return CUSTOMER_CATEGORY_META[key]?.title || "Semua Produk";
}
function customerCatalogProducts(rows) {
  return (rows || []).filter(row => {
    if (!row?.[0]) return false;
    const product = parseCatalogProduct(row);
    return product.priceValid && product.stockValid;
  });
}
function customerProductCanBeOrdered(row) {
  const product = parseCatalogProduct(row);
  return product.active && product.priceValid && product.stockValid &&
    (product.stock === null || product.stock > 0);
}

function orderConfirmation(order, env) {
  const paymentInfo = order.paymentMethod === "QRIS"
    ? "\n\n📲 QRIS dinamis akan dikirim dalam layar pembayaran terpisah."
    : order.paymentMethod === "TRANSFER"
      ? "\n\n🏦 Instruksi transfer akan diberikan admin."
      : "\n\n🚚 Pembayaran COD dipilih.";
  return [
    "✅ *PESANAN DICATAT - SEITON.ID*",
    "🧾 ID: " + order.orderId,
    "📦 " + order.product + " (" + order.sku + ")",
    "🔢 Jumlah: " + order.quantity,
    "💵 Harga: " + rupiah(order.unitPrice),
    "🚚 Ongkir: " + rupiah(order.shipping),
    "💰 *Total: " + rupiah(order.total) + "*",
    "💳 Metode: " + order.paymentMethod,
    "⏳ Status: " + order.status,
    paymentInfo,
    "",
    "_Powered by Seiton.id_"
  ].join("\n");
}

function helpText() {
  return [
    "🛍️ *BOT PEMESANAN SEITON.ID*",
    "",
    "Buat pesanan dengan format:",
    "`beli SKU jumlah metode_pembayaran`",
    "",
    "Contoh: `beli SEI-001 2 QRIS`",
    "Metode: QRIS, TRANSFER, COD",
    "",
    "Admin: gunakan `/laporan` untuk rekap penjualan.",
    "_Powered by Seiton.id_"
  ].join("\n");
}


export {
  customerMenuText, adminMenuText, customerMenuKeyboard, adminMenuKeyboard,
  adminOrdersKeyboard, adminProductsKeyboard, adminReportsKeyboard,
  adminSupportKeyboard, adminCatalogKeyboard, customerCategoryForProduct,
  customerCategoryTitle, customerCatalogProducts, customerProductCanBeOrdered,
  orderConfirmation, helpText
};
