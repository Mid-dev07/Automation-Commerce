const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TELEGRAM_API = "https://api.telegram.org";
const SEITON_LOGO_URL = "https://seiton.biz.id/logo-horizontal.png";
const TZ = "Asia/Jakarta";
const HEADERS = [
  "order_id", "created_at", "channel", "customer_id", "customer_name",
  "product", "quantity", "unit_price", "subtotal", "shipping", "total",
  "payment_method", "status"
];
const PAID_ORDER_STATUSES = ["DIBAYAR", "DIPROSES", "DIKIRIM", "SELESAI", "PAID", "COMPLETED"];
const CANCELLED_ORDER_STATUSES = ["DIBATALKAN", "CANCELLED", "CANCELED"];
const PAYMENT_WORKFLOW_HEADERS = [
  "payment_confirmation_status", "payment_proof_file_id", "payment_proof_type",
  "payment_requested_at", "payment_confirmed_at", "receipt_code", "pickup_status"
];

function parseCatalogProduct(row) {
  const sku = String(row[0] || "").trim();
  const rawPrice = row[2], price = Number(rawPrice);
  const priceValid = rawPrice != null && String(rawPrice).trim() !== "" && Number.isSafeInteger(price) && price >= 0;
  const rawStock = row[3];
  const stockBlank = rawStock == null || String(rawStock).trim() === "";
  const parsedStock = stockBlank ? null : Number(rawStock);
  const stockValid = stockBlank || (Number.isSafeInteger(parsedStock) && parsedStock >= 0);
  const activeText = String(row[4] ?? "TRUE").trim().toUpperCase();
  const active = activeText === "" || ["TRUE","1","YA","YES","AKTIF"].includes(activeText);
  return {
    sku, name: String(row[1] || sku).trim(), price: priceValid ? price : 0, priceValid,
    stock: stockValid ? parsedStock : null, stockValid, active,
    photoUrl: String(row[5] || "").trim(), description: String(row[6] || "").trim()
  };
}

function base64url(value) {
  return base64urlBytes(new TextEncoder().encode(value));
}
function base64urlBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function rupiah(value) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export {
  SHEETS_BASE, GOOGLE_TOKEN_URL, TELEGRAM_API, SEITON_LOGO_URL, TZ, HEADERS,
  PAID_ORDER_STATUSES, CANCELLED_ORDER_STATUSES, PAYMENT_WORKFLOW_HEADERS,
  parseCatalogProduct, base64url, base64urlBytes, rupiah, json, constantTimeEqual
};
