import { MAX_QRIS_TRANSACTION_AMOUNT, parseReceiptAmount } from "../../qris.mjs";

export const SUPPORTED_MUTATION_APPS = Object.freeze([
  "com.gojek.gopaymerchant",
  "com.gojek.gobiz",
  "id.dana",
  "id.dana.merchant",
  "com.bca.merchant",
  "com.bca",
  "id.co.bri.brimo",
  "com.jago.digitalBanking",
  "ovo.id",
  "com.shopee.id.merchant"
]);

const INCOMING_KEYWORDS = [
  "pembayaran masuk",
  "pembayaran diterima",
  "berhasil diterima",
  "menerima pembayaran",
  "terima pembayaran",
  "dana masuk",
  "saldo masuk",
  "uang masuk",
  "payment received",
  "transaksi qris",
  "pembayaran qris",
  "qris masuk",
  "transfer masuk",
  "kamu menerima",
  "anda menerima"
];

const REJECT_KEYWORDS = [
  "transfer keluar",
  "pembayaran ke ",
  "bayar ke ",
  "pembayaran berhasil ke",
  "penarikan",
  "pencairan",
  "settlement",
  "cashback",
  "promo",
  "voucher",
  "diskon",
  "gagal",
  "ditolak",
  "dibatalkan",
  "kedaluwarsa",
  "expired",
  "kode otp",
  "jangan bagikan"
];

function clean(value, max = 512) {
  return String(value ?? "").trim().slice(0, max);
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a ?? ""));
  const right = new TextEncoder().encode(String(b ?? ""));
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function extractIdrAmountFromText(text) {
  const input = clean(text, 2000);
  if (!input) return null;
  const currencyRegex = /\b(?:RP|IDR)\.?\s*([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,]00)?|[0-9]{1,8}(?:[.,]00)?)\b/gi;
  const matches = [];
  let m;
  while ((m = currencyRegex.exec(input)) !== null) {
    const parsed = parseReceiptAmount(m[1]);
    if (parsed !== null && parsed > 0 && parsed <= MAX_QRIS_TRANSACTION_AMOUNT) {
      matches.push(parsed);
    }
  }
  if (!matches.length) return null;
  return matches[0];
}

export function parseMutationNotification(payload) {
  const sourceApp = clean(payload?.source_app || payload?.package_name || payload?.app, 120).toLowerCase();
  const title = clean(payload?.title, 200);
  const body = clean(payload?.text || payload?.body || payload?.message, 1000);
  const notificationId = clean(payload?.notification_id || payload?.id, 120);
  const combined = `${title} ${body}`.trim();
  const lower = combined.toLowerCase();

  if (!sourceApp) {
    return { accepted: false, reason: "SOURCE_APP_MISSING", sourceApp, title, body, amount: null, notificationId };
  }
  if (!combined) {
    return { accepted: false, reason: "EMPTY_NOTIFICATION", sourceApp, title, body, amount: null, notificationId };
  }
  for (const rejectWord of REJECT_KEYWORDS) {
    if (lower.includes(rejectWord)) {
      return { accepted: false, reason: "NON_INCOMING_NOTIFICATION", sourceApp, title, body, amount: null, notificationId };
    }
  }
  const hasIncomingSignal = INCOMING_KEYWORDS.some(word => lower.includes(word));
  if (!hasIncomingSignal) {
    return { accepted: false, reason: "NO_INCOMING_KEYWORD", sourceApp, title, body, amount: null, notificationId };
  }
  const amount = extractIdrAmountFromText(combined);
  if (amount === null) {
    return { accepted: false, reason: "AMOUNT_NOT_FOUND", sourceApp, title, body, amount: null, notificationId };
  }
  return {
    accepted: true,
    reason: "PARSED",
    sourceApp,
    title,
    body,
    amount,
    notificationId
  };
}

export async function buildMutationDedupeKey(parsed, nowMs = Date.now()) {
  if (parsed.notificationId) {
    return sha256Hex(`nid:${parsed.sourceApp}:${parsed.notificationId}`);
  }
  const minuteBucket = Math.floor(nowMs / 60_000);
  const normalized = `${parsed.sourceApp}|${parsed.amount ?? ""}|${parsed.title.toLowerCase()}|${parsed.body.toLowerCase()}|${minuteBucket}`;
  return sha256Hex(`msg:${normalized}`);
}

export async function verifyMutationDeviceToken(env, suppliedToken) {
  const token = clean(suppliedToken, 256);
  if (!token) return { ok: false, reason: "MISSING_TOKEN" };

  const envToken = clean(env?.MUTATION_DEVICE_TOKEN, 256);
  if (envToken && constantTimeEqual(token, envToken)) {
    return { ok: true, deviceId: "env-device", label: "env-default", allowedApps: [] };
  }

  if (env?.DB) {
    try {
      const tokenHash = await sha256Hex(token);
      const row = await env.DB.prepare(
        "SELECT device_id, label, allowed_apps_json, enabled, revoked_at FROM payment_listener_devices WHERE token_hash = ? LIMIT 1"
      ).bind(tokenHash).first();
      if (row && Number(row.enabled) === 1 && !String(row.revoked_at || "")) {
        let allowedApps = [];
        try {
          const parsed = JSON.parse(String(row.allowed_apps_json || "[]"));
          if (Array.isArray(parsed)) allowedApps = parsed.map(x => String(x || "").toLowerCase()).filter(Boolean);
        } catch {
          allowedApps = [];
        }
        return {
          ok: true,
          deviceId: String(row.device_id),
          label: String(row.label || ""),
          allowedApps
        };
      }
    } catch {
      return { ok: false, reason: "DEVICE_LOOKUP_UNAVAILABLE" };
    }
  }
  return { ok: false, reason: "INVALID_TOKEN" };
}
