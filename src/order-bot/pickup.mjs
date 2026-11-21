import { PAID_ORDER_STATUSES, base64url, base64urlBytes, rupiah, constantTimeEqual } from "./utils.mjs";
import { sendTelegramPhoto, sendTelegram } from "./telegram-api.mjs";
import { findOrderById } from "./sheets-client.mjs";

async function createPickupTicketToken(env, orderId, receiptCode) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    order: orderId, code: receiptCode, v: 2,
    iat: now, exp: now + 30 * 24 * 60 * 60
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("SEITON_PICKUP_TICKET_V2." + payload));
  return payload + "." + base64urlBytes(new Uint8Array(sig));
}

async function verifyPickupTicketToken(env, token) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  try {
    const encoded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    const payload = JSON.parse(decoded);
    if (!payload || !payload.order || !payload.code || ![1, 2].includes(payload.v)) return null;
    if (payload.v === 2 && (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Math.floor(Date.now() / 1000))) return null;
    const prefix = payload.v === 2 ? "SEITON_PICKUP_TICKET_V2." : "SEITON_PICKUP_TICKET_V1.";
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prefix + parts[0]));
    if (!constantTimeEqual(base64urlBytes(new Uint8Array(sig)), parts[1])) return null;
    return payload;
  } catch {
    return null;
  }
}

async function createPickupTicketUrl(env, orderId, receiptCode) {
  const token = await createPickupTicketToken(env, orderId, receiptCode);
  return "https://automate-bot.seiton.biz.id/pickup?ticket=" + encodeURIComponent(token);
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
async function handlePickupVerificationPage(request, env) {
  const ticket = await verifyPickupTicketToken(env, new URL(request.url).searchParams.get("ticket"));
  let state = "INVALID", details = null;
  if (ticket) {
    const found = await findOrderById(env, ticket.order);
    if (found && String(found.row[18] || "") === ticket.code && String(found.row[13] || "") === "DISETUJUI" && PAID_ORDER_STATUSES.includes(String(found.row[12] || "").toUpperCase())) {
      details = found.row;
      state = String(found.row[19] || "") === "DIAMBIL" ? "USED" : "VALID";
    }
  }
  const isValid = state === "VALID";
  const title = state === "VALID" ? "PEMBAYARAN TERVERIFIKASI" : state === "USED" ? "PESANAN SUDAH DIAMBIL" : "TIKET TIDAK VALID";
  const color = state === "VALID" ? "#087f5b" : state === "USED" ? "#9a6700" : "#b42318";
  const body = details ? [
    "<div class='row'><span>ID Pesanan</span><b>" + escapeHtml(details[0]) + "</b></div>",
    "<div class='row'><span>Produk</span><b>" + escapeHtml(details[5]) + "</b></div>",
    "<div class='row'><span>Jumlah</span><b>" + escapeHtml(details[6]) + "</b></div>",
    "<div class='row'><span>Total</span><b>" + escapeHtml(rupiah(details[10])) + "</b></div>",
    "<div class='row'><span>Kode Resi</span><b>" + escapeHtml(details[18]) + "</b></div>",
    "<div class='row'><span>Status Pengambilan</span><b>" + (state === "USED" ? "SUDAH DIAMBIL" : "BELUM DIAMBIL") + "</b></div>"
  ].join("") : "<p>Kode tiket tidak ditemukan atau pembayaran belum disetujui.</p>";
  const html = "<!doctype html><html lang='id'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Verifikasi Resi Seiton.id</title><style>body{margin:0;background:#f2f5f8;font:16px system-ui;color:#1b2735;display:grid;min-height:100vh;place-items:center}.ticket{background:white;border:1px solid #dce3ea;border-radius:18px;padding:28px;max-width:460px;width:calc(100% - 40px);box-shadow:0 12px 40px #10203018}.brand{font-size:13px;color:#64748b;font-weight:700;letter-spacing:.1em}.state{font-weight:800;color:" + color + ";font-size:21px;margin:18px 0}.row{display:flex;justify-content:space-between;gap:18px;border-top:1px dashed #d9e0e8;padding:12px 0}.row span{color:#64748b}.row b{text-align:right;max-width:60%;overflow-wrap:anywhere}.note{font-size:12px;color:#64748b;margin-top:16px}</style><main class='ticket'><div class='brand'>SEITON.ID · TIKET PENGAMBILAN</div><div class='state'>" + title + "</div>" + body + "<p class='note'>Tunjukkan halaman ini kepada petugas saat mengambil pesanan. Tiket tidak membuktikan pembayaran bank di luar status verifikasi Seiton.id.</p></main></html>";
  return new Response(html, { status: 200, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer" } });
}
function pickupQrImageUrl(ticketUrl) {
  return "https://quickchart.io/qr?size=420&margin=2&ecLevel=H&text=" + encodeURIComponent(ticketUrl);
}
function pickupReceiptCaption(row, receiptCode) {
  return [
    "✅ BUKTI PEMBAYARAN TERVERIFIKASI · SEITON.ID",
    "ID Pesanan: " + row[0],
    "Pelanggan: " + (row[4] || "-"),
    "Produk: " + (row[5] || "-"),
    "Jumlah: " + (row[6] || 0),
    "Total: " + rupiah(row[10]),
    "Metode: " + (row[11] || "-"),
    "Kode Resi: " + receiptCode,
    "",
    "Tunjukkan QR ini kepada petugas saat pengambilan."
  ].join("\n");
}
async function sendPickupReceipt(env, customerId, row, orderId, receiptCode) {
  const ticketUrl = await createPickupTicketUrl(env, orderId, receiptCode);
  const caption = pickupReceiptCaption(row, receiptCode);
  try {
    await sendTelegramPhoto(env, customerId, pickupQrImageUrl(ticketUrl), caption, {
      inline_keyboard: [[{ text: "🔎 Periksa Status Resi", url: ticketUrl }]]
    });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "pickup_qr_send", message: error.message }));
    await sendTelegram(env, customerId, caption + "\n\nLink verifikasi: " + ticketUrl);
  }
}

export {
  createPickupTicketToken, verifyPickupTicketToken, createPickupTicketUrl,
  escapeHtml, handlePickupVerificationPage, pickupQrImageUrl,
  pickupReceiptCaption, sendPickupReceipt
};
