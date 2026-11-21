import test from "node:test";
import assert from "node:assert/strict";
import { extractVerificationCode, extractVerificationCodeDetails } from "../mail-automation/otp-extractor.js";
import { parseEmail } from "../mail-automation/email-parser.js";

test("detects Meta confirmation-code wording and code on a following line", () => {
  const body = [
    "Please confirm your email for your new Meta account by entering the following confirmation code.",
    "Confirmation code",
    "482913"
  ].join("\n");
  assert.equal(extractVerificationCode("", body), "482913");
});

test("detects a Google G-prefixed verification code", () => {
  assert.equal(extractVerificationCode("", "G-582104 is your Google verification code."), "582104");
});

test("detects six-digit codes separated by a hyphen", () => {
  assert.equal(extractVerificationCode("", "Your WhatsApp code is 582-104. Do not share this code."), "582104");
});

test("detects application-specific alphanumeric verification codes", () => {
  assert.equal(extractVerificationCode("", "Use this Discord verification code: A7B9C2"), "A7B9C2");
});

test("detects Indonesian verification and login language", () => {
  assert.equal(extractVerificationCode("", "Masukkan kode verifikasi berikut: 731905"), "731905");
  assert.equal(extractVerificationCode("", ["Kode login Anda", "194827", "Jangan bagikan kode ini kepada siapa pun."].join("\n")), "194827");
});

test("detects common Spanish and French verification-code labels", () => {
  assert.equal(extractVerificationCode("", "Tu código de verificación es: 615204"), "615204");
  assert.equal(extractVerificationCode("", "Votre code de vérification : 850261"), "850261");
});

test("normalizes full-width digits and invisible formatting characters", () => {
  assert.equal(extractVerificationCode("", "Your verification code is: ５８２​１０４"), "582104");
});

test("does not mistake order numbers or phone numbers for OTPs", () => {
  assert.equal(extractVerificationCode("", "Order number: 582104"), "");
  assert.equal(extractVerificationCode("", "Phone number: +62 812 3456 7890"), "");
  assert.equal(extractVerificationCode("", "Your order 582104 is being prepared."), "");
});

test("does not choose between two equally supported verification codes", () => {
  const result = extractVerificationCodeDetails(
    "",
    ["Previous verification code: 111222.", "New verification code: 333444."].join("\n")
  );
  assert.equal(result.code, "");
  assert.equal(result.status, "ambiguous");
});

test("prefers the verification code over a nearby order reference", () => {
  assert.equal(
    extractVerificationCode("", "Order number: 734921. Your security verification code is 582104."),
    "582104"
  );
});

test("searches both MIME alternatives when the OTP appears only in the HTML part", () => {
  const raw = [
    "From: no-reply@example.test",
    "Subject: Account confirmation",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="mail-boundary"',
    "",
    "--mail-boundary",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    "A plain text notification without the verification value.",
    "--mail-boundary",
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<html><body><p>Enter your confirmation code:</p><strong>826410</strong></body></html>",
    "--mail-boundary--",
    ""
  ].join("\n");
  const parsed = parseEmail(raw);
  assert.match(parsed.text, /plain text notification/i);
  assert.match(parsed.searchText, /826410/);
  assert.equal(extractVerificationCode(parsed.subject, parsed.searchText), "826410");
});

test("decodes hexadecimal HTML entities before OTP detection", () => {
  const raw = [
    "From: no-reply@example.test",
    "Subject: Security code",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Your security code is <b>&#x35;&#x38;&#x32;&#x31;&#x30;&#x34;</b></p>"
  ].join("\r\n");
  const parsed = parseEmail(raw);
  assert.equal(extractVerificationCode(parsed.subject, parsed.searchText), "582104");
});

test("otp-portal and mail-automation email-parser modules stay synchronized", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseEmail: parseOtpPortalEmail } = await import("../otp-portal/email-parser.js");
  const mailSource = readFileSync(new URL("../mail-automation/email-parser.js", import.meta.url), "utf8").replace(/\r\n/g, "\n").trim();
  const otpSource = readFileSync(new URL("../otp-portal/email-parser.js", import.meta.url), "utf8").replace(/\r\n/g, "\n").trim();
  assert.equal(otpSource, mailSource);

  const sample = [
    "From: no-reply@example.test",
    "Subject: Security code",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Code: <b>&#x35;&#x38;&#x32;\u200B&#x31;&#x30;&#x34;</b></p>"
  ].join("\r\n");
  assert.deepEqual(parseOtpPortalEmail(sample), parseEmail(sample));
});
