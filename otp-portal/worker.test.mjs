import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMailbox, constantTimeEqual, extractOtpCode, parseMimeMessage } from "./worker.js";

test("mailbox address normalization and validation",()=>{
  assert.equal(normalizeMailbox("Test.QA99@Seiton.biz.id"),"test.qa99@seiton.biz.id");
  assert.throws(()=>normalizeMailbox("not-an-email"),/MAILBOX_INVALID/);
});

test("constant-time comparator requires equal values and length",()=>{
  assert.equal(constantTimeEqual("abc","abc"),true);
  assert.equal(constantTimeEqual("abc","abd"),false);
  assert.equal(constantTimeEqual("abc","abcd"),false);
});

test("OTP extraction uses verification language context",()=>{
  assert.equal(extractOtpCode("Kode Verifikasi","Gunakan kode 849201 untuk verifikasi."),"849201");
  assert.equal(extractOtpCode("Invoice","Nomor pesanan 849201"),"");
});

test("plain text MIME message is parsed",()=>{
  const message=parseMimeMessage("From: no-reply@example.com\r\nSubject: Kode Verifikasi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nKode Anda 849201");
  assert.equal(message.headers.subject,"Kode Verifikasi");
  assert.match(message.body,/849201/);
});
