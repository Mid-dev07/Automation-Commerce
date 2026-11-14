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
