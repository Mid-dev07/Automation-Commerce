const MIDTRANS_SANDBOX_BASE = "https://api.sandbox.midtrans.com";
const MIDTRANS_PRODUCTION_BASE = "https://api.midtrans.com";
const MIDTRANS_QRIS_ACQUIRERS = new Set(["gopay", "airpay_shopee"]);

function clean(value, max = 256) {
  return String(value ?? "").trim().slice(0, max);
}

function midtransBase(env) {
  return String(env?.MIDTRANS_ENV || "sandbox").toLowerCase() === "production"
    ? MIDTRANS_PRODUCTION_BASE
    : MIDTRANS_SANDBOX_BASE;
}

function serverAuthorization(serverKey) {
  if (!serverKey) throw new Error("MIDTRANS_SERVER_KEY_MISSING");
  return "Basic " + btoa(String(serverKey) + ":");
}

export function isDynamicQrisConfigured(env) {
  return String(env?.QRIS_DYNAMIC_ENABLED || "false").toLowerCase() === "true"
    && Boolean(clean(env?.MIDTRANS_SERVER_KEY, 500))
    && MIDTRANS_QRIS_ACQUIRERS.has(String(env?.MIDTRANS_QRIS_ACQUIRER || "gopay").toLowerCase());
}

export function crc16CcittFalse(value) {
  const input = String(value ?? "");
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

function crcHex(value) {
  return crc16CcittFalse(value).toString(16).toUpperCase().padStart(4, "0");
}

export function parseEmvTlv(payload) {
  const input = String(payload ?? "");
  if (!input || input.length > 4096) throw new Error("QRIS_PAYLOAD_LENGTH_INVALID");
  const fields = [];
  let offset = 0;
  while (offset < input.length) {
    if (offset + 4 > input.length) throw new Error("QRIS_TLV_HEADER_TRUNCATED");
    const tag = input.slice(offset, offset + 2);
    const lengthText = input.slice(offset + 2, offset + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) {
      throw new Error("QRIS_TLV_HEADER_INVALID");
    }
    const length = Number(lengthText);
    const start = offset + 4;
    const end = start + length;
    if (end > input.length) throw new Error("QRIS_TLV_VALUE_TRUNCATED");
    fields.push({ tag, value: input.slice(start, end) });
    offset = end;
  }
  return fields;
}

export function encodeEmvTlv(fields) {
  if (!Array.isArray(fields)) throw new Error("QRIS_TLV_FIELDS_INVALID");
  return fields.map(field => {
    const tag = String(field?.tag ?? "");
    const value = String(field?.value ?? "");
    if (!/^\d{2}$/.test(tag) || value.length > 99) throw new Error("QRIS_TLV_FIELD_INVALID");
    return tag + String(value.length).padStart(2, "0") + value;
  }).join("");
}

export function verifyQrisPayload(payload) {
  const input = String(payload ?? "");
  const crcMarker = input.lastIndexOf("6304");
  if (crcMarker < 0 || crcMarker + 8 !== input.length) return false;
  const supplied = input.slice(crcMarker + 4).toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(supplied)) return false;
  return crcHex(input.slice(0, crcMarker + 4)) === supplied;
}

export function parseQrisPayload(payload) {
  const input = String(payload ?? "");
  if (!verifyQrisPayload(input)) throw new Error("QRIS_CRC_INVALID");
  const fields = parseEmvTlv(input);
  const seen = new Set();
  const values = {};
  for (const field of fields) {
    if (seen.has(field.tag)) throw new Error("QRIS_DUPLICATE_TOP_LEVEL_TAG");
    seen.add(field.tag);
    values[field.tag] = field.value;
  }
  if (values["00"] !== "01" || !["11", "12"].includes(values["01"]) || values["53"] !== "360" || values["58"] !== "ID") {
    throw new Error("QRIS_STANDARD_FIELDS_INVALID");
  }
  return {
    fields,
    values,
    pointOfInitiation: values["01"] || "",
    amount: values["54"] ? Number(values["54"]) : null,
    merchantName: values["59"] || "",
    merchantCity: values["60"] || ""
  };
}

/**
 * Convert a valid, acquirer-issued static MPM merchant payload into a
 * transaction-specific MPM payload. This only composes/validates the QR data;
 * the merchant's acquirer must permit this issuance method for production use.
 */
export function buildDynamicQrisPayload(staticPayload, amount) {
  const nominal = Number(amount);
  if (!Number.isSafeInteger(nominal) || nominal <= 0 || String(nominal).length > 13) {
    throw new Error("QRIS_AMOUNT_INVALID");
  }
  const parsed = parseQrisPayload(staticPayload);
  if (parsed.pointOfInitiation !== "11") throw new Error("QRIS_TEMPLATE_MUST_BE_STATIC_MPM");
  if (!parsed.fields.some(field => Number(field.tag) >= 26 && Number(field.tag) <= 51)) {
    throw new Error("QRIS_MERCHANT_ACCOUNT_MISSING");
  }

  const fields = [];
  let hasAmount = parsed.fields.some(field => field.tag === "54");
  let insertedAmount = false;
  for (const field of parsed.fields) {
    if (field.tag === "63") continue;
    if (field.tag === "01") {
      fields.push({ tag: "01", value: "12" });
      continue;
    }
    if (field.tag === "54") {
      fields.push({ tag: "54", value: String(nominal) });
      hasAmount = true;
      continue;
    }
    fields.push(field);
    if (field.tag === "53" && !hasAmount && !insertedAmount) {
      fields.push({ tag: "54", value: String(nominal) });
      insertedAmount = true;
    }
  }
  const body = encodeEmvTlv(fields);
  const withCrcHeader = body + "6304";
  const dynamicPayload = withCrcHeader + crcHex(withCrcHeader);
  const result = parseQrisPayload(dynamicPayload);
  if (result.pointOfInitiation !== "12" || result.amount !== nominal) {
    throw new Error("QRIS_DYNAMIC_COMPOSITION_FAILED");
  }
  return dynamicPayload;
}


/** Internal Seiton QRIS issuance gate. */
export function isInternalQrisConfigured(env) {
  if (String(env?.QRIS_INTERNAL_ENABLED || "false").toLowerCase() !== "true") return false;
  const template = clean(env?.QRIS_STATIC_PAYLOAD, 4096);
  if (!template) return false;
  try {
    const parsed = parseQrisPayload(template);
    return parsed.pointOfInitiation === "11"
      && Boolean(parsed.merchantName)
      && parsed.values["53"] === "360"
      && parsed.values["58"] === "ID"
      && parsed.fields.some(field => Number(field.tag) >= 26 && Number(field.tag) <= 51);
  } catch {
    return false;
  }
}

export function extractQrisMerchantProfile(payload) {
  const parsed = parseQrisPayload(payload);
  return {
    merchantName: clean(parsed.merchantName, 80),
    merchantCity: clean(parsed.merchantCity, 80),
    country: clean(parsed.values["58"], 2),
    currency: clean(parsed.values["53"], 3)
  };
}

export function generateQrisUniqueCode() {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return String((random[0] % 999) + 1).padStart(3, "0");
}

export function parseReceiptAmount(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  let text = String(value ?? "").trim().replace(/^(?:IDR|RP)\s*/i, "").replace(/\s/g, "");
  if (!text) return null;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(text)) {
    const decimal = text.split(",")[1];
    if (decimal && !/^0{1,2}$/.test(decimal)) return null;
    text = text.replace(/\./g, "").split(",")[0];
  } else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text)) {
    const decimal = text.split(".")[1];
    if (decimal && !/^0{1,2}$/.test(decimal)) return null;
    text = text.replace(/,/g, "").split(".")[0];
  } else if (/^\d+(?:[,.]\d{1,2})$/.test(text)) {
    const decimal = text.slice(-2);
    if (!/^0{1,2}$/.test(decimal)) return null;
    text = text.slice(0, -3);
  }
  if (!/^\d+$/.test(text)) return null;
  const amount = Number(text);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function receiptDate(value) {
  let text = clean(value, 100);
  if (!text) return null;
  text = text.replace(/\bWIB\b/i, "+07:00").replace(/\bWITA\b/i, "+08:00").replace(/\bWIT\b/i, "+09:00");
  const idDate = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (idDate) {
    const [,day,month,year,hour,minute,second="00"] = idDate;
    const zone = text.includes("+") ? text.slice(text.lastIndexOf("+")) : "+07:00";
    text = year+"-"+month.padStart(2,"0")+"-"+day.padStart(2,"0")+"T"+hour.padStart(2,"0")+":"+minute+":"+second+zone;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    text = text.replace(" ","T") + "+07:00";
  }
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function normalizedMerchantTokens(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ")
    .split(/\s+/)
    .filter(token => token.length >= 3 && !["TOKO","PT","CV","TBK","IDR","INDONESIA"].includes(token));
}

/** Extracted fields are a screening signal only, never proof of settlement. */
export function evaluateQrisReceipt(expected, extracted) {
  const expectedAmount = Number(expected?.expectedAmount);
  const actualAmount = parseReceiptAmount(extracted?.amount);
  const expectedMerchant = clean(expected?.merchantName, 100);
  const actualMerchant = clean(extracted?.merchant_name || extracted?.merchantName, 100);
  const expectedTokens = normalizedMerchantTokens(expectedMerchant);
  const actualTokens = new Set(normalizedMerchantTokens(actualMerchant));
  const overlap = expectedTokens.filter(token => actualTokens.has(token)).length;
  const merchantStatus = !actualMerchant || !expectedTokens.length ? "UNKNOWN"
    : overlap === expectedTokens.length ? "MATCHED" : overlap === 0 ? "MISMATCH" : "UNCERTAIN";
  const extractedAt = receiptDate(extracted?.transaction_datetime || extracted?.transaction_at || extracted?.date);
  const createdAt = Date.parse(String(expected?.createdAt || ""));
  const timestampStatus = !extractedAt || !Number.isFinite(createdAt) ? "UNKNOWN"
    : Date.parse(extractedAt) < createdAt - 5 * 60 * 1000 || Date.parse(extractedAt) > Date.now() + 5 * 60 * 1000
      ? "MISMATCH" : "MATCHED";
  const reasons = [];
  if (actualAmount === null) reasons.push("AMOUNT_NOT_READ");
  else if (actualAmount !== expectedAmount) reasons.push("AMOUNT_MISMATCH");
  if (merchantStatus === "MISMATCH") reasons.push("MERCHANT_MISMATCH");
  else if (merchantStatus !== "MATCHED") reasons.push("MERCHANT_UNCERTAIN");
  if (timestampStatus === "MISMATCH") reasons.push("TIMESTAMP_OUT_OF_RANGE");
  else if (timestampStatus !== "MATCHED") reasons.push("TIMESTAMP_NOT_READ");
  let status = "REVIEW";
  if (actualAmount !== null && actualAmount !== expectedAmount) status = "MISMATCH";
  else if (merchantStatus === "MISMATCH" || timestampStatus === "MISMATCH") status = "MISMATCH";
  else if (actualAmount === expectedAmount && merchantStatus === "MATCHED" && timestampStatus === "MATCHED") status = "MATCHED";
  const confidence = Number(extracted?.confidence);
  return {
    status, amount: actualAmount, merchantName: actualMerchant, merchantStatus,
    transactionAt: extractedAt, timestampStatus,
    reference: clean(extracted?.transaction_reference || extracted?.reference, 120),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    reasons
  };
}

export function normalizeMidtransStatus(status) {
  const value = String(status ?? "").trim().toLowerCase();
  if (value === "settlement") return "PAID";
  if (value === "expire") return "EXPIRED";
  if (value === "cancel" || value === "deny" || value === "failure") return "FAILED";
  if (value === "pending") return "PENDING";
  return "UNKNOWN";
}

export function parseMidtransAmount(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.00)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isSafeInteger(amount) ? amount : null;
}

export async function verifyMidtransNotification(payload, serverKey) {
  const orderId = clean(payload?.order_id, 80);
  const statusCode = clean(payload?.status_code, 8);
  const grossAmount = clean(payload?.gross_amount, 32);
  const signature = clean(payload?.signature_key, 256).toLowerCase();
  if (!orderId || !statusCode || !grossAmount || !/^[0-9a-f]{128}$/.test(signature) || !serverKey) return false;

  const source = orderId + statusCode + grossAmount + String(serverKey);
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(source));
  const expected = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return difference === 0;
}

export async function createMidtransQrisCharge(env, order) {
  if (!isDynamicQrisConfigured(env)) throw new Error("QRIS_DYNAMIC_NOT_CONFIGURED");
  const orderId = clean(order?.providerOrderId || order?.orderId, 50);
  const amount = Number(order?.amount ?? order?.total);
  if (!orderId || !Number.isSafeInteger(amount) || amount <= 0) throw new Error("MIDTRANS_ORDER_INVALID");

  const acquirer = String(env.MIDTRANS_QRIS_ACQUIRER || "gopay").toLowerCase();
  const itemDetails = (Array.isArray(order.items) ? order.items : []).map(item => ({
    id: clean(item.sku || item.id, 50),
    price: Number(item.price),
    quantity: Number(item.quantity),
    name: clean(item.name, 50) || "Produk Seiton"
  }));
  if (itemDetails.length) {
    const subtotal = itemDetails.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = Math.max(0, amount - subtotal);
    if (shipping > 0) itemDetails.push({ id: "SEITON-SHIPPING", price: shipping, quantity: 1, name: "Biaya pengiriman" });
    if (itemDetails.reduce((sum, item) => sum + item.price * item.quantity, 0) !== amount) {
      throw new Error("MIDTRANS_ITEM_TOTAL_MISMATCH");
    }
  }

  const body = {
    payment_type: "qris",
    transaction_details: { order_id: orderId, gross_amount: amount },
    qris: { acquirer }
  };
  if (itemDetails.length) body.item_details = itemDetails;
  if (order.customerDetails && typeof order.customerDetails === "object") {
    body.customer_details = order.customerDetails;
  }

  const response = await fetch(midtransBase(env) + "/v2/charge", {
    method: "POST",
    headers: {
      Authorization: serverAuthorization(env.MIDTRANS_SERVER_KEY),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok || String(result.payment_type || "").toLowerCase() !== "qris"
    || String(result.order_id || "") !== orderId
    || parseMidtransAmount(result.gross_amount) !== amount) {
    throw new Error("MIDTRANS_QRIS_CREATE_FAILED_" + response.status + "_" + clean(result.status_message || result.message, 80));
  }

  const qrActions = Array.isArray(result.actions) ? result.actions : [];
  // Prefer the newer ASPI-format image action where Midtrans supplies it.
  const qrAction = qrActions.find(action => String(action.name || "") === "generate-qr-code-v2")
    || qrActions.find(action => String(action.name || "") === "generate-qr-code");
  const qrImageUrl = String(qrAction?.url || "");
  const allowedHosts = new Set(["api.midtrans.com", "api.sandbox.midtrans.com"]);
  let parsedUrl;
  try { parsedUrl = new URL(qrImageUrl); } catch { throw new Error("MIDTRANS_QRIS_IMAGE_URL_INVALID"); }
  if (parsedUrl.protocol !== "https:" || !allowedHosts.has(parsedUrl.hostname)) {
    throw new Error("MIDTRANS_QRIS_IMAGE_HOST_INVALID");
  }

  return {
    provider: "midtrans",
    providerOrderId: orderId,
    transactionId: clean(result.transaction_id, 100),
    merchantId: clean(result.merchant_id, 80),
    amount,
    status: normalizeMidtransStatus(result.transaction_status),
    rawStatus: clean(result.transaction_status, 40),
    qrImageUrl,
    expiresAt: (() => {
      const explicit = clean(result.expiry_time, 80);
      if (explicit) return explicit;
      const transactionTime = clean(result.transaction_time, 80);
      const parsedTime = transactionTime
        ? new Date(transactionTime.replace(" ", "T") + (/[zZ]|[+-]\d{2}:\d{2}$/.test(transactionTime) ? "" : "+07:00"))
        : new Date();
      const base = Number.isNaN(parsedTime.getTime()) ? new Date() : parsedTime;
      const defaultMinutes = acquirer === "airpay_shopee" ? 5 : 15;
      return new Date(base.getTime() + defaultMinutes * 60 * 1000).toISOString();
    })()
  };
}

export async function getMidtransTransactionStatus(env, providerOrderId) {
  if (!clean(env?.MIDTRANS_SERVER_KEY, 500)) throw new Error("MIDTRANS_SERVER_KEY_MISSING");
  const orderId = clean(providerOrderId, 50);
  if (!orderId) throw new Error("MIDTRANS_ORDER_ID_REQUIRED");
  const response = await fetch(midtransBase(env) + "/v2/" + encodeURIComponent(orderId) + "/status", {
    method: "GET",
    headers: {
      Authorization: serverAuthorization(env.MIDTRANS_SERVER_KEY),
      Accept: "application/json"
    }
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok || String(result.order_id || "") !== orderId) {
    throw new Error("MIDTRANS_STATUS_LOOKUP_FAILED_" + response.status);
  }
  return {
    providerOrderId: orderId,
    transactionId: clean(result.transaction_id, 100),
    amount: parseMidtransAmount(result.gross_amount),
    paymentType: clean(result.payment_type, 24).toLowerCase(),
    currency: clean(result.currency, 8).toUpperCase(),
    fraudStatus: clean(result.fraud_status, 24).toLowerCase(),
    acquirer: clean(result.acquirer, 32).toLowerCase(),
    status: normalizeMidtransStatus(result.transaction_status),
    rawStatus: clean(result.transaction_status, 40),
    merchantId: clean(result.merchant_id, 80)
  };
}

export const qrisInternals = Object.freeze({
  MIDTRANS_SANDBOX_BASE,
  MIDTRANS_PRODUCTION_BASE,
  MIDTRANS_QRIS_ACQUIRERS
});
