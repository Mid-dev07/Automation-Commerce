import { constantTimeEqual } from "./payment-mutations.mjs";

export const WEBHOOK_REPLAY_WINDOW_SEC = 300;
export const WEBHOOK_BACKOFF_SECONDS = Object.freeze([30, 120, 600, 1800, 7200]);

function clean(value, max = 512) {
  return String(value ?? "").trim().slice(0, max);
}

function isPrivateOrBlockedIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "metadata.google.internal" || host === "metadata.goog") return true;
  if (isPrivateOrBlockedIpv4(host)) return true;
  if (host.includes(":")) {
    // Block IPv6 loopback, link-local, unique-local, IPv4-mapped addresses.
    if (host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("::ffff:")) {
      return true;
    }
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  return false;
}

export function validateWebhookTargetUrl(rawUrl) {
  const text = clean(rawUrl, 1024);
  if (!text) return { ok: false, error: "URL webhook wajib diisi." };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: "Format URL webhook tidak valid." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "URL webhook wajib menggunakan HTTPS." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "URL webhook tidak boleh mengandung kredensial." };
  }
  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, error: "Host URL webhook diblokir (alamat lokal/privat/metadata)." };
  }
  return { ok: true, url: parsed.toString() };
}

export async function signWebhookPayload(rawBody, secret, timestampSec = Math.floor(Date.now() / 1000)) {
  const keyText = String(secret ?? "");
  if (!keyText) throw new Error("WEBHOOK_SECRET_MISSING");
  const ts = String(Math.floor(Number(timestampSec)));
  const message = `${ts}.${String(rawBody ?? "")}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const signature = Array.from(new Uint8Array(sigBuf), b => b.toString(16).padStart(2, "0")).join("");
  return { timestamp: ts, signature };
}

export async function verifyWebhookSignature(rawBody, secret, timestampSec, signatureHeader, nowSec = Math.floor(Date.now() / 1000), maxSkewSec = WEBHOOK_REPLAY_WINDOW_SEC) {
  const ts = Number(timestampSec);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > maxSkewSec) {
    return { ok: false, reason: "TIMESTAMP_OUT_OF_WINDOW" };
  }
  const supplied = clean(signatureHeader, 200).replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) {
    return { ok: false, reason: "SIGNATURE_MALFORMED" };
  }
  const expected = await signWebhookPayload(rawBody, secret, ts);
  if (!constantTimeEqual(expected.signature, supplied)) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }
  return { ok: true, reason: "VERIFIED" };
}

export function buildPaymentWebhookPayload(eventType, order, qrisPayment, mutation = null) {
  const baseAmount = Number(qrisPayment?.base_amount ?? order?.total ?? 0);
  const uniqueCode = Number(qrisPayment?.unique_code ?? 0);
  const totalAmount = Number(qrisPayment?.expected_amount ?? (baseAmount + uniqueCode));
  return {
    event: clean(eventType || "payment.paid", 64),
    transaction_id: clean(qrisPayment?.provider_order_id || order?.order_id, 120),
    external_order_id: clean(order?.order_id, 120),
    base_amount: baseAmount,
    unique_code: uniqueCode,
    total_amount: totalAmount,
    customer_name: clean(order?.customer_name, 120),
    receipt_code: clean(order?.receipt_code, 64),
    source_app: clean(mutation?.sourceApp || mutation?.source_app || "", 120),
    paid_at: clean(order?.payment_confirmed_at || new Date().toISOString(), 64),
    created_at: clean(order?.created_at || new Date().toISOString(), 64)
  };
}

export async function listActiveWebhookTargets(env, eventType = "payment.paid") {
  const targets = [];
  const envUrl = clean(env?.PAYMENT_WEBHOOK_URL, 1024);
  const envSecret = clean(env?.PAYMENT_WEBHOOK_SECRET, 256);
  if (envUrl && envSecret) {
    const check = validateWebhookTargetUrl(envUrl);
    if (check.ok) {
      targets.push({
        endpointId: "env-default",
        targetUrl: check.url,
        signingSecret: envSecret
      });
    }
  }
  if (env?.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT endpoint_id, target_url, signing_secret, events_json FROM payment_webhook_endpoints WHERE enabled = 1"
      ).all();
      for (const row of results || []) {
        let events = ["payment.paid"];
        try {
          const parsed = JSON.parse(String(row.events_json || '["payment.paid"]'));
          if (Array.isArray(parsed) && parsed.length) events = parsed;
        } catch {
          events = ["payment.paid"];
        }
        if (!events.includes(eventType) && !events.includes("*")) continue;
        const check = validateWebhookTargetUrl(row.target_url);
        if (!check.ok || !String(row.signing_secret || "")) continue;
        targets.push({
          endpointId: String(row.endpoint_id),
          targetUrl: check.url,
          signingSecret: String(row.signing_secret)
        });
      }
    } catch {
      // Table may not be migrated yet; fail gracefully and keep env target if present.
    }
  }
  return targets;
}

export async function enqueuePaymentWebhookDeliveries(env, eventType, payload) {
  const targets = await listActiveWebhookTargets(env, eventType);
  if (!targets.length || !env?.DB) return { enqueued: 0, deliveryIds: [] };
  const now = new Date().toISOString();
  const rawPayload = JSON.stringify(payload);
  const deliveryIds = [];
  const statements = [];
  for (const target of targets) {
    const deliveryId = "whd_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    deliveryIds.push(deliveryId);
    statements.push(
      env.DB.prepare(
        `INSERT INTO payment_webhook_deliveries
          (delivery_id, endpoint_id, order_id, event_type, target_url, payload_json, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, 5, ?, ?, ?)`
      ).bind(
        deliveryId,
        target.endpointId,
        clean(payload?.external_order_id || "TEST", 120),
        clean(eventType, 64),
        target.targetUrl,
        rawPayload,
        now,
        now,
        now
      )
    );
  }
  try {
    await env.DB.batch(statements);
    return { enqueued: deliveryIds.length, deliveryIds };
  } catch {
    return { enqueued: 0, deliveryIds: [] };
  }
}

async function resolveSigningSecret(env, endpointId) {
  if (endpointId === "env-default") return clean(env?.PAYMENT_WEBHOOK_SECRET, 256);
  if (!env?.DB) return "";
  const row = await env.DB.prepare(
    "SELECT signing_secret FROM payment_webhook_endpoints WHERE endpoint_id = ? AND enabled = 1 LIMIT 1"
  ).bind(endpointId).first();
  return clean(row?.signing_secret, 256);
}

export async function deliverSingleWebhook(targetUrl, secret, eventType, rawBody, deliveryId, attempt = 1, fetchImpl = fetch) {
  const check = validateWebhookTargetUrl(targetUrl);
  if (!check.ok) {
    return { ok: false, status: 0, error: check.error };
  }
  const { timestamp, signature } = await signWebhookPayload(rawBody, secret);
  try {
    const response = await fetchImpl(check.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Seiton-Webhook/1.0",
        "X-Seiton-Event": eventType,
        "X-Seiton-Timestamp": timestamp,
        "X-Seiton-Signature": signature,
        "X-Seiton-Delivery-Id": deliveryId,
        "X-Seiton-Attempt": String(attempt)
      },
      body: rawBody
    });
    if (response.ok) {
      return { ok: true, status: response.status, error: "" };
    }
    return { ok: false, status: response.status, error: `HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, error: clean(error?.message || "NETWORK_ERROR", 200) };
  }
}

export async function dispatchPaymentWebhookDeliveries(env, limit = 20, fetchImpl = fetch) {
  if (!env?.DB) return { claimed: 0, delivered: 0, failed: 0 };
  const nowIso = new Date().toISOString();
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT delivery_id, endpoint_id, event_type, target_url, payload_json, attempts, max_attempts
       FROM payment_webhook_deliveries
       WHERE status = 'PENDING' AND (next_attempt_at = '' OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`
    ).bind(nowIso, Math.max(1, Math.min(50, Number(limit) || 20))).all();
    rows = res?.results || [];
  } catch {
    return { claimed: 0, delivered: 0, failed: 0 };
  }

  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const nextAttempt = Number(row.attempts || 0) + 1;
    const maxAttempts = Number(row.max_attempts || 5);
    const secret = await resolveSigningSecret(env, String(row.endpoint_id));
    if (!secret) {
      await env.DB.prepare(
        "UPDATE payment_webhook_deliveries SET status='FAILED', attempts=?, last_error='SECRET_UNAVAILABLE', updated_at=? WHERE delivery_id=?"
      ).bind(nextAttempt, nowIso, row.delivery_id).run();
      failed++;
      continue;
    }
    const result = await deliverSingleWebhook(
      row.target_url,
      secret,
      row.event_type,
      row.payload_json,
      row.delivery_id,
      nextAttempt,
      fetchImpl
    );
    const doneIso = new Date().toISOString();
    if (result.ok) {
      await env.DB.prepare(
        "UPDATE payment_webhook_deliveries SET status='DELIVERED', attempts=?, last_http_status=?, last_error='', delivered_at=?, updated_at=? WHERE delivery_id=?"
      ).bind(nextAttempt, result.status, doneIso, doneIso, row.delivery_id).run();
      delivered++;
    } else if (nextAttempt >= maxAttempts) {
      await env.DB.prepare(
        "UPDATE payment_webhook_deliveries SET status='FAILED', attempts=?, last_http_status=?, last_error=?, updated_at=? WHERE delivery_id=?"
      ).bind(nextAttempt, result.status || null, result.error, doneIso, row.delivery_id).run();
      failed++;
    } else {
      const backoffSec = WEBHOOK_BACKOFF_SECONDS[Math.min(nextAttempt - 1, WEBHOOK_BACKOFF_SECONDS.length - 1)];
      const retryAt = new Date(Date.now() + backoffSec * 1000).toISOString();
      await env.DB.prepare(
        "UPDATE payment_webhook_deliveries SET status='PENDING', attempts=?, last_http_status=?, last_error=?, next_attempt_at=?, updated_at=? WHERE delivery_id=?"
      ).bind(nextAttempt, result.status || null, result.error, retryAt, doneIso, row.delivery_id).run();
      failed++;
    }
  }
  return { claimed: rows.length, delivered, failed };
}
