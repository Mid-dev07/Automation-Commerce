import test from "node:test";
import assert from "node:assert/strict";
import worker, { normalizeAddress, sha256, sanitizeText, extractOtpCodes } from "./index.js";
import { parseEmail } from "./email-parser.js";

test("mailbox address normalization enforces allowed domains", () => {
  assert.equal(normalizeAddress("Test.QA99@Seiton.biz.id"), "test.qa99@seiton.biz.id");
  assert.throws(() => normalizeAddress("not-an-email"), /tidak valid/i);
  assert.throws(() => normalizeAddress("user@unauthorized.example"), /belum terverifikasi/i);
});

test("sha256 produces stable lowercase hex digest", async () => {
  const hash = await sha256("test@seiton.biz.id");
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await sha256("test@seiton.biz.id"), hash);
});

test("sanitizeText strips control chars and normalizes whitespace", () => {
  assert.equal(sanitizeText("Kode:\u0000  849201\r\n  OK"), "Kode: 849201\n OK");
});

test("extractOtpCodes returns unique 4-8 digit candidates", () => {
  assert.deepEqual(extractOtpCodes("Gunakan kode 849201 atau ulangi 849201 (pin 4321)."), ["849201", "4321"]);
  assert.deepEqual(extractOtpCodes("Tidak ada kode numerik."), []);
});

test("plain text MIME message is parsed by deployed email-parser", () => {
  const message = parseEmail("From: no-reply@example.com\r\nSubject: Kode Verifikasi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nKode Anda 849201");
  assert.equal(message.subject, "Kode Verifikasi");
  assert.equal(message.from, "no-reply@example.com");
  assert.match(message.text, /849201/);
});

test("deployed OTP portal entrypoint responds ready on GET /health", async () => {
  const res = await worker.fetch(new Request("https://otp.seiton.biz.id/health"), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "seiton-otp-portal");
  assert.equal(body.status, "ready");
});
