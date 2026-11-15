import test from "node:test";
import assert from "node:assert/strict";
import {
  crc16CcittFalse,
  parseEmvTlv,
  encodeEmvTlv,
  verifyQrisPayload,
  parseQrisPayload,
  buildDynamicQrisPayload,
  parseMidtransAmount,
  normalizeMidtransStatus,
  verifyMidtransNotification
} from "../qris.mjs";

function withCrc(fields) {
  const body = encodeEmvTlv(fields);
  const head = body + "6304";
  const crc = crc16CcittFalse(head).toString(16).toUpperCase().padStart(4, "0");
  return head + crc;
}

function staticMerchantTemplate(withAmount = false) {
  const fields = [
    { tag: "00", value: "01" },
    { tag: "01", value: "11" },
    { tag: "26", value: "0012A0000000000000000000" },
    { tag: "52", value: "5812" },
    { tag: "53", value: "360" },
    { tag: "58", value: "ID" },
    { tag: "59", value: "SEITON.ID" },
    { tag: "60", value: "JEMBER" },
    { tag: "62", value: "0503ABC" }
  ];
  if (withAmount) fields.splice(5, 0, { tag: "54", value: "10000" });
  return withCrc(fields);
}

test("CRC16/CCITT-FALSE matches the canonical check vector", () => {
  assert.equal(crc16CcittFalse("123456789"), 0x29b1);
});

test("EMV TLV encode and parse preserve fields and reject truncation", () => {
  const fields = [{ tag: "00", value: "01" }, { tag: "53", value: "360" }];
  assert.deepEqual(parseEmvTlv(encodeEmvTlv(fields)), fields);
  assert.throws(() => parseEmvTlv("0004ABC"), /TRUNCATED/);
});

test("Seiton QRIS core converts an acquirer-issued static MPM template into a dynamic amount payload", () => {
  const template = staticMerchantTemplate();
  assert.equal(verifyQrisPayload(template), true);
  const dynamic = buildDynamicQrisPayload(template, 125000);
  const parsed = parseQrisPayload(dynamic);
  assert.equal(parsed.pointOfInitiation, "12");
  assert.equal(parsed.amount, 125000);
  assert.equal(parsed.values["53"], "360");
  assert.equal(parsed.values["58"], "ID");
  assert.equal(verifyQrisPayload(dynamic), true);
  assert.equal(parseQrisPayload(template).pointOfInitiation, "11", "merchant template remains unchanged");
});

test("QRIS composer updates an existing template amount instead of duplicating tag 54", () => {
  const dynamic = buildDynamicQrisPayload(staticMerchantTemplate(true), 85000);
  const tags = parseEmvTlv(dynamic).filter(field => field.tag === "54");
  assert.equal(tags.length, 1);
  assert.equal(tags[0].value, "85000");
});

test("Seiton QRIS core rejects invalid nominal, non-QRIS template and invalid CRC", () => {
  const template = staticMerchantTemplate();
  assert.throws(() => buildDynamicQrisPayload(template, 0), /AMOUNT_INVALID/);
  assert.throws(() => buildDynamicQrisPayload(template, 125000.5), /AMOUNT_INVALID/);
  assert.throws(() => buildDynamicQrisPayload(template.slice(0, -1) + "0", 125000), /CRC_INVALID/);
  const wrongMode = withCrc([
    { tag: "00", value: "01" }, { tag: "01", value: "12" },
    { tag: "26", value: "0012A0000000000000000000" },
    { tag: "52", value: "5812" }, { tag: "53", value: "360" }, { tag: "58", value: "ID" }
  ]);
  assert.throws(() => buildDynamicQrisPayload(wrongMode, 10000), /MUST_BE_STATIC/);
});

test("Midtrans QRIS status and IDR amount normalization are strict", () => {
  assert.equal(parseMidtransAmount("125000.00"), 125000);
  assert.equal(parseMidtransAmount("125000"), 125000);
  assert.equal(parseMidtransAmount("125000.50"), null);
  assert.equal(normalizeMidtransStatus("settlement"), "PAID");
  assert.equal(normalizeMidtransStatus("pending"), "PENDING");
  assert.equal(normalizeMidtransStatus("expire"), "EXPIRED");
  assert.equal(normalizeMidtransStatus("deny"), "FAILED");
});

test("Midtrans webhook signature verification rejects forged and mutated payloads", async () => {
  const serverKey = "unit-test-server-key";
  const payload = {
    order_id: "SEI-20261115-ABCD1234",
    status_code: "200",
    gross_amount: "125000.00"
  };
  const bytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-512",
    new TextEncoder().encode(payload.order_id + payload.status_code + payload.gross_amount + serverKey)
  ));
  payload.signature_key = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyMidtransNotification(payload, serverKey), true);
  assert.equal(await verifyMidtransNotification({ ...payload, gross_amount: "125001.00" }, serverKey), false);
  assert.equal(await verifyMidtransNotification(payload, "wrong-key"), false);
});


test("Midtrans sandbox/production settings are explicit and QRIS acquirer is restricted", async () => {
  const { isDynamicQrisConfigured, qrisInternals } = await import("../qris.mjs");
  assert.equal(isDynamicQrisConfigured({
    QRIS_DYNAMIC_ENABLED: "true",
    MIDTRANS_SERVER_KEY: "test-key",
    MIDTRANS_QRIS_ACQUIRER: "gopay"
  }), true);
  assert.equal(isDynamicQrisConfigured({
    QRIS_DYNAMIC_ENABLED: "false",
    MIDTRANS_SERVER_KEY: "test-key",
    MIDTRANS_QRIS_ACQUIRER: "gopay"
  }), false);
  assert.equal(isDynamicQrisConfigured({
    QRIS_DYNAMIC_ENABLED: "true",
    MIDTRANS_SERVER_KEY: "test-key",
    MIDTRANS_QRIS_ACQUIRER: "unknown"
  }), false);
  assert.equal(qrisInternals.MIDTRANS_SANDBOX_BASE, "https://api.sandbox.midtrans.com");
  assert.equal(qrisInternals.MIDTRANS_PRODUCTION_BASE, "https://api.midtrans.com");
});

test("Midtrans charge adapter prefers ASPI QR image, authenticates, and checks exact IDR amount", async () => {
  const { createMidtransQrisCharge } = await import("../qris.mjs");
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({
      status_code: "201",
      transaction_id: "midtrans-transaction-1",
      order_id: "SEI-20261115-ABCD1234",
      merchant_id: "M000001",
      gross_amount: "125000.00",
      currency: "IDR",
      payment_type: "qris",
      transaction_status: "pending",
      fraud_status: "accept",
      transaction_time: "2026-11-15 08:00:00",
      actions: [
        { name: "generate-qr-code", method: "GET", url: "https://api.sandbox.midtrans.com/v2/qris/midtrans-transaction-1/qr-code" },
        { name: "generate-qr-code-v2", method: "GET", url: "https://api.sandbox.midtrans.com/v4/qris/QR-REF-1/qr-code" }
      ]
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await createMidtransQrisCharge({
      MIDTRANS_ENV: "sandbox", MIDTRANS_SERVER_KEY: "sandbox-server-key",
      QRIS_DYNAMIC_ENABLED: "true", MIDTRANS_QRIS_ACQUIRER: "gopay"
    }, { orderId: "SEI-20261115-ABCD1234", amount: 125000 });
    assert.equal(request.url, "https://api.sandbox.midtrans.com/v2/charge");
    assert.equal(request.options.headers.Authorization, "Basic " + btoa("sandbox-server-key:"));
    assert.equal(JSON.parse(request.options.body).payment_type, "qris");
    assert.equal(result.qrImageUrl, "https://api.sandbox.midtrans.com/v4/qris/QR-REF-1/qr-code");
    assert.equal(result.amount, 125000);
    await assert.rejects(() => createMidtransQrisCharge({
      MIDTRANS_ENV: "sandbox", MIDTRANS_SERVER_KEY: "sandbox-server-key",
      QRIS_DYNAMIC_ENABLED: "true", MIDTRANS_QRIS_ACQUIRER: "gopay"
    }, { orderId: "SEI-20261115-ABCD1234", amount: 125001 }), /MIDTRANS_QRIS_CREATE_FAILED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Midtrans Status API returns fraud status for settlement validation", async () => {
  const { getMidtransTransactionStatus } = await import("../qris.mjs");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.sandbox.midtrans.com/v2/SEI-20261115-ABCD1234/status");
    assert.equal(options.headers.Authorization, "Basic " + btoa("sandbox-server-key:"));
    return new Response(JSON.stringify({
      order_id: "SEI-20261115-ABCD1234",
      transaction_id: "midtrans-transaction-1",
      gross_amount: "125000.00",
      payment_type: "qris",
      currency: "IDR",
      transaction_status: "settlement",
      fraud_status: "accept",
      merchant_id: "M000001"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const status = await getMidtransTransactionStatus({
      MIDTRANS_ENV: "sandbox", MIDTRANS_SERVER_KEY: "sandbox-server-key"
    }, "SEI-20261115-ABCD1234");
    assert.equal(status.status, "PAID");
    assert.equal(status.fraudStatus, "accept");
    assert.equal(status.amount, 125000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Midtrans QRIS expiry is estimated from provider transaction time by acquirer defaults", async () => {
  const { createMidtransQrisCharge } = await import("../qris.mjs");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status_code: "201",
    transaction_id: "midtrans-transaction-expiry",
    order_id: "SEI-20261115-ABCD1234",
    merchant_id: "M000001",
    gross_amount: "125000.00",
    currency: "IDR",
    payment_type: "qris",
    transaction_status: "pending",
    fraud_status: "accept",
    transaction_time: "2026-11-15 08:00:00",
    actions: [{
      name: "generate-qr-code-v2",
      method: "GET",
      url: "https://api.sandbox.midtrans.com/v4/qris/QR-REF-1/qr-code"
    }]
  }), { status: 201, headers: { "Content-Type": "application/json" } });
  try {
    const gopay = await createMidtransQrisCharge({
      MIDTRANS_ENV: "sandbox", MIDTRANS_SERVER_KEY: "sandbox-server-key",
      QRIS_DYNAMIC_ENABLED: "true", MIDTRANS_QRIS_ACQUIRER: "gopay"
    }, { orderId: "SEI-20261115-ABCD1234", amount: 125000 });
    const airpay = await createMidtransQrisCharge({
      MIDTRANS_ENV: "sandbox", MIDTRANS_SERVER_KEY: "sandbox-server-key",
      QRIS_DYNAMIC_ENABLED: "true", MIDTRANS_QRIS_ACQUIRER: "airpay_shopee"
    }, { orderId: "SEI-20261115-ABCD1234", amount: 125000 });
    assert.equal(new Date(gopay.expiresAt).toISOString(), "2026-11-15T01:15:00.000Z");
    assert.equal(new Date(airpay.expiresAt).toISOString(), "2026-11-15T01:05:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal QRIS gate requires enabled flag and a valid static merchant template", async () => {
  const { isInternalQrisConfigured, extractQrisMerchantProfile } = await import("../qris.mjs");
  const template = staticMerchantTemplate();
  assert.equal(isInternalQrisConfigured({ QRIS_INTERNAL_ENABLED: "true", QRIS_STATIC_PAYLOAD: template }), true);
  assert.equal(isInternalQrisConfigured({ QRIS_INTERNAL_ENABLED: "false", QRIS_STATIC_PAYLOAD: template }), false);
  assert.equal(isInternalQrisConfigured({ QRIS_INTERNAL_ENABLED: "true", QRIS_STATIC_PAYLOAD: "broken" }), false);
  assert.deepEqual(extractQrisMerchantProfile(template), {
    merchantName: "SEITON.ID", merchantCity: "JEMBER", country: "ID", currency: "360"
  });
});

test("QRIS unique suffix is always three digits between 001 and 999", async () => {
  const { generateQrisUniqueCode } = await import("../qris.mjs");
  for (let index = 0; index < 100; index++) {
    const code = generateQrisUniqueCode();
    assert.match(code, /^[0-9]{3}$/);
    assert.ok(Number(code) >= 1 && Number(code) <= 999);
  }
});

test("receipt amount parser handles Indonesian and plain IDR formats", async () => {
  const { parseReceiptAmount } = await import("../qris.mjs");
  assert.equal(parseReceiptAmount("Rp 75.037"), 75037);
  assert.equal(parseReceiptAmount("75.037,00"), 75037);
  assert.equal(parseReceiptAmount("75037"), 75037);
  assert.equal(parseReceiptAmount("75,50"), null);
  assert.equal(parseReceiptAmount("Rp 75.038"), 75038);
});

test("receipt OCR evaluation is deterministic and never certifies settlement", async () => {
  const { evaluateQrisReceipt } = await import("../qris.mjs");
  const result = evaluateQrisReceipt({
    expectedAmount: 75037,
    merchantName: "SEITON.ID",
    createdAt: new Date(Date.now() - 60_000).toISOString()
  }, {
    amount: "75.037",
    merchant_name: "SEITON ID",
    transaction_datetime: new Date().toISOString(),
    transaction_reference: "TRX-ABC-123",
    confidence: 0.95
  });
  assert.equal(result.status, "MATCHED");
  assert.equal(result.amount, 75037);
  assert.equal(result.reference, "TRX-ABC-123");
  assert.equal("paid" in result, false);
  const uncertain = evaluateQrisReceipt({
    expectedAmount: 75037, merchantName: "SEITON.ID",
    createdAt: new Date(Date.now() - 60_000).toISOString()
  }, {
    amount: 75037, merchant_name: "SEITON ID",
    transaction_datetime: new Date().toISOString(), confidence: 0.3
  });
  assert.equal(uncertain.status, "REVIEW");
  const mismatch = evaluateQrisReceipt({
    expectedAmount: 75037, merchantName: "SEITON.ID",
    createdAt: new Date(Date.now() - 60_000).toISOString()
  }, { amount: 75038, merchant_name: "SEITON ID", transaction_datetime: new Date().toISOString() });
  assert.equal(mismatch.status, "MISMATCH");
});
