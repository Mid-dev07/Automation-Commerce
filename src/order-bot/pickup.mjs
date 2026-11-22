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
  const title = state === "VALID" ? "Pembayaran Terverifikasi" : state === "USED" ? "Pesanan Sudah Diambil" : "Tiket Tidak Valid";
  const pillStyle = state === "VALID"
    ? "background:#E7F6EC;border-color:#B7E4C7;color:#14532D"
    : state === "USED"
      ? "background:#FEF6E4;border-color:#F4D49C;color:#7C410C"
      : "background:#FEF1F2;border-color:#F5C2C7;color:#991B1B";
  const dotColor = state === "VALID" ? "#16A34A" : state === "USED" ? "#D97706" : "#DC2626";
  const body = details ? [
    "<div class='rows'>",
    "<div class='row'><span>ID Pesanan</span><b class='mono'>" + escapeHtml(details[0]) + "</b></div>",
    "<div class='row'><span>Produk</span><b>" + escapeHtml(details[5]) + "</b></div>",
    "<div class='row'><span>Jumlah</span><b class='mono'>" + escapeHtml(details[6]) + " pcs</b></div>",
    "<div class='row'><span>Total</span><b class='mono'>" + escapeHtml(rupiah(details[10])) + "</b></div>",
    "<div class='row'><span>Kode Resi</span><b class='mono'>" + escapeHtml(details[18]) + "</b></div>",
    "<div class='row'><span>Status Pengambilan</span><b>" + (state === "USED" ? "SUDAH DIAMBIL" : "BELUM DIAMBIL") + "</b></div>",
    "</div>"
  ].join("") : "<p class='empty'>Kode tiket tidak ditemukan atau pembayaran belum disetujui.</p>";
  const html = "<!doctype html><html lang='id'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='robots' content='noindex,nofollow'><meta name='theme-color' content='#F7F5EF'><title>Verifikasi Resi — Seiton.id</title><style>*,*::before,*::after{box-sizing:border-box}body{margin:0;min-height:100vh;padding:24px 16px;background:#F7F5EF;background-image:linear-gradient(to right,rgba(31,41,55,.04) 1px,transparent 1px),linear-gradient(to bottom,rgba(31,41,55,.04) 1px,transparent 1px);background-size:32px 32px;color:#1F2937;font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center}.ticket{width:min(460px,100%);background:#FFFFFF;border:1px solid #DFE1DC;border-top:4px solid #FF6B35;border-radius:16px;padding:28px;box-shadow:0 8px 24px rgba(31,41,55,.06)}.head{display:flex;align-items:center;gap:10px;margin-bottom:20px}.mark{width:34px;height:34px;border-radius:9px;background:#FF6B35;color:#1F2937;display:grid;place-items:center;font-weight:900;font-size:17px;flex:none}.brand{font-size:12px;color:#A94420;font-weight:800;letter-spacing:.08em}.pill{display:inline-flex;align-items:center;gap:8px;padding:7px 13px;border:1px solid;border-radius:999px;font-size:13px;font-weight:800;margin-bottom:18px;" + pillStyle + "}.pill::before{content:'';width:8px;height:8px;border-radius:50%;background:" + dotColor + ";flex:none}.rows{border-top:1px solid #DFE1DC}.row{display:flex;justify-content:space-between;align-items:baseline;gap:16px;border-bottom:1px dashed #DFE1DC;padding:12px 0}.row span{color:#525C68;font-size:13px}.row b{text-align:right;max-width:62%;overflow-wrap:anywhere;font-size:14px;color:#1F2937}.mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.empty{margin:0 0 12px;padding:14px;border:1px dashed #C8CBC3;border-radius:10px;background:#F2F0E8;color:#525C68;font-size:14px}.note{font-size:12px;color:#525C68;margin:18px 0 0;padding-top:14px;border-top:1px solid #DFE1DC;line-height:1.55}</style></head><body><main class='ticket'><div class='head'><span class='mark'>S</span><div class='brand'>SEITON.ID · TIKET PENGAMBILAN</div></div><div class='pill'>" + title + "</div>" + body + "<p class='note'>Tunjukkan halaman ini kepada petugas saat mengambil pesanan. Tiket tidak membuktikan pembayaran bank di luar status verifikasi Seiton.id.</p></main></body></html>";
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
