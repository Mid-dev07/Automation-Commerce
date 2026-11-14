import test from "node:test";
import assert from "node:assert/strict";
import { decryptMessagePayload, encryptMessagePayload, extractVerificationCode, parseAliasRecipient, randomHex } from "./worker.js";
import { parseEmail } from "./email-parser.js";

test("plus-address recipient maps only generated receiver aliases", () => {
  const slug = "a1b2c3d4e5f60718293a4b5c";
  assert.deepEqual(parseAliasRecipient("receiver+" + slug + "@inbox.seiton.biz.id"), {
    slug,
    address: "receiver+" + slug + "@inbox.seiton.biz.id"
  });
  assert.equal(parseAliasRecipient("receiver@inbox.seiton.biz.id"), null);
  assert.equal(parseAliasRecipient("unknown+" + slug + "@inbox.seiton.biz.id"), null);
  assert.equal(parseAliasRecipient("receiver+" + slug + "@seiton.biz.id"), null);
  assert.equal(parseAliasRecipient("receiver+short@inbox.seiton.biz.id"), null);
});

test("verification code extraction detects common Indonesian and English OTP wording", () => {
  assert.equal(extractVerificationCode("Your verification code", "Use this code: 849201 to continue."), "849201");
  assert.equal(extractVerificationCode("Kode Verifikasi", "Kode anda adalah 712345. Jangan bagikan kode ini."), "712345");
  assert.equal(extractVerificationCode("Security code", "Your security code is 8J2K9L."), "8J2K9L");
});

test("verification code extraction ignores unrelated numeric identifiers", () => {
  assert.equal(extractVerificationCode("Invoice", "Nomor pesanan 849201"), "");
  assert.equal(extractVerificationCode("Order confirmation", "Total pembayaran Rp 123456"), "");
});

test("alias slug generation is hexadecimal and unique-sized", () => {
  const slug = randomHex(24);
  assert.match(slug, /^[a-f0-9]{24}$/);
});

test("MIME parser extracts text and message metadata", () => {
  const parsed = parseEmail(
    "From: Verify Service <no-reply@example.net>\r\n" +
    "Subject: =?UTF-8?Q?Kode_Verifikasi?=\r\n" +
    "Message-ID: <mail-123@example.net>\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "\r\nKode verifikasi Anda adalah 849201."
  );
  assert.match(parsed.from, /no-reply@example.net/);
  assert.equal(parsed.subject, "Kode Verifikasi");
  assert.equal(parsed.messageId, "<mail-123@example.net>");
  assert.match(parsed.text, /849201/);
});


test("email payload encryption is authenticated and bound to its alias", async () => {
  const env = { MAIL_MESSAGE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
  const aliasId = "8f8f3b5a-1b19-4cb8-80d1-ae76e9a75021";
  const payload = {
    sender: "no-reply@example.net",
    recipient: "receiver+secret@inbox.seiton.biz.id",
    subject: "Kode Verifikasi",
    body_text: "Kode verifikasi Anda 849201",
    verification_code: "849201"
  };
  const encrypted = await encryptMessagePayload(env, aliasId, payload);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.ciphertext);
  assert.notEqual(encrypted.ciphertext, Buffer.from(JSON.stringify(payload)).toString("base64"));
  assert.deepEqual(
    await decryptMessagePayload(env, aliasId, encrypted.iv, encrypted.ciphertext),
    payload
  );
  await assert.rejects(
    () => decryptMessagePayload(env, "1f8f3b5a-1b19-4cb8-80d1-ae76e9a75021", encrypted.iv, encrypted.ciphertext)
  );
});
