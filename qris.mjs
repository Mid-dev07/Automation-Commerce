export const MAX_QRIS_TRANSACTION_AMOUNT = 10_000_000;

function clean(value, max = 256) {
  return String(value ?? "").trim().slice(0, max);
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
  if (!/^[\x20-\x7E]+$/.test(input)) throw new Error("QRIS_TLV_CHARSET_INVALID");
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
    if (!/^[\x20-\x7E]*$/.test(value)) throw new Error("QRIS_TLV_VALUE_CHARSET_INVALID");
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
  let amount = null;
  if (seen.has("54")) {
    if (!/^\d{1,13}$/.test(values["54"])) throw new Error("QRIS_AMOUNT_FIELD_INVALID");
    amount = Number(values["54"]);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("QRIS_AMOUNT_FIELD_INVALID");
  }
  return {
    fields,
    values,
    pointOfInitiation: values["01"] || "",
    amount,
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
  const amountText = typeof amount === "number" ? String(amount) : String(amount ?? "").trim();
  if (!/^\d{1,13}$/.test(amountText)) throw new Error("QRIS_AMOUNT_INVALID");
  const nominal = Number(amountText);
  if (!Number.isSafeInteger(nominal) || nominal <= 0 || nominal > MAX_QRIS_TRANSACTION_AMOUNT) {
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


function isValidStaticMerchantTemplate(template) {
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

/** Dynamic payload generation remains opt-in until the QRIS acquirer confirms acceptance. */
export function isInternalQrisConfigured(env) {
  return String(env?.QRIS_INTERNAL_ENABLED || "false").toLowerCase() === "true"
    && isValidStaticMerchantTemplate(clean(env?.QRIS_STATIC_PAYLOAD, 4096));
}

/** Static MPM fallback is safe to display; the customer enters the exact amount manually. */
export function isStaticQrisFallbackConfigured(env) {
  return String(env?.QRIS_STATIC_FALLBACK_ENABLED || "false").toLowerCase() === "true"
    && isValidStaticMerchantTemplate(clean(env?.QRIS_STATIC_PAYLOAD, 4096));
}

export function getQrisCheckoutMode(env) {
  if (isInternalQrisConfigured(env)) return "DYNAMIC";
  if (isStaticQrisFallbackConfigured(env)) return "STATIC_FALLBACK";
  return "DISABLED";
}

export function isQrisCheckoutAvailable(env) {
  return getQrisCheckoutMode(env) !== "DISABLED";
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

export function generateQrisUniqueCode(maxCode = 999) {
  const ceiling = Number(maxCode);
  if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 999) {
    throw new Error("QRIS_UNIQUE_CODE_RANGE_INVALID");
  }
  // Rejection sampling avoids modulo bias across the available suffix range.
  const range = 0x100000000;
  const limit = Math.floor(range / ceiling) * ceiling;
  const random = new Uint32Array(1);
  for (let attempt = 0; attempt < 128; attempt++) {
    crypto.getRandomValues(random);
    if (random[0] < limit) return String((random[0] % ceiling) + 1).padStart(3, "0");
  }
  throw new Error("QRIS_UNIQUE_CODE_GENERATION_FAILED");
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
  const confidence = Number(extracted?.confidence);
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
  else if (actualAmount === expectedAmount && merchantStatus === "MATCHED" && timestampStatus === "MATCHED"
    && confidence !== null && confidence >= 0.65) status = "MATCHED";
  return {
    status, amount: actualAmount, merchantName: actualMerchant, merchantStatus,
    transactionAt: extractedAt, timestampStatus,
    reference: clean(extracted?.transaction_reference || extracted?.reference, 120),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    reasons
  };
}
