import { verifyTotp } from "./totp.mjs";

const PANEL_ORIGIN = "https://mail.seiton.biz.id";
const PANEL_HOST = "mail.seiton.biz.id";
const MAIL_DOMAIN = "seiton.my.id";
const LEGACY_MAIL_DOMAIN = "inbox.seiton.biz.id";
const BASE_LOCAL_PART = "receiver";
const MAX_RAW_BYTES = 1024 * 1024;
const MAX_BODY_CHARS = 18000;
const MAX_MESSAGES_PER_ALIAS = 100;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOTP_ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const TOTP_RECOVERY_CODE_COUNT = 10;
const PUBLIC_TEMP_TTL_SECONDS = 600;
const PUBLIC_CUSTOM_TTL_SECONDS = 365 * 24 * 60 * 60;
const PUBLIC_SESSION_TTL_SECONDS = 12 * 60 * 60;
const PUBLIC_CREATE_LIMIT = 10;
const PUBLIC_CREATE_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_LOGIN_MAX_ATTEMPTS = 5;
const PUBLIC_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAILBOX_TTL_OPTIONS_SECONDS = Object.freeze([
  600, 3600, 21600, 43200, 86400, 259200, 604800, 1209600, 2592000
]);
const ALLOWED_TTLS = new Set(MAILBOX_TTL_OPTIONS_SECONDS);
const DEFAULT_MAILBOX_TTL_SECONDS = 600;
const EXPIRED_MAILBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isAllowedMailboxTtl(value) {
  const ttlSeconds = Number(value);
  return Number.isSafeInteger(ttlSeconds) && ALLOWED_TTLS.has(ttlSeconds);
}

function isMailboxActive(mailbox, now = Date.now()) {
  return Boolean(
    mailbox &&
    mailbox.status === "ACTIVE" &&
    Number.isFinite(Number(mailbox.expires_at)) &&
    Number(mailbox.expires_at) > now
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function responseJson(data, status = 200, headers = {}) {
  const outputHeaders = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow"
  });
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) outputHeaders.append(name, String(item));
    } else if (value !== undefined && value !== null) {
      outputHeaders.set(name, String(value));
    }
  }
  return new Response(JSON.stringify(data), { status, headers: outputHeaders });
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": "no-store",
    ...extra
  };
}

function clean(value, max = 500) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function randomHex(length = 24) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes).slice(0, length);
}

function isCustomLocalPart(value) {
  return /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(value) &&
    !value.includes("..") && !value.includes("__") && !value.includes("--") &&
    !value.includes("._") && !value.includes("_.") && !value.includes(".-") &&
    !value.includes("-.") && !value.includes("._-") && !value.includes("-_.");
}

function mailboxAddress(slug) {
  const value = clean(slug, 64).toLowerCase();
  if (/^[a-f0-9]{24}$/.test(value)) return BASE_LOCAL_PART + "+" + value + "@" + MAIL_DOMAIN;
  if (/^[a-f0-9]{32}$/.test(value) || isCustomLocalPart(value)) return value + "@" + MAIL_DOMAIN;
  throw new Error("MAILBOX_SLUG_INVALID");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

function constantTimeEqual(leftValue, rightValue) {
  const left = encoder.encode(String(leftValue ?? ""));
  const right = encoder.encode(String(rightValue ?? ""));
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] || 0) ^ (right[index] || 0);
  }
  return mismatch === 0;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function messageEncryptionKey(env) {
  if (!env.MAIL_MESSAGE_ENCRYPTION_KEY) {
    throw new Error("MAIL_MESSAGE_ENCRYPTION_KEY_MISSING");
  }
  const raw = base64ToBytes(env.MAIL_MESSAGE_ENCRYPTION_KEY);
  if (raw.length !== 32) {
    throw new Error("MAIL_MESSAGE_ENCRYPTION_KEY_INVALID");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptMessagePayload(env, aliasId, payload) {
  const key = await messageEncryptionKey(env);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const additionalData = encoder.encode("seiton-mail-message:" + String(aliasId));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    plaintext
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

async function decryptMessagePayload(env, aliasId, ivValue, ciphertextValue) {
  const key = await messageEncryptionKey(env);
  const iv = base64ToBytes(ivValue);
  if (iv.length !== 12) throw new Error("MAIL_MESSAGE_IV_INVALID");
  const additionalData = encoder.encode("seiton-mail-message:" + String(aliasId));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    base64ToBytes(ciphertextValue)
  );
  try {
    const payload = JSON.parse(decoder.decode(plaintext));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("MAIL_MESSAGE_PAYLOAD_INVALID");
    }
    return payload;
  } catch {
    throw new Error("MAIL_MESSAGE_PAYLOAD_INVALID");
  }
}

async function passwordHash(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: saltBytes,
    iterations: 100000,
    hash: "SHA-256"
  }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

function parseAliasRecipient(value) {
  const normalized = clean(value, 320).toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return null;

  const recipientDomain = normalized.slice(at + 1);
  const localPart = normalized.slice(0, at);
  const legacyMatch = localPart.match(/^receiver\+([a-f0-9]{24})$/);

  if (legacyMatch) {
    if (recipientDomain !== MAIL_DOMAIN && recipientDomain !== LEGACY_MAIL_DOMAIN) return null;
    return {
      slug: legacyMatch[1],
      address: normalized,
      format: "legacy-alias"
    };
  }

  // Prefixless random and custom TMail addresses are accepted only on the
  // primary domain with a local part issued by the public mailbox service.
  if (recipientDomain !== MAIL_DOMAIN) return null;
  if (/^[a-f0-9]{32}$/.test(localPart)) {
    return { slug: localPart, address: normalized, format: "tmail" };
  }
  if (isCustomLocalPart(localPart)) {
    return { slug: localPart, address: normalized, format: "custom-tmail" };
  }
  return null;
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const item of cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return "";
}

function sessionCookie(token) {
  return "__Host-mail_session=" + token +
    "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + SESSION_TTL_SECONDS;
}

function clearedSessionCookie() {
  return "__Host-mail_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

function loginChallengeCookie(token) {
  return "__Host-mail_login_challenge=" + token +
    "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300";
}

function clearedLoginChallengeCookie() {
  return "__Host-mail_login_challenge=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

function isSameOrigin(request) {
  return request.headers.get("Origin") === PANEL_ORIGIN;
}

async function readJson(request, maxBytes = 8192) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("INVALID_JSON");
  }
}


async function totpEncryptionKey(env) {
  if (!env.MAIL_SESSION_SECRET || String(env.MAIL_SESSION_SECRET).length < 32) {
    throw new Error("MAIL_SESSION_SECRET_INVALID");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(env.MAIL_SESSION_SECRET)),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode("seiton-tmail-owner-totp-v1"),
    info: encoder.encode("owner-authenticator-secret")
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptTotpSecret(env, secret) {
  const key = await totpEncryptionKey(env);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encoder.encode(String(secret))
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function decryptTotpSecret(env, ivValue, ciphertextValue) {
  const key = await totpEncryptionKey(env);
  const iv = base64ToBytes(ivValue);
  if (iv.length !== 12) throw new Error("TOTP_SECRET_IV_INVALID");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    base64ToBytes(ciphertextValue)
  );
  return decoder.decode(plaintext);
}

async function recoveryCodeHash(env, code) {
  return sha256Hex(String(env.MAIL_SESSION_SECRET) + ":seiton-tmail-recovery:" + String(code).toLowerCase());
}

async function consumeRecoveryCode(env, code) {
  const normalized = String(code ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(normalized)) return false;
  const hash = await recoveryCodeHash(env, normalized);
  const row = await env.MAIL_DB.prepare(
    "DELETE FROM mail_2fa_recovery_codes WHERE code_hash=? RETURNING code_hash"
  ).bind(hash).first();
  return Boolean(row);
}

async function verifyOwnerTotp(env, owner, code) {
  if (!owner?.totp_secret_iv || !owner?.totp_secret_ciphertext) return null;
  const secret = await decryptTotpSecret(env, owner.totp_secret_iv, owner.totp_secret_ciphertext);
  const step = await verifyTotp(secret, code, {
    now: Date.now(),
    lastAcceptedStep: Number(owner.totp_last_step ?? -1),
    window: 1
  });
  if (step === null) return null;
  const accepted = await env.MAIL_DB.prepare(
    "UPDATE mail_admin SET totp_last_step=? WHERE id='owner' AND totp_enabled=1 AND totp_last_step<? RETURNING id"
  ).bind(step, step).first();
  return accepted ? step : null;
}



const MACHINE_API_RATE_WINDOW_MS = 60 * 1000;
const MACHINE_API_RATE_LIMIT = 120;
const MACHINE_ALIAS_HOURLY_LIMIT = 20;

export {
  PANEL_ORIGIN,
  PANEL_HOST,
  MAIL_DOMAIN,
  LEGACY_MAIL_DOMAIN,
  BASE_LOCAL_PART,
  MAX_RAW_BYTES,
  MAX_BODY_CHARS,
  MAX_MESSAGES_PER_ALIAS,
  SESSION_TTL_SECONDS,
  LOGIN_WINDOW_MS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_CHALLENGE_TTL_MS,
  TOTP_ENROLLMENT_TTL_MS,
  TOTP_RECOVERY_CODE_COUNT,
  PUBLIC_TEMP_TTL_SECONDS,
  PUBLIC_CUSTOM_TTL_SECONDS,
  PUBLIC_SESSION_TTL_SECONDS,
  PUBLIC_CREATE_LIMIT,
  PUBLIC_CREATE_WINDOW_MS,
  PUBLIC_LOGIN_MAX_ATTEMPTS,
  PUBLIC_LOGIN_WINDOW_MS,
  MAILBOX_TTL_OPTIONS_SECONDS,
  DEFAULT_MAILBOX_TTL_SECONDS,
  EXPIRED_MAILBOX_RETENTION_MS,
  MACHINE_API_RATE_WINDOW_MS,
  MACHINE_API_RATE_LIMIT,
  MACHINE_ALIAS_HOURLY_LIMIT,
  isAllowedMailboxTtl,
  isMailboxActive,
  responseJson,
  securityHeaders,
  clean,
  bytesToHex,
  randomHex,
  isCustomLocalPart,
  mailboxAddress,
  sha256Hex,
  constantTimeEqual,
  bytesToBase64,
  base64ToBytes,
  messageEncryptionKey,
  encryptMessagePayload,
  decryptMessagePayload,
  passwordHash,
  parseAliasRecipient,
  getCookie,
  sessionCookie,
  clearedSessionCookie,
  loginChallengeCookie,
  clearedLoginChallengeCookie,
  isSameOrigin,
  readJson,
  encryptTotpSecret,
  decryptTotpSecret,
  recoveryCodeHash,
  consumeRecoveryCode,
  verifyOwnerTotp
};
