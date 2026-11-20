const ENCODER = new TextEncoder();

function constantTimeEqual(leftValue, rightValue) {
  const left = ENCODER.encode(String(leftValue ?? ""));
  const right = ENCODER.encode(String(rightValue ?? ""));
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] || 0) ^ (right[index] || 0);
  }
  return mismatch === 0;
}

export function base32Encode(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const value = String(input ?? "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  if (!value || !/^[A-Z2-7]+$/.test(value)) throw new TypeError("Invalid Base32 secret.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const output = [];
  for (const char of value) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) {
    throw new TypeError("Invalid Base32 padding bits.");
  }
  return Uint8Array.from(output);
}

export function generateTotpSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export async function totpCode(secret, unixTimeMs = Date.now()) {
  const keyBytes = base32Decode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const counter = BigInt(Math.floor(Number(unixTimeMs) / 30000));
  const message = new Uint8Array(8);
  let value = counter;
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(value & 255n);
    value >>= 8n;
  }
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Returns the matched time-step, or null. The last accepted step is excluded
 * to prevent replaying the same code in another login or setup request.
 */
export async function verifyTotp(
  secret,
  suppliedCode,
  { now = Date.now(), lastAcceptedStep = -1, window = 1 } = {}
) {
  const code = String(suppliedCode ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const currentStep = Math.floor(Number(now) / 30000);
  for (let delta = -window; delta <= window; delta += 1) {
    const step = currentStep + delta;
    if (step <= Number(lastAcceptedStep)) continue;
    const expected = await totpCode(secret, step * 30000);
    if (constantTimeEqual(expected, code)) return step;
  }
  return null;
}
