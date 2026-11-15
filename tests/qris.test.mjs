import test from "node:test";
import assert from "node:assert/strict";
import {
  crc16CcittFalse,
  parseEmvTlv,
  encodeEmvTlv,
  verifyQrisPayload,
  parseQrisPayload,
  buildDynamicQrisPayload,
  MAX_QRIS_TRANSACTION_AMOUNT,
  generateQrisUniqueCode,
  isInternalQrisConfigured,
  isStaticQrisFallbackConfigured,
  getQrisCheckoutMode
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

test("QRIS converter preserves merchant fields and places one exact amount in dynamic MPM", () => {
  const template = staticMerchantTemplate();
  const source = parseQrisPayload(template);
  const dynamicPayload = buildDynamicQrisPayload(template, 125137);
  const dynamic = parseQrisPayload(dynamicPayload);

  assert.equal(dynamic.pointOfInitiation, "12");
  assert.equal(dynamic.amount, 125137);
  assert.equal(verifyQrisPayload(dynamicPayload), true);
  assert.equal(dynamic.fields.at(-1).tag, "63");
  assert.equal(dynamic.fields.filter(field => field.tag === "54").length, 1);

  for (const original of source.fields) {
    if (original.tag === "63") continue;
    const converted = dynamic.fields.find(field => field.tag === original.tag);
    assert.ok(converted, "field " + original.tag + " is retained");
    if (original.tag === "01") assert.equal(converted.value, "12");
    else if (original.tag === "54") assert.equal(converted.value, "125137");
    else assert.equal(converted.value, original.value);
  }
});

test("QRIS TLV parser and encoder reject non-ASCII payload data", () => {
  assert.throws(() => parseEmvTlv("0003A😊"), /CHARSET/);
  assert.throws(() => encodeEmvTlv([{ tag: "59", value: "SEITON–ID" }]), /CHARSET/);
});

test("QRIS parser rejects malformed or zero amount fields", () => {
  const base = [
    { tag: "00", value: "01" },
    { tag: "01", value: "12" },
    { tag: "26", value: "0012A0000000000000000000" },
    { tag: "52", value: "5812" },
    { tag: "53", value: "360" },
    { tag: "54", value: "12X" },
    { tag: "58", value: "ID" },
    { tag: "59", value: "SEITON.ID" },
    { tag: "60", value: "JEMBER" }
  ];
  assert.throws(() => parseQrisPayload(withCrc(base)), /AMOUNT_FIELD_INVALID/);
  base[5] = { tag: "54", value: "0" };
  assert.throws(() => parseQrisPayload(withCrc(base)), /AMOUNT_FIELD_INVALID/);
});

test("QRIS converter accepts decimal integer strings and rejects alternate numeric notation", () => {
  const template = staticMerchantTemplate();
  assert.equal(parseQrisPayload(buildDynamicQrisPayload(template, "125000")).amount, 125000);
  assert.throws(() => buildDynamicQrisPayload(template, "1.25e5"), /AMOUNT_INVALID/);
  assert.throws(() => buildDynamicQrisPayload(template, "125000.00"), /AMOUNT_INVALID/);
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

test("QRIS unique suffix stays inside the available transaction-limit budget", () => {
  for (const max of [1, 7, 250, 999]) {
    for (let index = 0; index < 40; index++) {
      const code = generateQrisUniqueCode(max);
      assert.match(code, /^[0-9]{3}$/);
      assert.ok(Number(code) >= 1 && Number(code) <= max);
    }
  }
  assert.throws(() => generateQrisUniqueCode(0), /RANGE_INVALID/);
  assert.throws(() => generateQrisUniqueCode(1000), /RANGE_INVALID/);
});

test("dynamic QRIS payload enforces the Bank Indonesia per-transaction ceiling", () => {
  const template = staticMerchantTemplate();
  assert.equal(MAX_QRIS_TRANSACTION_AMOUNT, 10_000_000);
  assert.equal(parseQrisPayload(buildDynamicQrisPayload(template, 10_000_000)).amount, 10_000_000);
  assert.throws(
    () => buildDynamicQrisPayload(template, MAX_QRIS_TRANSACTION_AMOUNT + 1),
    /AMOUNT_INVALID/
  );
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


test("static merchant QR is used as a manual-amount fallback while dynamic remains opt-in", () => {
  const env = {
    QRIS_STATIC_PAYLOAD: staticMerchantTemplate(),
    QRIS_STATIC_FALLBACK_ENABLED: "true",
    QRIS_INTERNAL_ENABLED: "false"
  };
  assert.equal(isInternalQrisConfigured(env), false);
  assert.equal(isStaticQrisFallbackConfigured(env), true);
  assert.equal(getQrisCheckoutMode(env), "STATIC_FALLBACK");
  assert.equal(getQrisCheckoutMode({ ...env, QRIS_STATIC_FALLBACK_ENABLED: "false" }), "DISABLED");
  assert.equal(getQrisCheckoutMode({ ...env, QRIS_INTERNAL_ENABLED: "true" }), "DYNAMIC");
});
