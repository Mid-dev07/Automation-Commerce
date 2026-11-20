import test from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCode,
  verifyTotp
} from "../mail-automation/totp.mjs";

test("Base32 encode/decode round-trips bytes", () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 250, 255]);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
});

test("generates a cryptographically random 160-bit Base32 secret", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
});

test("matches the RFC 6238 SHA-1 test vector in six-digit mode", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(await totpCode(secret, 59_000), "287082");
});

test("accepts a code in the configured clock window and rejects replay", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const now = 1_700_000_000_000;
  const code = await totpCode(secret, now);
  const step = await verifyTotp(secret, code, { now });
  assert.equal(step, Math.floor(now / 30_000));
  assert.equal(await verifyTotp(secret, code, { now, lastAcceptedStep: step }), null);
});

test("rejects malformed and incorrect codes", async () => {
  const secret = generateTotpSecret();
  assert.equal(await verifyTotp(secret, "12345"), null);
  assert.equal(await verifyTotp(secret, "abcdef"), null);
  assert.equal(await verifyTotp(secret, "000000", { now: 0 }), null);
});
