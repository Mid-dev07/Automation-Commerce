import { parseEmail } from "./email-parser.js";
import { extractVerificationCode } from "./otp-extractor.js";
import { generateTotpSecret, verifyTotp } from "./totp.mjs";
import { renderPublicPage } from "./public-page.mjs";

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


function publicSessionCookieName(aliasId) {
  return "__Host-tmail_" + String(aliasId).replace(/[^a-f0-9-]/gi, "");
}

function publicSessionCookie(aliasId, token, maxAge) {
  return publicSessionCookieName(aliasId) + "=" + token +
    "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + Math.max(1, Number(maxAge) || 1);
}

function clearedPublicSessionCookie(aliasId) {
  return publicSessionCookieName(aliasId) + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

async function createPublicSession(env, aliasId, expiresAt) {
  const token = randomHex(64);
  const hash = await sha256Hex(token);
  const now = Date.now();
  const maxAge = Math.max(1, Math.floor(Math.min(
    PUBLIC_SESSION_TTL_SECONDS * 1000,
    Number(expiresAt) - now
  ) / 1000));
  await env.MAIL_DB.prepare(
    "INSERT INTO mail_public_sessions(session_hash,alias_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)"
  ).bind(hash, aliasId, now, now + maxAge * 1000, now).run();
  return { cookie: publicSessionCookie(aliasId, token, maxAge), tokenHash: hash };
}

async function publicIpHash(request, env) {
  return loginIpHash(request, env);
}

async function checkPublicCreationLimit(request, env, now) {
  const ipHash = await publicIpHash(request, env);
  const row = await env.MAIL_DB.prepare(
    "INSERT INTO mail_public_creation_limits(ip_hash,window_started_at,request_count) VALUES(?,?,1) " +
    "ON CONFLICT(ip_hash) DO UPDATE SET " +
    "request_count=CASE WHEN mail_public_creation_limits.window_started_at<=? THEN 1 ELSE mail_public_creation_limits.request_count+1 END," +
    "window_started_at=CASE WHEN mail_public_creation_limits.window_started_at<=? THEN excluded.window_started_at ELSE mail_public_creation_limits.window_started_at END " +
    "RETURNING request_count,window_started_at"
  ).bind(ipHash, now, now - PUBLIC_CREATE_WINDOW_MS, now - PUBLIC_CREATE_WINDOW_MS).first();
  if (!row || Number(row.request_count) > PUBLIC_CREATE_LIMIT) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((Number(row?.window_started_at || now) + PUBLIC_CREATE_WINDOW_MS - now) / 1000)) };
  }
  return { allowed: true, ipHash };
}

async function handlePublicMailboxCreate(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  if (!await hasOwner(env)) return responseJson({ ok: false, error: "Layanan belum diinisialisasi." }, 503);
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data pembuatan mailbox tidak valid." }, 400); }

  const mode = body.mode === "custom" ? "custom" : body.mode === "generate" || !body.mode ? "generate" : "";
  if (!mode) return responseJson({ ok: false, error: "Mode mailbox tidak valid." }, 400);
  const now = Date.now();
  const limit = await checkPublicCreationLimit(request, env, now);
  if (!limit.allowed) {
    return responseJson({ ok: false, error: "Batas pembuatan mailbox tercapai. Coba kembali setelah jendela 1 jam berakhir." }, 429, {
      "Retry-After": String(limit.retryAfter)
    });
  }

  let slug;
  let password;
  let ttlSeconds;
  if (mode === "custom") {
    slug = typeof body.localPart === "string" ? body.localPart.trim().toLowerCase() : "";
    password = typeof body.password === "string" ? body.password : "";
    const reserved = new Set(["api", "owner", "login", "inbox", "health", "robots", "www", "mail", "admin", "support", "receiver"]);
    if (!isCustomLocalPart(slug) || reserved.has(slug)) {
      return responseJson({ ok: false, error: "Nama alamat tidak valid atau termasuk nama yang dicadangkan." }, 400);
    }
    if (password.length < 12 || password.length > 128) {
      return responseJson({ ok: false, error: "Password inbox harus 12–128 karakter." }, 400);
    }
    ttlSeconds = PUBLIC_CUSTOM_TTL_SECONDS;
  } else {
    slug = randomHex(32);
    password = randomHex(32);
    ttlSeconds = PUBLIC_TEMP_TTL_SECONDS;
  }

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await passwordHash(password, salt);
  const aliasId = crypto.randomUUID();
  const expiresAt = now + ttlSeconds * 1000;
  const label = mode === "custom" ? "Public custom mailbox" : "Public temporary mailbox";
  try {
    await env.MAIL_DB.batch([
      env.MAIL_DB.prepare(
        "INSERT INTO mail_aliases(id,slug,label,status,created_at,expires_at,received_count) VALUES(?,?,?,'ACTIVE',?,?,0)"
      ).bind(aliasId, slug, label, now, expiresAt),
      env.MAIL_DB.prepare(
        "INSERT INTO mail_public_mailboxes(alias_id,password_salt,password_hash,created_at) VALUES(?,?,?,?)"
      ).bind(aliasId, bytesToBase64(salt), hash, now)
    ]);
  } catch (error) {
    if (mode === "custom") return responseJson({ ok: false, error: "Nama email sudah digunakan. Pilih nama lain." }, 409);
    throw error;
  }

  const session = await createPublicSession(env, aliasId, expiresAt);
  return responseJson({
    ok: true,
    mailbox: {
      id: aliasId,
      slug,
      email: mailboxAddress(slug),
      status: "ACTIVE",
      mode,
      created_at: now,
      expires_at: expiresAt
    },
    generated_password: mode === "generate" ? password : null,
    password_required: true
  }, 201, { "Set-Cookie": session.cookie });
}

async function checkPublicLoginAttempts(env, ipHash, aliasId, now) {
  const row = await env.MAIL_DB.prepare(
    "SELECT attempts,window_started_at,blocked_until FROM mail_public_login_attempts WHERE ip_hash=? AND alias_id=? LIMIT 1"
  ).bind(ipHash, aliasId).first();
  if (!row) return { blocked: false };
  if (now - Number(row.window_started_at || 0) >= PUBLIC_LOGIN_WINDOW_MS) {
    await env.MAIL_DB.prepare(
      "DELETE FROM mail_public_login_attempts WHERE ip_hash=? AND alias_id=?"
    ).bind(ipHash, aliasId).run();
    return { blocked: false };
  }
  return {
    blocked: Number(row.blocked_until || 0) > now,
    retryAfter: Math.max(1, Math.ceil((Number(row.blocked_until || 0) - now) / 1000))
  };
}

async function recordPublicLoginFailure(env, ipHash, aliasId, now) {
  const row = await env.MAIL_DB.prepare(
    "SELECT attempts,window_started_at FROM mail_public_login_attempts WHERE ip_hash=? AND alias_id=? LIMIT 1"
  ).bind(ipHash, aliasId).first();
  let attempts = 1;
  let windowStarted = now;
  if (row && now - Number(row.window_started_at || 0) < PUBLIC_LOGIN_WINDOW_MS) {
    attempts = Number(row.attempts || 0) + 1;
    windowStarted = Number(row.window_started_at);
  }
  const blockedUntil = attempts >= PUBLIC_LOGIN_MAX_ATTEMPTS ? now + PUBLIC_LOGIN_WINDOW_MS : 0;
  await env.MAIL_DB.prepare(
    "INSERT INTO mail_public_login_attempts(ip_hash,alias_id,attempts,window_started_at,blocked_until) VALUES(?,?,?,?,?) " +
    "ON CONFLICT(ip_hash,alias_id) DO UPDATE SET attempts=excluded.attempts,window_started_at=excluded.window_started_at,blocked_until=excluded.blocked_until"
  ).bind(ipHash, aliasId, attempts, windowStarted, blockedUntil).run();
}

async function handlePublicMailboxUnlock(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data akses inbox tidak valid." }, 400); }
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(slug) &&
      !/^[a-f0-9]{32}$/.test(slug) && !/^[a-f0-9]{24}$/.test(slug)) {
    return responseJson({ ok: false, error: "Alamat mailbox tidak valid." }, 400);
  }
  const alias = await env.MAIL_DB.prepare(
    "SELECT a.id,a.slug,a.status,a.expires_at,p.password_salt,p.password_hash " +
    "FROM mail_aliases a JOIN mail_public_mailboxes p ON p.alias_id=a.id " +
    "WHERE a.slug=? AND a.status='ACTIVE' AND a.expires_at>? LIMIT 1"
  ).bind(slug, Date.now()).first();
  if (!alias) return responseJson({ ok: false, error: "Mailbox tidak ditemukan atau sudah kedaluwarsa." }, 404);

  const now = Date.now();
  const ipHash = await publicIpHash(request, env);
  const attempts = await checkPublicLoginAttempts(env, ipHash, alias.id, now);
  if (attempts.blocked) return responseJson({ ok: false, error: "Terlalu banyak percobaan. Coba kembali nanti." }, 429, {
    "Retry-After": String(attempts.retryAfter)
  });

  const computed = password.length <= 128
    ? await passwordHash(password, base64ToBytes(alias.password_salt))
    : "";
  if (!constantTimeEqual(computed, alias.password_hash)) {
    await recordPublicLoginFailure(env, ipHash, alias.id, now);
    return responseJson({ ok: false, error: "Password inbox tidak cocok." }, 401);
  }
  await env.MAIL_DB.prepare(
    "DELETE FROM mail_public_login_attempts WHERE ip_hash=? AND alias_id=?"
  ).bind(ipHash, alias.id).run();
  const session = await createPublicSession(env, alias.id, alias.expires_at);
  return responseJson({ ok: true, email: mailboxAddress(alias.slug) }, 200, { "Set-Cookie": session.cookie });
}

async function requirePublicInboxSession(request, env, slug) {
  const aliasInfo = await env.MAIL_DB.prepare(
    "SELECT a.id,a.slug,a.status,a.expires_at FROM mail_aliases a " +
    "JOIN mail_public_mailboxes p ON p.alias_id=a.id " +
    "WHERE a.slug=? AND a.status='ACTIVE' AND a.expires_at>? LIMIT 1"
  ).bind(slug, Date.now()).first();
  if (!aliasInfo) return null;
  const token = getCookie(request, publicSessionCookieName(aliasInfo.id));
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const session = await env.MAIL_DB.prepare(
    "SELECT session_hash FROM mail_public_sessions " +
    "WHERE session_hash=? AND alias_id=? AND expires_at>? LIMIT 1"
  ).bind(hash, aliasInfo.id, Date.now()).first();
  if (!session) return null;
  await env.MAIL_DB.prepare(
    "UPDATE mail_public_sessions SET last_seen_at=? WHERE session_hash=?"
  ).bind(Date.now(), hash).run();
  return aliasInfo;
}

async function handlePublicInboxGet(request, url, env) {
  const slug = String(url.searchParams.get("slug") || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(slug) && !isCustomLocalPart(slug)) {
    return responseJson({ ok: false, error: "Mailbox tidak valid." }, 400);
  }
  const alias = await requirePublicInboxSession(request, env, slug);
  if (!alias) return responseJson({ ok: false, error: "Inbox terkunci atau sesi sudah berakhir." }, 401);

  const result = await env.MAIL_DB.prepare(
    "SELECT id,received_at,payload_iv,payload_ciphertext FROM mail_messages WHERE alias_id=? ORDER BY received_at DESC LIMIT 50"
  ).bind(alias.id).all();
  const messages = await Promise.all((result.results || []).map(async row => {
    const payload = await decryptMessagePayload(env, alias.id, row.payload_iv, row.payload_ciphertext);
    return {
      id: row.id,
      sender: clean(payload.sender, 254),
      subject: clean(payload.subject, 300),
      body_text: clean(payload.body_text, MAX_BODY_CHARS),
      verification_code: payload.verification_code ? clean(payload.verification_code, 32) : null,
      received_at: Number(row.received_at)
    };
  }));
  return responseJson({
    ok: true,
    mailbox: { id: alias.id, slug: alias.slug, email: mailboxAddress(alias.slug), expires_at: Number(alias.expires_at) },
    messages
  });
}

async function handlePublicMailboxLogout(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  let body;
  try { body = await readJson(request); }
  catch { body = {}; }
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const alias = await env.MAIL_DB.prepare(
    "SELECT id FROM mail_aliases WHERE slug=? LIMIT 1"
  ).bind(slug).first();
  if (!alias) return responseJson({ ok: true });
  const token = getCookie(request, publicSessionCookieName(alias.id));
  if (/^[a-f0-9]{64}$/.test(token)) {
    const hash = await sha256Hex(token);
    await env.MAIL_DB.prepare("DELETE FROM mail_public_sessions WHERE session_hash=? AND alias_id=?").bind(hash, alias.id).run();
  }
  return responseJson({ ok: true }, 200, { "Set-Cookie": clearedPublicSessionCookie(alias.id) });
}

async function hasOwner(env) {
  const row = await env.MAIL_DB.prepare(
    "SELECT id FROM mail_admin WHERE id='owner' LIMIT 1"
  ).first();
  return Boolean(row);
}

async function createSession(env) {
  const token = randomHex(64);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  await env.MAIL_DB.prepare(
    "INSERT INTO mail_sessions(session_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?)"
  ).bind(tokenHash, now, expiresAt, now).run();
  return token;
}

async function currentSession(request, env) {
  const token = getCookie(request, "__Host-mail_session");
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const now = Date.now();
  const session = await env.MAIL_DB.prepare(
    "SELECT session_hash,expires_at FROM mail_sessions WHERE session_hash=? AND expires_at>? LIMIT 1"
  ).bind(hash, now).first();
  if (!session) return null;
  await env.MAIL_DB.prepare(
    "UPDATE mail_sessions SET last_seen_at=? WHERE session_hash=?"
  ).bind(now, hash).run();
  return { tokenHash: hash, expiresAt: Number(session.expires_at) };
}

async function requireSession(request, env) {
  const session = await currentSession(request, env);
  if (!session) return null;
  return session;
}

async function loginIpHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256Hex(String(env.MAIL_SESSION_SECRET || "") + ":" + ip);
}

async function checkLoginLockout(request, env, now) {
  const ipHash = await loginIpHash(request, env);
  const row = await env.MAIL_DB.prepare(
    "SELECT attempts,window_started_at,blocked_until FROM mail_login_attempts WHERE ip_hash=? LIMIT 1"
  ).bind(ipHash).first();
  if (!row) return { ipHash, blocked: false };
  const windowStarted = Number(row.window_started_at || 0);
  if (now - windowStarted >= LOGIN_WINDOW_MS) {
    await env.MAIL_DB.prepare("DELETE FROM mail_login_attempts WHERE ip_hash=?").bind(ipHash).run();
    return { ipHash, blocked: false };
  }
  return {
    ipHash,
    blocked: Number(row.blocked_until || 0) > now,
    retryAfter: Math.max(1, Math.ceil((Number(row.blocked_until || 0) - now) / 1000))
  };
}

async function recordLoginFailure(env, ipHash, now) {
  const row = await env.MAIL_DB.prepare(
    "SELECT attempts,window_started_at FROM mail_login_attempts WHERE ip_hash=? LIMIT 1"
  ).bind(ipHash).first();
  let attempts = 1;
  let windowStarted = now;
  if (row && now - Number(row.window_started_at || 0) < LOGIN_WINDOW_MS) {
    attempts = Number(row.attempts || 0) + 1;
    windowStarted = Number(row.window_started_at);
  }
  const blockedUntil = attempts >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_WINDOW_MS : 0;
  await env.MAIL_DB.prepare(
    "INSERT INTO mail_login_attempts(ip_hash,attempts,window_started_at,blocked_until) VALUES(?,?,?,?) " +
    "ON CONFLICT(ip_hash) DO UPDATE SET attempts=excluded.attempts,window_started_at=excluded.window_started_at,blocked_until=excluded.blocked_until"
  ).bind(ipHash, attempts, windowStarted, blockedUntil).run();
  return blockedUntil;
}

async function handleSetup(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  if (!env.MAIL_SETUP_TOKEN || !env.MAIL_SESSION_SECRET) {
    return responseJson({ ok: false, error: "Konfigurasi setup belum lengkap." }, 503);
  }
  if (await hasOwner(env)) return responseJson({ ok: false, error: "Panel sudah diinisialisasi." }, 409);
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data setup tidak valid." }, 400); }
  const bootstrapToken = typeof body.bootstrapToken === "string" ? body.bootstrapToken : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!constantTimeEqual(bootstrapToken, env.MAIL_SETUP_TOKEN)) {
    return responseJson({ ok: false, error: "Bootstrap token tidak valid." }, 401);
  }
  if (password.length < 16 || password.length > 128) {
    return responseJson({ ok: false, error: "Password harus 16–128 karakter." }, 400);
  }
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await passwordHash(password, salt);
  const now = Date.now();
  try {
    await env.MAIL_DB.prepare(
      "INSERT INTO mail_admin(id,password_salt,password_hash,created_at) VALUES('owner',?,?,?)"
    ).bind(bytesToBase64(salt), hash, now).run();
  } catch {
    return responseJson({ ok: false, error: "Setup sudah diselesaikan pada sesi lain." }, 409);
  }
  const token = await createSession(env);
  return responseJson(
    { ok: true, configured: true },
    200,
    { "Set-Cookie": sessionCookie(token) }
  );
}

async function handleLogin(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  if (!env.MAIL_SESSION_SECRET) return responseJson({ ok: false, error: "Panel belum dikonfigurasi." }, 503);
  const now = Date.now();
  const lock = await checkLoginLockout(request, env, now);
  if (lock.blocked) {
    return responseJson({ ok: false, error: "Login ditahan sementara. Coba beberapa saat lagi." }, 429, {
      "Retry-After": String(lock.retryAfter)
    });
  }
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data login tidak valid." }, 400); }
  const password = typeof body.password === "string" ? body.password : "";
  const owner = await env.MAIL_DB.prepare(
    "SELECT password_salt,password_hash,totp_enabled FROM mail_admin WHERE id='owner' LIMIT 1"
  ).first();
  if (!owner || password.length > 128) {
    await recordLoginFailure(env, lock.ipHash, now);
    return responseJson({ ok: false, error: "Password tidak valid." }, 401);
  }
  const computed = await passwordHash(password, base64ToBytes(owner.password_salt));
  if (!constantTimeEqual(computed, owner.password_hash)) {
    const blockedUntil = await recordLoginFailure(env, lock.ipHash, now);
    return responseJson({ ok: false, error: blockedUntil ? "Terlalu banyak percobaan login. Coba 15 menit lagi." : "Password tidak valid." }, blockedUntil ? 429 : 401);
  }

  if (Number(owner.totp_enabled) === 1) {
    const challengeToken = randomHex(64);
    const challengeHash = await sha256Hex(challengeToken);
    await env.MAIL_DB.prepare(
      "INSERT INTO mail_login_challenges(challenge_hash,ip_hash,created_at,expires_at,attempts) VALUES(?,?,?,?,0)"
    ).bind(challengeHash, lock.ipHash, now, now + LOGIN_CHALLENGE_TTL_MS).run();
    return responseJson(
      { ok: true, requiresTwoFactor: true },
      200,
      { "Set-Cookie": loginChallengeCookie(challengeToken) }
    );
  }

  await env.MAIL_DB.prepare("DELETE FROM mail_login_attempts WHERE ip_hash=?").bind(lock.ipHash).run();
  const token = await createSession(env);
  return responseJson({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function handleLoginTwoFactor(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  const challengeToken = getCookie(request, "__Host-mail_login_challenge");
  if (!/^[a-f0-9]{64}$/.test(challengeToken)) {
    return responseJson({ ok: false, error: "Sesi verifikasi 2FA tidak valid. Masuk kembali." }, 401, {
      "Set-Cookie": clearedLoginChallengeCookie()
    });
  }
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Kode verifikasi tidak valid." }, 400); }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const challengeHash = await sha256Hex(challengeToken);
  const challenge = await env.MAIL_DB.prepare(
    "SELECT challenge_hash,ip_hash,expires_at,attempts FROM mail_login_challenges WHERE challenge_hash=? LIMIT 1"
  ).bind(challengeHash).first();
  const ipHash = await loginIpHash(request, env);
  const now = Date.now();
  if (!challenge || Number(challenge.expires_at) <= now || !constantTimeEqual(challenge.ip_hash, ipHash)) {
    if (challenge) await env.MAIL_DB.prepare("DELETE FROM mail_login_challenges WHERE challenge_hash=?").bind(challengeHash).run();
    return responseJson({ ok: false, error: "Sesi verifikasi 2FA sudah berakhir. Masuk kembali." }, 401, {
      "Set-Cookie": clearedLoginChallengeCookie()
    });
  }
  if (Number(challenge.attempts) >= 5) {
    await env.MAIL_DB.prepare("DELETE FROM mail_login_challenges WHERE challenge_hash=?").bind(challengeHash).run();
    return responseJson({ ok: false, error: "Terlalu banyak percobaan kode 2FA. Masuk kembali." }, 429, {
      "Set-Cookie": clearedLoginChallengeCookie()
    });
  }

  const owner = await env.MAIL_DB.prepare(
    "SELECT totp_enabled,totp_secret_iv,totp_secret_ciphertext,totp_last_step FROM mail_admin WHERE id='owner' LIMIT 1"
  ).first();
  let valid = false;
  if (owner && Number(owner.totp_enabled) === 1) {
    valid = (await verifyOwnerTotp(env, owner, code)) !== null;
    if (!valid) valid = await consumeRecoveryCode(env, code);
  }
  if (!valid) {
    const attempts = Number(challenge.attempts) + 1;
    if (attempts >= 5) {
      await env.MAIL_DB.prepare("DELETE FROM mail_login_challenges WHERE challenge_hash=?").bind(challengeHash).run();
    } else {
      await env.MAIL_DB.prepare(
        "UPDATE mail_login_challenges SET attempts=? WHERE challenge_hash=?"
      ).bind(attempts, challengeHash).run();
    }
    return responseJson({ ok: false, error: attempts >= 5 ? "Kode salah lima kali. Silakan masuk kembali." : "Kode autentikator atau recovery code tidak valid." }, attempts >= 5 ? 429 : 401, {
      ...(attempts >= 5 ? { "Set-Cookie": clearedLoginChallengeCookie() } : {})
    });
  }

  await env.MAIL_DB.prepare("DELETE FROM mail_login_challenges WHERE challenge_hash=?").bind(challengeHash).run();
  await env.MAIL_DB.prepare("DELETE FROM mail_login_attempts WHERE ip_hash=?").bind(ipHash).run();
  const token = await createSession(env);
  return responseJson({ ok: true }, 200, {
    "Set-Cookie": [sessionCookie(token), clearedLoginChallengeCookie()]
  });
}

async function handleLogout(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  const session = await currentSession(request, env);
  if (session) {
    await env.MAIL_DB.prepare("DELETE FROM mail_sessions WHERE session_hash=?").bind(session.tokenHash).run();
  }
  return responseJson({ ok: true }, 200, { "Set-Cookie": [clearedSessionCookie(), clearedLoginChallengeCookie()] });
}


async function handleTwoFactorStatus(env) {
  const owner = await env.MAIL_DB.prepare(
    "SELECT totp_enabled,totp_pending_expires_at FROM mail_admin WHERE id='owner' LIMIT 1"
  ).first();
  const recovery = await env.MAIL_DB.prepare(
    "SELECT COUNT(*) AS total FROM mail_2fa_recovery_codes"
  ).first();
  return responseJson({
    ok: true,
    enabled: Number(owner?.totp_enabled) === 1,
    enrollment_pending: Number(owner?.totp_pending_expires_at || 0) > Date.now(),
    recovery_codes_remaining: Number(recovery?.total || 0)
  });
}

async function handleTwoFactorEnroll(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  const owner = await env.MAIL_DB.prepare(
    "SELECT totp_enabled FROM mail_admin WHERE id='owner' LIMIT 1"
  ).first();
  if (!owner) return responseJson({ ok: false, error: "Owner belum diinisialisasi." }, 503);
  if (Number(owner.totp_enabled) === 1) {
    return responseJson({ ok: false, error: "2FA sudah aktif. Nonaktifkan terlebih dahulu jika ingin mengganti perangkat." }, 409);
  }
  const secret = generateTotpSecret();
  const encrypted = await encryptTotpSecret(env, secret);
  const expiresAt = Date.now() + TOTP_ENROLLMENT_TTL_MS;
  await env.MAIL_DB.prepare(
    "UPDATE mail_admin SET totp_pending_iv=?,totp_pending_ciphertext=?,totp_pending_expires_at=?,totp_pending_attempts=0 WHERE id='owner'"
  ).bind(encrypted.iv, encrypted.ciphertext, expiresAt).run();
  const label = encodeURIComponent("owner@mail.seiton.biz.id");
  const issuer = encodeURIComponent("SeitonMail");
  const uri = "otpauth://totp/" + issuer + ":" + label + "?secret=" + secret +
    "&issuer=" + issuer + "&algorithm=SHA1&digits=6&period=30";
  return responseJson({ ok: true, secret, otpauth_uri: uri, expires_at: expiresAt });
}

async function handleTwoFactorConfirm(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Kode autentikator tidak valid." }, 400); }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const owner = await env.MAIL_DB.prepare(
    "SELECT totp_pending_iv,totp_pending_ciphertext,totp_pending_expires_at,totp_pending_attempts FROM mail_admin WHERE id='owner' LIMIT 1"
  ).first();
  if (!owner?.totp_pending_iv || !owner?.totp_pending_ciphertext || Number(owner.totp_pending_expires_at) <= Date.now()) {
    return responseJson({ ok: false, error: "Pendaftaran 2FA tidak ditemukan atau sudah kedaluwarsa. Mulai kembali." }, 410);
  }
  if (Number(owner.totp_pending_attempts || 0) >= 5) {
    await env.MAIL_DB.prepare(
      "UPDATE mail_admin SET totp_pending_iv=NULL,totp_pending_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_attempts=0 WHERE id='owner'"
    ).run();
    return responseJson({ ok: false, error: "Terlalu banyak percobaan. Mulai pendaftaran 2FA kembali." }, 429);
  }
  const secret = await decryptTotpSecret(env, owner.totp_pending_iv, owner.totp_pending_ciphertext);
  const step = await verifyTotp(secret, code, { now: Date.now(), lastAcceptedStep: -1, window: 1 });
  if (step === null) {
    const attempts = Number(owner.totp_pending_attempts || 0) + 1;
    await env.MAIL_DB.prepare(
      "UPDATE mail_admin SET totp_pending_attempts=?,totp_pending_iv=CASE WHEN ?>=5 THEN NULL ELSE totp_pending_iv END," +
      "totp_pending_ciphertext=CASE WHEN ?>=5 THEN NULL ELSE totp_pending_ciphertext END," +
      "totp_pending_expires_at=CASE WHEN ?>=5 THEN NULL ELSE totp_pending_expires_at END WHERE id='owner'"
    ).bind(attempts, attempts, attempts, attempts).run();
    return responseJson({ ok: false, error: attempts >= 5 ? "Kode salah lima kali. Mulai pendaftaran kembali." : "Kode autentikator tidak cocok." }, attempts >= 5 ? 429 : 401);
  }

  const recoveryCodes = Array.from({ length: TOTP_RECOVERY_CODE_COUNT }, () => randomHex(24));
  const statements = recoveryCodes.map(async (codeValue) => {
    const codeHash = await recoveryCodeHash(env, codeValue);
    return env.MAIL_DB.prepare(
      "INSERT INTO mail_2fa_recovery_codes(code_hash,created_at) VALUES(?,?)"
    ).bind(codeHash, Date.now());
  });
  const recoveryStatements = await Promise.all(statements);
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      "UPDATE mail_admin SET totp_enabled=1,totp_secret_iv=totp_pending_iv,totp_secret_ciphertext=totp_pending_ciphertext," +
      "totp_pending_iv=NULL,totp_pending_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_attempts=0,totp_last_step=? WHERE id='owner'"
    ).bind(step),
    ...recoveryStatements,
    env.MAIL_DB.prepare("DELETE FROM mail_sessions"),
    env.MAIL_DB.prepare("DELETE FROM mail_login_challenges")
  ]);
  return responseJson(
    { ok: true, enabled: true, recovery_codes: recoveryCodes, reauth_required: true },
    200,
    { "Set-Cookie": clearedSessionCookie() }
  );
}

async function handleTwoFactorDisable(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data verifikasi tidak valid." }, 400); }
  const password = typeof body.password === "string" ? body.password : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const owner = await env.MAIL_DB.prepare(
    "SELECT password_salt,password_hash,totp_enabled,totp_secret_iv,totp_secret_ciphertext,totp_last_step FROM mail_admin WHERE id='owner' LIMIT 1"
  ).first();
  if (!owner || Number(owner.totp_enabled) !== 1 || password.length > 128) {
    return responseJson({ ok: false, error: "Verifikasi tidak valid." }, 401);
  }
  const computed = await passwordHash(password, base64ToBytes(owner.password_salt));
  if (!constantTimeEqual(computed, owner.password_hash)) {
    return responseJson({ ok: false, error: "Password atau kode autentikator tidak valid." }, 401);
  }
  let valid = (await verifyOwnerTotp(env, owner, code)) !== null;
  if (!valid) valid = await consumeRecoveryCode(env, code);
  if (!valid) return responseJson({ ok: false, error: "Password atau kode autentikator/recovery tidak valid." }, 401);
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      "UPDATE mail_admin SET totp_enabled=0,totp_secret_iv=NULL,totp_secret_ciphertext=NULL," +
      "totp_pending_iv=NULL,totp_pending_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_attempts=0,totp_last_step=-1 WHERE id='owner'"
    ),
    env.MAIL_DB.prepare("DELETE FROM mail_2fa_recovery_codes"),
    env.MAIL_DB.prepare("DELETE FROM mail_sessions"),
    env.MAIL_DB.prepare("DELETE FROM mail_login_challenges")
  ]);
  return responseJson(
    { ok: true, disabled: true, reauth_required: true },
    200,
    { "Set-Cookie": clearedSessionCookie() }
  );
}

async function handleMachineTokensList(env) {
  const result = await env.MAIL_DB.prepare(
    "SELECT id,label,token_prefix,status,created_at,last_used_at,revoked_at FROM mail_machine_tokens ORDER BY created_at DESC LIMIT 100"
  ).all();
  return responseJson({ ok: true, tokens: result.results || [] });
}

async function handleMachineTokenCreate(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data token tidak valid." }, 400); }
  const label = clean(body.label, 60);
  if (label.length < 2) return responseJson({ ok: false, error: "Nama agent minimal 2 karakter." }, 400);
  const token = "tmt_" + randomHex(96);
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.MAIL_DB.prepare(
    "INSERT INTO mail_machine_tokens(id,label,token_hash,token_prefix,status,created_at) VALUES(?,?,?,?,'ACTIVE',?)"
  ).bind(id, label, tokenHash, token.slice(0, 12), now).run();
  return responseJson({
    ok: true,
    token: { id, label, token_prefix: token.slice(0, 12), status: "ACTIVE", created_at: now },
    secret: token,
    warning: "Secret hanya ditampilkan sekali. Simpan di secret vault agent, bukan di prompt atau repository."
  }, 201);
}

async function handleMachineTokenRevoke(request, env, id) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return responseJson({ ok: false, error: "ID token tidak valid." }, 400);
  const row = await env.MAIL_DB.prepare(
    "UPDATE mail_machine_tokens SET status='REVOKED',revoked_at=? WHERE id=? AND status='ACTIVE' RETURNING id"
  ).bind(Date.now(), id).first();
  if (!row) return responseJson({ ok: false, error: "Token aktif tidak ditemukan." }, 404);
  return responseJson({ ok: true, revoked: true });
}

async function handleAliasesGet(env) {
  const result = await env.MAIL_DB.prepare(
    "SELECT id,slug,label,status,created_at,expires_at,last_received_at,received_count " +
    "FROM mail_aliases WHERE status='ACTIVE' AND expires_at>? " +
    "ORDER BY created_at DESC LIMIT 100"
  ).bind(Date.now()).all();
  const mailboxes = result.results || [];
  return responseJson({ ok: true, mailboxes, aliases: mailboxes });
}

async function handleAliasCreate(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data mailbox tidak valid." }, 400); }
  const label = clean(body.label, 80);
  const ttlSeconds = Number(body.ttlSeconds ?? DEFAULT_MAILBOX_TTL_SECONDS);
  if (!isAllowedMailboxTtl(ttlSeconds)) {
    return responseJson({ ok: false, error: "Masa aktif mailbox tidak valid." }, 400);
  }
  const slug = randomHex(32);
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  await env.MAIL_DB.prepare(
    "INSERT INTO mail_aliases(id,slug,label,status,created_at,expires_at,received_count) VALUES(?,?,?,'ACTIVE',?,?,0)"
  ).bind(id, slug, label, now, expiresAt).run();
  return responseJson({
    ok: true,
    alias: {
      id,
      email: mailboxAddress(slug),
      label,
      status: "ACTIVE",
      created_at: now,
      expires_at: expiresAt,
      received_count: 0
    }
  }, 201);
}

async function handleAliasRevoke(request, env, id) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return responseJson({ ok: false, error: "ID alias tidak valid." }, 400);
  const now = Date.now();
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare("UPDATE mail_aliases SET status='REVOKED' WHERE id=?").bind(id),
    env.MAIL_DB.prepare("DELETE FROM mail_messages WHERE alias_id=?").bind(id),
    env.MAIL_DB.prepare("DELETE FROM mail_machine_aliases WHERE alias_id=?").bind(id)
  ]);
  return responseJson({ ok: true, revoked_at: now });
}

async function handleMessagesGet(url, env) {
  const aliasId = clean(url.searchParams.get("mailboxId") || url.searchParams.get("aliasId"), 64);
  if (!/^[0-9a-f-]{36}$/i.test(aliasId)) return responseJson({ ok: false, error: "Pilih mailbox yang valid." }, 400);
  const alias = await env.MAIL_DB.prepare(
    "SELECT id,slug,status,expires_at FROM mail_aliases WHERE id=? LIMIT 1"
  ).bind(aliasId).first();
  if (!alias) return responseJson({ ok: false, error: "Mailbox tidak ditemukan." }, 404);
  // All mailbox types become unreadable as soon as their configured TTL ends.
  if (!isMailboxActive(alias, Date.now())) {
    return responseJson({ ok: false, error: "Mailbox sudah kedaluwarsa atau tidak aktif." }, 410);
  }
  const result = await env.MAIL_DB.prepare(
    "SELECT id,message_id,received_at,payload_iv,payload_ciphertext " +
    "FROM mail_messages WHERE alias_id=? ORDER BY received_at DESC LIMIT 50"
  ).bind(aliasId).all();
  const messages = await Promise.all((result.results || []).map(async (row) => ({
    id: row.id,
    ...(await decryptMessagePayload(env, aliasId, row.payload_iv, row.payload_ciphertext)),
    message_id: row.message_id,
    received_at: row.received_at
  })));
  return responseJson({ ok: true, messages });
}

async function handleMessageDelete(request, env, id) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return responseJson({ ok: false, error: "ID pesan tidak valid." }, 400);
  await env.MAIL_DB.prepare("DELETE FROM mail_messages WHERE id=?").bind(id).run();
  return responseJson({ ok: true });
}


const MACHINE_API_RATE_WINDOW_MS = 60 * 1000;
const MACHINE_API_RATE_LIMIT = 120;
const MACHINE_ALIAS_HOURLY_LIMIT = 20;

function parseBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,160})$/);
  return match ? match[1] : "";
}

async function authenticateMachine(request, env) {
  if (!env.MAIL_DB) {
    return { response: responseJson({ ok: false, error: "Machine API belum dikonfigurasi." }, 503) };
  }
  const supplied = parseBearerToken(request);
  if (!supplied) {
    return { response: responseJson({ ok: false, error: "Token API tidak valid." }, 401) };
  }

  const tokenHash = await sha256Hex(supplied);
  const registered = await env.MAIL_DB.prepare(
    "SELECT id FROM mail_machine_tokens WHERE token_hash=? AND status='ACTIVE' LIMIT 1"
  ).bind(tokenHash).first();
  const legacyAccepted = !registered && Boolean(env.MAIL_VM_API_TOKEN) &&
    constantTimeEqual(supplied, env.MAIL_VM_API_TOKEN);
  if (!registered && !legacyAccepted) {
    return { response: responseJson({ ok: false, error: "Token API tidak valid atau sudah dicabut." }, 401) };
  }
  if (registered) {
    await env.MAIL_DB.prepare(
      "UPDATE mail_machine_tokens SET last_used_at=? WHERE id=?"
    ).bind(Date.now(), registered.id).run();
  }

  const now = Date.now();
  const cutoff = now - MACHINE_API_RATE_WINDOW_MS;
  const rate = await env.MAIL_DB.prepare(
    "INSERT INTO mail_machine_rate_limits(token_hash,window_started_at,request_count) VALUES(?,?,1) " +
    "ON CONFLICT(token_hash) DO UPDATE SET " +
    "request_count=CASE WHEN mail_machine_rate_limits.window_started_at<=? THEN 1 ELSE mail_machine_rate_limits.request_count+1 END, " +
    "window_started_at=CASE WHEN mail_machine_rate_limits.window_started_at<=? THEN excluded.window_started_at ELSE mail_machine_rate_limits.window_started_at END " +
    "RETURNING request_count"
  ).bind(tokenHash, now, cutoff, cutoff).first();

  if (!rate || Number(rate.request_count) > MACHINE_API_RATE_LIMIT) {
    return {
      response: responseJson({ ok: false, error: "Batas permintaan API tercapai. Coba kembali sebentar lagi." }, 429, {
        "Retry-After": "60"
      })
    };
  }
  return { tokenHash };
}

async function handleMachineAliasCreate(request, env, tokenHash) {
  if (!await hasOwner(env)) {
    return responseJson({ ok: false, error: "Panel owner belum diinisialisasi." }, 503);
  }
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data pembuatan mailbox tidak valid." }, 400); }

  const ttlSeconds = Number(body.ttlSeconds ?? DEFAULT_MAILBOX_TTL_SECONDS);
  if (!isAllowedMailboxTtl(ttlSeconds)) {
    return responseJson({ ok: false, error: "Masa aktif mailbox tidak valid." }, 400);
  }
  const rawClientRef = body.clientRef == null ? "" : String(body.clientRef);
  const clientRef = clean(rawClientRef, 100);
  if (clientRef && (!/^[A-Za-z0-9._:-]{1,100}$/.test(clientRef) || clientRef !== rawClientRef.trim())) {
    return responseJson({ ok: false, error: "clientRef hanya boleh berisi huruf, angka, titik, garis bawah, titik dua, dan tanda hubung." }, 400);
  }

  const storedClientRef = clientRef ? tokenHash.slice(0, 20) + ":" + clientRef : "";
  if (clientRef) {
    const existing = await env.MAIL_DB.prepare(
      "SELECT a.id,a.slug,a.label,a.status,a.created_at,a.expires_at,a.received_count " +
      "FROM mail_machine_aliases m JOIN mail_aliases a ON a.id=m.alias_id " +
      "WHERE (m.client_ref=? OR m.client_ref=?) AND m.token_hash=? LIMIT 1"
    ).bind(storedClientRef, clientRef, tokenHash).first();
    if (existing) {
      if (existing.status !== "ACTIVE" || Number(existing.expires_at) <= Date.now()) {
        return responseJson({ ok: false, error: "clientRef sudah pernah dipakai dan aliasnya tidak lagi aktif." }, 409);
      }
      return responseJson({
        ok: true,
        reused: true,
        alias: {
          id: existing.id,
          email: mailboxAddress(existing.slug),
          label: existing.label,
          status: existing.status,
          created_at: existing.created_at,
          expires_at: existing.expires_at,
          received_count: existing.received_count
        }
      });
    }
  }

  const now = Date.now();
  const hourly = await env.MAIL_DB.prepare(
    "SELECT COUNT(*) AS total FROM mail_machine_aliases WHERE token_hash=? AND created_at>?"
  ).bind(tokenHash, now - 60 * 60 * 1000).first();
  if (Number(hourly?.total || 0) >= MACHINE_ALIAS_HOURLY_LIMIT) {
    return responseJson({ ok: false, error: "Batas pembuatan mailbox mesin per jam tercapai." }, 429, {
      "Retry-After": "3600"
    });
  }

  const label = clean(body.label || "VM Muse", 80);
  const slug = randomHex(32);
  const id = crypto.randomUUID();
  const expiresAt = now + ttlSeconds * 1000;
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      "INSERT INTO mail_aliases(id,slug,label,status,created_at,expires_at,received_count) VALUES(?,?,?,'ACTIVE',?,?,0)"
    ).bind(id, slug, label, now, expiresAt),
    env.MAIL_DB.prepare(
      "INSERT INTO mail_machine_aliases(alias_id,client_ref,token_hash,created_at) VALUES(?,?,?,?)"
    ).bind(id, storedClientRef || null, tokenHash, now)
  ]);

  return responseJson({
    ok: true,
    reused: false,
    alias: {
      id,
      email: mailboxAddress(slug),
      label,
      status: "ACTIVE",
      created_at: now,
      expires_at: expiresAt,
      received_count: 0
    }
  }, 201);
}


async function handleMachineAliasesGet(url, env, tokenHash) {
  if (!await hasOwner(env)) {
    return responseJson({ ok: false, error: "Panel owner belum diinisialisasi." }, 503);
  }
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  if ((rawLimit !== null && !/^\d{1,2}$/.test(rawLimit)) ||
      (rawOffset !== null && !/^\d{1,5}$/.test(rawOffset))) {
    return responseJson({ ok: false, error: "Parameter pagination tidak valid." }, 400);
  }
  const limit = rawLimit === null ? 25 : Math.min(50, Math.max(1, Number(rawLimit)));
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || offset > 10000) {
    return responseJson({ ok: false, error: "Parameter pagination di luar batas." }, 400);
  }

  const count = await env.MAIL_DB.prepare(
    "SELECT COUNT(*) AS total FROM mail_machine_aliases WHERE token_hash=?"
  ).bind(tokenHash).first();
  const result = await env.MAIL_DB.prepare(
    "SELECT a.id,a.slug,a.label,a.status,a.created_at,a.expires_at,a.last_received_at,a.received_count " +
    "FROM mail_machine_aliases m JOIN mail_aliases a ON a.id=m.alias_id " +
    "WHERE m.token_hash=? ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?"
  ).bind(tokenHash, limit, offset).all();
  const now = Date.now();
  const aliases = (result.results || []).map((row) => ({
    id: row.id,
    email: mailboxAddress(row.slug),
    label: clean(row.label, 80),
    status: row.status === "REVOKED" ? "REVOKED" : isMailboxActive(row, now) ? "ACTIVE" : "EXPIRED",
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    last_received_at: row.last_received_at == null ? null : Number(row.last_received_at),
    received_count: Number(row.received_count || 0)
  }));
  const total = Number(count?.total || 0);
  return responseJson({
    ok: true,
    mailboxes: aliases,
    aliases,
    pagination: { total, limit, offset, has_more: offset + aliases.length < total }
  });
}

async function handleMachineMessagesGet(url, env, tokenHash) {
  if (!await hasOwner(env)) {
    return responseJson({ ok: false, error: "Panel owner belum diinisialisasi." }, 503);
  }
  const aliasId = clean(url.searchParams.get("mailboxId") || url.searchParams.get("aliasId"), 64);
  if (!/^[0-9a-f-]{36}$/i.test(aliasId)) {
    return responseJson({ ok: false, error: "aliasId tidak valid." }, 400);
  }

  const alias = await env.MAIL_DB.prepare(
    "SELECT a.id,a.slug,a.status,a.expires_at FROM mail_aliases a " +
    "JOIN mail_machine_aliases m ON m.alias_id=a.id " +
    "WHERE a.id=? AND m.token_hash=? LIMIT 1"
  ).bind(aliasId, tokenHash).first();

  if (!alias) return responseJson({ ok: false, error: "Mailbox mesin tidak ditemukan." }, 404);
  if (alias.status !== "ACTIVE" || Number(alias.expires_at) <= Date.now()) {
    return responseJson({ ok: false, error: "Mailbox sudah tidak aktif atau kedaluwarsa." }, 410);
  }

  const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : 0;
  const afterId = clean(url.searchParams.get("afterId"), 64);
  if (!Number.isSafeInteger(after) || after < 0 || (afterId && !/^[0-9a-f-]{36}$/i.test(afterId))) {
    return responseJson({ ok: false, error: "Cursor pesan tidak valid." }, 400);
  }

  const result = await env.MAIL_DB.prepare(
    "SELECT id,received_at,payload_iv,payload_ciphertext FROM mail_messages " +
    "WHERE alias_id=? AND (received_at>? OR (received_at=? AND id>?)) " +
    "ORDER BY received_at ASC,id ASC LIMIT 51"
  ).bind(aliasId, after, after, afterId).all();

  const rows = result.results || [];
  const hasMore = rows.length > 50;
  const page = rows.slice(0, 50);
  const messages = await Promise.all(page.map(async (row) => {
    const payload = await decryptMessagePayload(env, aliasId, row.payload_iv, row.payload_ciphertext);
    return {
      id: row.id,
      sender: clean(payload.sender, 254),
      subject: clean(payload.subject, 300),
      verification_code: payload.verification_code ? clean(payload.verification_code, 32) : null,
      received_at: Number(row.received_at)
    };
  }));
  const last = page[page.length - 1];

  const mailbox = {
    id: alias.id,
    email: mailboxAddress(alias.slug),
    expires_at: Number(alias.expires_at)
  };
  return responseJson({
    ok: true,
    mailbox,
    alias: mailbox,
    messages,
    has_more: hasMore,
    next_cursor: last ? { after: Number(last.received_at), afterId: last.id } : null
  });
}

async function handleMachineMessageGet(url, env, tokenHash, messageId) {
  if (!await hasOwner(env)) {
    return responseJson({ ok: false, error: "Panel owner belum diinisialisasi." }, 503);
  }

  const aliasId = clean(url.searchParams.get("mailboxId") || url.searchParams.get("aliasId"), 64);
  if (!/^[0-9a-f-]{36}$/i.test(aliasId)) {
    return responseJson({ ok: false, error: "aliasId tidak valid." }, 400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) {
    return responseJson({ ok: false, error: "messageId tidak valid." }, 400);
  }

  const alias = await env.MAIL_DB.prepare(
    "SELECT a.id,a.status,a.expires_at FROM mail_aliases a " +
    "JOIN mail_machine_aliases m ON m.alias_id=a.id " +
    "WHERE a.id=? AND m.token_hash=? LIMIT 1"
  ).bind(aliasId, tokenHash).first();

  if (!alias) return responseJson({ ok: false, error: "Mailbox mesin tidak ditemukan." }, 404);
  if (alias.status !== "ACTIVE" || Number(alias.expires_at) <= Date.now()) {
    return responseJson({ ok: false, error: "Mailbox sudah tidak aktif atau kedaluwarsa." }, 410);
  }

  const row = await env.MAIL_DB.prepare(
    "SELECT id,received_at,payload_iv,payload_ciphertext FROM mail_messages " +
    "WHERE id=? AND alias_id=? LIMIT 1"
  ).bind(messageId, aliasId).first();

  if (!row) return responseJson({ ok: false, error: "Pesan tidak ditemukan." }, 404);

  const payload = await decryptMessagePayload(env, aliasId, row.payload_iv, row.payload_ciphertext);
  return responseJson({
    ok: true,
    message: {
      id: row.id,
      sender: clean(payload.sender, 254),
      recipient: clean(payload.recipient, 320),
      subject: clean(payload.subject, 300),
      body_text: clean(payload.body_text, MAX_BODY_CHARS),
      verification_code: payload.verification_code ? clean(payload.verification_code, 32) : null,
      received_at: Number(row.received_at)
    }
  });
}

async function handleMachineAliasRevoke(request, env, id, tokenHash) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return responseJson({ ok: false, error: "aliasId tidak valid." }, 400);
  }
  const alias = await env.MAIL_DB.prepare(
    "SELECT alias_id FROM mail_machine_aliases WHERE alias_id=? AND token_hash=? LIMIT 1"
  ).bind(id, tokenHash).first();
  if (!alias) return responseJson({ ok: false, error: "Mailbox mesin tidak ditemukan." }, 404);

  const now = Date.now();
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare("UPDATE mail_aliases SET status='REVOKED' WHERE id=?").bind(id),
    env.MAIL_DB.prepare("DELETE FROM mail_messages WHERE alias_id=?").bind(id)
  ]);
  return responseJson({ ok: true, revoked_at: now });
}


async function handleMachineHealth(env) {
  const checkedAt = Date.now();
  try {
    const row = await env.MAIL_DB.prepare("SELECT 1 AS ready").first();
    const ready = Number(row?.ready) === 1;
    return responseJson({
      ok: ready,
      service: "seiton-mail-automation",
      database_ready: ready,
      inbound_email_routing: "unverified",
      checked_at: checkedAt
    }, ready ? 200 : 503);
  } catch {
    return responseJson({
      ok: false,
      service: "seiton-mail-automation",
      database_ready: false,
      inbound_email_routing: "unverified",
      checked_at: checkedAt
    }, 503);
  }
}

async function handleMachineApi(request, env, url) {
  const auth = await authenticateMachine(request, env);
  if (auth.response) return auth.response;

  if (request.method === "GET" && url.pathname === "/api/v1/machine/health") {
    return handleMachineHealth(env);
  }
  if (request.method === "GET" && (url.pathname === "/api/v1/machine/mailboxes" || url.pathname === "/api/v1/machine/aliases")) {
    return handleMachineAliasesGet(url, env, auth.tokenHash);
  }
  if (request.method === "POST" && url.pathname === "/api/v1/machine/mailboxes") {
    const response = await handleMachineAliasCreate(request, env, auth.tokenHash);
    const payload = await response.json().catch(() => ({}));
    if (payload.alias) {
      payload.mailbox = payload.alias;
      delete payload.alias;
    }
    return responseJson(payload, response.status);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/v1/machine/mailboxes/")) {
    const id = url.pathname.slice("/api/v1/machine/mailboxes/".length);
    return handleMachineAliasRevoke(request, env, id, auth.tokenHash);
  }
  if (request.method === "POST" && url.pathname === "/api/v1/machine/aliases") {
    return handleMachineAliasCreate(request, env, auth.tokenHash);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/machine/messages") {
    return handleMachineMessagesGet(url, env, auth.tokenHash);
  }
  const detailMatch = url.pathname.match(/^\/api\/v1\/machine\/messages\/([0-9a-f-]{36})$/i);
  if (request.method === "GET" && detailMatch) {
    return handleMachineMessageGet(url, env, auth.tokenHash, detailMatch[1]);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/v1/machine/aliases/")) {
    const id = url.pathname.slice("/api/v1/machine/aliases/".length);
    return handleMachineAliasRevoke(request, env, id, auth.tokenHash);
  }
  return responseJson({ ok: false, error: "Machine endpoint tidak ditemukan." }, 404);
}

async function api(request, env, url) {
  if (url.pathname.startsWith("/api/v1/machine/")) {
    return handleMachineApi(request, env, url);
  }
  if (request.method === "POST" && url.pathname === "/api/public/mailboxes") return handlePublicMailboxCreate(request, env);
  if (request.method === "POST" && url.pathname === "/api/public/unlock") return handlePublicMailboxUnlock(request, env);
  if (request.method === "GET" && url.pathname === "/api/public/inbox") return handlePublicInboxGet(request, url, env);
  if (request.method === "POST" && url.pathname === "/api/public/logout") return handlePublicMailboxLogout(request, env);

  if (request.method === "GET" && url.pathname === "/api/session") {
    return responseJson({
      ok: true,
      configured: await hasOwner(env),
      authenticated: Boolean(await currentSession(request, env)),
      two_factor_enabled: Number((await env.MAIL_DB.prepare("SELECT totp_enabled FROM mail_admin WHERE id='owner' LIMIT 1").first())?.totp_enabled || 0) === 1
    });
  }
  if (request.method === "POST" && url.pathname === "/api/setup") return handleSetup(request, env);
  if (request.method === "POST" && url.pathname === "/api/login") return handleLogin(request, env);
  if (request.method === "POST" && url.pathname === "/api/login/2fa") return handleLoginTwoFactor(request, env);
  if (request.method === "POST" && url.pathname === "/api/logout") return handleLogout(request, env);

  const session = await requireSession(request, env);
  if (!session) return responseJson({ ok: false, error: "Sesi admin tidak valid atau sudah berakhir." }, 401);

  if (request.method === "GET" && url.pathname === "/api/2fa/status") return handleTwoFactorStatus(env);
  if (request.method === "POST" && url.pathname === "/api/2fa/enroll") return handleTwoFactorEnroll(request, env);
  if (request.method === "POST" && url.pathname === "/api/2fa/confirm") return handleTwoFactorConfirm(request, env);
  if (request.method === "POST" && url.pathname === "/api/2fa/disable") return handleTwoFactorDisable(request, env);
  if (request.method === "GET" && url.pathname === "/api/machine-tokens") return handleMachineTokensList(env);
  if (request.method === "POST" && url.pathname === "/api/machine-tokens") return handleMachineTokenCreate(request, env);
  if (request.method === "DELETE" && url.pathname.startsWith("/api/machine-tokens/")) {
    return handleMachineTokenRevoke(request, env, url.pathname.slice("/api/machine-tokens/".length));
  }

  if (request.method === "GET" && (url.pathname === "/api/mailboxes" || url.pathname === "/api/aliases")) return handleAliasesGet(env);
  if (request.method === "POST" && url.pathname === "/api/mailboxes") {
    const response = await handleAliasCreate(request, env);
    const payload = await response.json().catch(() => ({}));
    if (payload.alias) {
      payload.mailbox = payload.alias;
      delete payload.alias;
    }
    return responseJson(payload, response.status);
  }
  if (request.method === "POST" && url.pathname === "/api/aliases") return handleAliasCreate(request, env);
  if (request.method === "DELETE" && url.pathname.startsWith("/api/mailboxes/")) {
    return handleAliasRevoke(request, env, url.pathname.slice("/api/mailboxes/".length));
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/aliases/")) {
    return handleAliasRevoke(request, env, url.pathname.slice("/api/aliases/".length));
  }
  if (request.method === "GET" && url.pathname === "/api/messages") return handleMessagesGet(url, env);
  if (request.method === "DELETE" && url.pathname.startsWith("/api/messages/")) {
    return handleMessageDelete(request, env, url.pathname.slice("/api/messages/".length));
  }
  return responseJson({ ok: false, error: "Endpoint tidak ditemukan." }, 404);
}

const CLIENT_SCRIPT = `
const byId = (id) => document.getElementById(id);
let statusBox = byId("authStatus");
let selectedAliasId = "";
let aliasCache = [];
let loginNeedsTotp = false;
let currentNewMachineToken = "";
let dashboardTimer = null;

function setStatus(message, bad) {
  statusBox.textContent = message || "";
  statusBox.className = bad ? "status error" : "status";
}
async function api(path, options) {
  const config = Object.assign({ credentials: "same-origin" }, options || {});
  config.headers = Object.assign({ "Accept": "application/json" }, config.headers || {});
  if (config.body && typeof config.body !== "string") {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(path, config);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || "Permintaan gagal.");
  return data;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function copyText(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("Clipboard tidak tersedia.");
    }
    setStatus("Berhasil disalin.");
  } catch {
    setStatus("Tidak bisa menyalin otomatis. Pilih teks lalu salin manual.", true);
  }
}
function formatDate(value) {
  return new Date(Number(value)).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}
function emailFor(alias) {
  return alias.slug.length === 24
    ? "receiver+" + alias.slug + "@seiton.my.id"
    : alias.slug + "@seiton.my.id";
}
function showAuth(configured) {
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  statusBox = byId("authStatus");
  byId("auth").hidden = false;
  byId("dashboard").hidden = true;
  byId("setupForm").hidden = configured;
  byId("loginForm").hidden = !configured;
  loginNeedsTotp = false;
  byId("loginPasswordGroup").hidden = false;
  byId("loginPassword").required = true;
  byId("loginTotpGroup").hidden = true;
  byId("loginTotpCode").required = false;
  byId("loginButton").textContent = "Masuk";
  setStatus(configured ? "Masuk untuk membuka panel privat." : "Setup awal: gunakan bootstrap token yang diberikan owner.");
}
function showDashboard() {
  statusBox = byId("dashboardStatus");
  byId("auth").hidden = true;
  byId("dashboard").hidden = false;
  setStatus("Panel siap. Daftar mailbox akan diperbarui otomatis.");
  loadAliases().catch((error) => setStatus(error.message, true));
  loadSecuritySettings().catch((error) => setStatus(error.message, true));
  if (dashboardTimer) clearInterval(dashboardTimer);
  dashboardTimer = setInterval(() => {
    if (document.visibilityState !== "hidden") {
      loadAliases().catch((error) => setStatus(error.message, true));
    }
  }, 10000);
}
function renderAliases() {
  const target = byId("aliases");
  const query = (byId("mailboxSearch")?.value || "").trim().toLowerCase();
  target.replaceChildren();
  const visible = aliasCache.filter((alias) =>
    !query || emailFor(alias).toLowerCase().includes(query) ||
    String(alias.label || "").toLowerCase().includes(query)
  );
  if (!aliasCache.length) {
    target.append(element("p", "empty", "Belum ada mailbox. Buat alamat pertama untuk mulai menerima email."));
    return;
  }
  if (!visible.length) {
    target.append(element("p", "empty", "Tidak ada mailbox yang cocok dengan pencarian."));
    return;
  }
  for (const alias of visible) {
    const card = element("article", "alias-card" + (selectedAliasId === alias.id ? " selected" : ""));
    const heading = element("div", "alias-heading");
    const title = element("strong", "", alias.label || "Mailbox tanpa label");
    const state = element("span", "state active", "Aktif");
    heading.append(title, state);
    const address = element("code", "address", emailFor(alias));
    const detail = element("p", "muted", "Berakhir " + formatDate(alias.expires_at) + " · " + alias.received_count + " email");
    const actions = element("div", "alias-actions");
    const copy = element("button", "button secondary small", "Salin alamat");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(emailFor(alias)));
    const open = element("button", "button small", selectedAliasId === alias.id ? "Inbox terbuka" : "Buka inbox");
    open.type = "button";
    open.setAttribute("aria-pressed", String(selectedAliasId === alias.id));
    open.addEventListener("click", () => selectAlias(alias.id));
    actions.append(copy, open);
    const revoke = element("button", "button danger small", "Hapus mailbox");
    revoke.type = "button";
    revoke.addEventListener("click", () => revokeAlias(alias.id));
    actions.append(revoke);
    card.append(heading, address, detail, actions);
    target.append(card);
  }
}
async function loadAliases() {
  const data = await api("/api/mailboxes");
  aliasCache = (data.mailboxes || data.aliases || []).filter((item) =>
    item.status === "ACTIVE" && Number(item.expires_at) > Date.now()
  );
  renderAliases();
  byId("aliasCount").textContent = String(aliasCache.length);
  if (byId("lastDashboardRefresh")) {
    byId("lastDashboardRefresh").textContent = "Diperbarui " + new Date().toLocaleTimeString("id-ID");
  }

  if (selectedAliasId && !aliasCache.some((item) => item.id === selectedAliasId)) {
    selectedAliasId = "";
    byId("selectedAddress").textContent = "Pilih mailbox yang masih aktif.";
    byId("messages").replaceChildren(element("p", "empty", "Mailbox yang dipilih sudah kedaluwarsa atau tidak aktif."));
    byId("messageCount").textContent = "0";
  }

  if (!selectedAliasId && aliasCache.length) {
    await selectAlias(aliasCache[0].id);
  } else if (selectedAliasId) {
    await loadMessages(selectedAliasId);
  }
}
async function selectAlias(id) {
  selectedAliasId = id;
  renderAliases();
  const selected = aliasCache.find((item) => item.id === id);
  byId("selectedAddress").textContent = selected ? emailFor(selected) : "Pilih mailbox";
  await loadMessages(id);
}
async function loadMessages(id) {
  const target = byId("messages");
  target.replaceChildren();
  if (!id) return;
  const data = await api("/api/messages?mailboxId=" + encodeURIComponent(id));
  const messages = data.messages || [];
  byId("messageCount").textContent = String(messages.length);
  if (!messages.length) {
    target.append(element("p", "empty", "Belum ada email masuk untuk alamat ini."));
    return;
  }
  for (const item of messages) {
    const card = element("article", "message-card");
    const top = element("div", "message-top");
    const title = element("strong", "", item.subject || "(Tanpa subjek)");
    const date = element("span", "muted", formatDate(item.received_at));
    top.append(title, date);
    const sender = element("p", "muted", "Dari: " + (item.sender || "tidak diketahui"));
    card.append(top, sender);
    if (item.verification_code) {
      const codeRow = element("div", "code-row");
      const code = element("code", "otp-code", item.verification_code);
      const copy = element("button", "button small", "Salin kode");
      copy.type = "button";
      copy.addEventListener("click", () => copyText(item.verification_code));
      codeRow.append(code, copy);
      card.append(codeRow);
    } else {
      card.append(element("p", "muted", "Kode tidak terdeteksi otomatis."));
    }
    const disclosure = element("details", "message-body");
    const summary = element("summary", "", "Lihat isi email");
    const preview = element("pre", "body-preview", (item.body_text || "").slice(0, 5000) || "Isi pesan tidak tersedia.");
    disclosure.append(summary, preview);
    card.append(disclosure);
    const remove = element("button", "button danger small", "Hapus pesan");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      try {
        await api("/api/messages/" + encodeURIComponent(item.id), { method: "DELETE" });
        await loadMessages(id);
        setStatus("Pesan dihapus.");
      } catch (error) { setStatus(error.message, true); }
    });
    card.append(remove);
    target.append(card);
  }
}
async function revokeAlias(id) {
  if (!window.confirm("Cabut mailbox ini dan hapus pesan yang tersimpan?")) return;
  try {
    await api("/api/mailboxes/" + encodeURIComponent(id), { method: "DELETE" });
    if (selectedAliasId === id) {
      selectedAliasId = "";
      byId("selectedAddress").textContent = "Pilih mailbox";
      byId("messages").replaceChildren();
    }
    await loadAliases();
    setStatus("Mailbox dicabut dan pesan dihapus.");
  } catch (error) { setStatus(error.message, true); }
}
byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (loginNeedsTotp) {
      await api("/api/login/2fa", { method: "POST", body: { code: byId("loginTotpCode").value } });
      byId("loginTotpCode").value = "";
      loginNeedsTotp = false;
      showDashboard();
      return;
    }
    const result = await api("/api/login", { method: "POST", body: { password: byId("loginPassword").value } });
    byId("loginPassword").value = "";
    if (result.requiresTwoFactor) {
      loginNeedsTotp = true;
      byId("loginPasswordGroup").hidden = true;
      byId("loginPassword").required = false;
      byId("loginTotpGroup").hidden = false;
      byId("loginTotpCode").required = true;
      byId("loginButton").textContent = "Verifikasi 2FA";
      byId("loginTotpCode").focus();
      setStatus("Password benar. Masukkan kode autentikator atau recovery code.");
      return;
    }
    showDashboard();
  } catch (error) { setStatus(error.message, true); }
});
byId("setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/setup", {
      method: "POST",
      body: {
        bootstrapToken: byId("bootstrapToken").value,
        password: byId("setupPassword").value
      }
    });
    byId("setupForm").reset();
    showDashboard();
  } catch (error) { setStatus(error.message, true); }
});

async function loadSecuritySettings() {
  const status = await api("/api/2fa/status");
  byId("twoFactorStatus").textContent = status.enabled
    ? "2FA aktif. Sisa recovery codes: " + status.recovery_codes_remaining
    : "2FA belum aktif. Aktifkan untuk mewajibkan kode autentikator saat login Owner.";
  byId("enableTwoFactor").hidden = status.enabled;
  byId("disableTwoFactorForm").hidden = !status.enabled;
  await loadMachineTokens();
}
async function loadMachineTokens() {
  const data = await api("/api/machine-tokens");
  const target = byId("machineTokenList");
  target.replaceChildren();
  if (!data.tokens.length) {
    target.append(element("p", "empty", "Belum ada token agent. Token lama MAIL_VM_API_TOKEN tetap berlaku selama masih dikonfigurasi."));
    return;
  }
  for (const token of data.tokens) {
    const card = element("article", "alias-card");
    const title = element("strong", "", token.label);
    const prefix = element("code", "address", token.token_prefix + "…");
    const meta = element("p", "muted",
      token.status + " • dibuat " + formatDate(token.created_at) +
      (token.last_used_at ? " • terakhir dipakai " + formatDate(token.last_used_at) : " • belum pernah dipakai"));
    card.append(title, prefix, meta);
    if (token.status === "ACTIVE") {
      const revoke = element("button", "button danger small", "Cabut token");
      revoke.type = "button";
      revoke.addEventListener("click", async () => {
        if (!window.confirm("Cabut token " + token.label + "? Agent ini akan langsung kehilangan akses; agent lain tidak terpengaruh.")) return;
        try {
          await api("/api/machine-tokens/" + encodeURIComponent(token.id), { method: "DELETE" });
          await loadMachineTokens();
          setStatus("Token agent berhasil dicabut.");
        } catch (error) { setStatus(error.message, true); }
      });
      card.append(revoke);
    }
    target.append(card);
  }
}
byId("enableTwoFactor").addEventListener("click", async () => {
  try {
    const data = await api("/api/2fa/enroll", { method: "POST", body: {} });
    byId("twoFactorSecret").textContent = data.secret;
    byId("twoFactorUri").textContent = data.otpauth_uri;
    byId("twoFactorEnrollment").hidden = false;
    byId("twoFactorCode").focus();
    setStatus("Pendaftaran 2FA berlaku 10 menit. Masukkan kode autentikator untuk mengaktifkan.");
  } catch (error) { setStatus(error.message, true); }
});
byId("copyTwoFactorSecret").addEventListener("click", () => copyText(byId("twoFactorSecret").textContent));
byId("copyTwoFactorUri").addEventListener("click", () => copyText(byId("twoFactorUri").textContent));
byId("confirmTwoFactorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/2fa/confirm", {
      method: "POST",
      body: { code: byId("twoFactorCode").value }
    });
    byId("twoFactorCode").value = "";
    byId("twoFactorEnrollment").hidden = true;
    byId("recoveryCodes").textContent = result.recovery_codes.join("\\n");
    byId("recoveryCodesPanel").hidden = false;
    byId("twoFactorStatus").textContent = "2FA aktif. Login berikutnya akan meminta kode autentikator.";
    byId("enableTwoFactor").hidden = true;
    byId("disableTwoFactorForm").hidden = false;
    setStatus("2FA aktif. Sesi Owner sudah dicabut. Simpan recovery codes sekarang, lalu masuk kembali.");
    byId("logout").textContent = "Masuk ulang";
  } catch (error) { setStatus(error.message, true); }
});
byId("copyRecoveryCodes").addEventListener("click", () => copyText(byId("recoveryCodes").textContent));
byId("disableTwoFactorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Nonaktifkan 2FA untuk panel Owner?")) return;
  try {
    await api("/api/2fa/disable", {
      method: "POST",
      body: {
        password: byId("disableTwoFactorPassword").value,
        code: byId("disableTwoFactorCode").value
      }
    });
    byId("disableTwoFactorForm").reset();
    showAuth(true);
    setStatus("2FA dinonaktifkan. Masuk kembali untuk membuat sesi baru.");
  } catch (error) { setStatus(error.message, true); }
});
byId("createMachineTokenForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/machine-tokens", {
      method: "POST",
      body: { label: byId("machineTokenLabel").value }
    });
    currentNewMachineToken = result.secret;
    byId("newMachineTokenSecret").textContent = currentNewMachineToken;
    byId("newMachineTokenPanel").hidden = false;
    byId("machineTokenLabel").value = "";
    await loadMachineTokens();
    setStatus("Token dibuat. Salin dan simpan ke secret vault agent sekarang; secret tidak akan ditampilkan lagi.");
  } catch (error) { setStatus(error.message, true); }
});
byId("copyNewMachineToken").addEventListener("click", () => {
  if (currentNewMachineToken) copyText(currentNewMachineToken);
});

byId("mailboxSearch").addEventListener("input", renderAliases);
byId("createAlias").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/mailboxes", {
      method: "POST",
      body: {
        label: byId("aliasLabel").value,
        ttlSeconds: Number(byId("aliasTtl").value)
      }
    });
    byId("aliasLabel").value = "";
    await loadAliases();
    await copyText(data.mailbox.email);
    await selectAlias(data.mailbox.id);
    setStatus("Mailbox SeitonMail dibuat dan disalin: " + data.mailbox.email);
  } catch (error) { setStatus(error.message, true); }
});
byId("refresh").addEventListener("click", () => loadAliases().then(() => setStatus("Inbox diperbarui.")).catch((error) => setStatus(error.message, true)));
byId("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    selectedAliasId = "";
    const state = await api("/api/session");
    showAuth(state.configured);
  } catch (error) { setStatus(error.message, true); }
});
(async function init() {
  try {
    const state = await api("/api/session");
    if (state.authenticated) showDashboard();
    else showAuth(state.configured);
  } catch (error) {
    showAuth(true);
    setStatus(error.message, true);
  }
})();
`;

function renderPanel(nonce, configured) {
  const mode = configured ? "true" : "false";
  const styles = `
:root{color-scheme:light;--page:#f4f6f4;--surface:#fff;--soft:#f7f9f7;--line:#e1e7e1;--ink:#17231c;--muted:#6a776e;--accent:#087f5b;--accent-dark:#06684b;--danger:#b42332;--shadow:0 10px 30px rgba(28,50,35,.05)}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(100% - 36px,1180px);margin:0 auto;padding:28px 0 54px}
[hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.65;cursor:wait}
:focus-visible{outline:3px solid rgba(8,127,91,.24);outline-offset:2px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:34px}.mark{width:36px;height:36px;display:grid;place-items:center;border-radius:10px;background:var(--accent);color:#fff;font-size:18px;font-weight:800}.brand strong{display:block;font-size:15px;letter-spacing:-.02em}.brand small{display:block;color:var(--muted);font-size:11px}
.eyebrow{display:inline-block;margin-bottom:5px;color:var(--accent);font-size:10px;font-weight:750;letter-spacing:.08em}h1{font-size:27px;line-height:1.18;letter-spacing:-.035em;margin:0;font-weight:730}h2{font-size:15px;margin:0;font-weight:700;letter-spacing:-.015em}.muted{color:var(--muted);font-size:12px;margin:5px 0 0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:19px;box-shadow:var(--shadow)}
.auth{max-width:410px;margin:48px auto 0}.auth-heading{margin-bottom:18px}.auth-heading p{color:var(--muted);font-size:13px;margin:7px 0 0}.auth label,.panel label{display:block;margin:13px 0 6px;font-size:12px;font-weight:650;color:#344239}
input,select{width:100%;min-width:0;border:1px solid #d6ded7;border-radius:8px;padding:10px 11px;background:#fff;color:var(--ink);outline:none}
input::placeholder{color:#9aa69d}input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(8,127,91,.09)}
.button{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--accent);border-radius:8px;padding:9px 12px;background:var(--accent);color:#fff;font-size:12px;font-weight:680}
.button:hover{background:var(--accent-dark);border-color:var(--accent-dark)}.button.secondary{background:#fff;color:#344239;border-color:#d6ded7}.button.secondary:hover{background:var(--soft)}.button.danger{background:#fff;color:var(--danger);border-color:#edc9ce}.button.danger:hover{background:#fff5f6}.button.small{padding:7px 9px;font-size:11px}
.auth .button{width:100%;margin-top:17px;min-height:42px}.muted-note{margin:17px 0 0;color:var(--muted);font-size:11px;line-height:1.6}
.status{min-height:19px;margin:9px 0;color:var(--muted);font-size:12px}.status.error{color:var(--danger)}
.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:17px}.topbar p{margin:5px 0 0;color:var(--muted);font-size:13px}.top-actions{display:flex;gap:7px;flex-wrap:wrap}
.stats{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0}.stat{min-width:145px;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.stat strong{display:inline-block;margin-right:5px;font-size:19px;font-weight:730;letter-spacing:-.03em}.stat span{color:var(--muted);font-size:11px}
.grid{display:grid;grid-template-columns:minmax(320px,.92fr) minmax(0,1.35fr);gap:14px;align-items:start}
.panel-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}.panel-heading p{margin:4px 0 0;color:var(--muted);font-size:11px}
.create-row{display:grid;grid-template-columns:minmax(0,1fr) 140px auto;gap:8px;align-items:end}.create-row label{margin-top:0}.create-row button{height:39px;white-space:nowrap}
.helper{color:var(--muted);font-size:11px;margin:9px 0 0}
.search-wrap{margin:17px 0 10px}.search-wrap label{margin-top:0}.search-wrap input{padding:9px 11px}
.alias-list,.message-list{display:grid;gap:9px;margin-top:12px}
.alias-card,.message-card{min-width:0;padding:13px;border:1px solid var(--line);border-radius:10px;background:#fff}
.alias-card.selected{border-color:#91c9aa;background:#f7fbf8;box-shadow:inset 3px 0 0 var(--accent)}
.alias-heading,.message-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.alias-heading strong,.message-top strong{font-size:12px;overflow-wrap:anywhere}
.state{flex:0 0 auto;border-radius:20px;padding:3px 8px;background:#e8f4ed;color:#14734e;font-size:10px;font-weight:700}
.address{display:block;margin:8px 0;color:#116c4c;font-size:12px;overflow-wrap:anywhere}
.alias-card .muted{font-size:11px}.alias-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.empty{padding:24px 14px;text-align:center;border:1px dashed #ccd7cd;border-radius:10px;color:var(--muted);font-size:12px}.empty strong{display:block;margin-bottom:4px;color:var(--ink);font-size:13px}
.selected-address{color:#116c4c;font-size:12px;overflow-wrap:anywhere;margin:7px 0 0}
.code-row{display:flex;align-items:center;gap:9px;margin:12px 0 5px;flex-wrap:wrap}.otp-code{display:inline-block;font-size:21px;letter-spacing:3px;font-weight:750;background:#eaf5ee;border:1px solid #c9e4d2;color:#075e44;border-radius:8px;padding:6px 10px}
.message-card .muted{margin:5px 0;font-size:11px}.message-body{margin-top:10px;padding-top:9px;border-top:1px solid #edf0ed}.message-body summary{cursor:pointer;color:var(--muted);font-size:11px;width:max-content}.body-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:230px;overflow:auto;background:#f6f8f6;border-radius:8px;padding:10px;margin:8px 0 0;font:11px/1.55 ui-monospace,monospace;color:#35443a}
.footnote{color:var(--muted);font-size:11px;line-height:1.65;margin:22px 0 0}
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
.settings-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px}
.settings-card summary{cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:13px;font-weight:700;list-style:none}
.settings-card summary::-webkit-details-marker{display:none}.settings-card summary:after{content:"+";color:var(--muted);font-size:18px;font-weight:400}.settings-card[open] summary:after{content:"−"}
.settings-content{padding-top:12px}.settings-content p{font-size:11px;line-height:1.55}.settings-content code,.settings-content pre{overflow-wrap:anywhere;white-space:pre-wrap}
.settings-content .button{margin-top:8px}.settings-content form{margin-top:11px}
@media(max-width:900px){.grid{grid-template-columns:1fr}.settings-grid{grid-template-columns:1fr 1fr}}
@media(max-width:620px){main{width:calc(100% - 24px);padding:18px 0 38px}.brand{margin-bottom:26px}.topbar{align-items:flex-start;flex-direction:column}.top-actions{width:100%}.top-actions button{flex:1}.stats{margin:12px 0}.stat{flex:1;min-width:120px}.create-row{grid-template-columns:1fr 1fr}.create-row .submit-cell{grid-column:1/-1}.create-row .submit-cell button{width:100%}.settings-grid{grid-template-columns:1fr}.panel{padding:16px}}
@media(max-width:390px){.create-row{grid-template-columns:1fr}.create-row .submit-cell{grid-column:auto}.panel-heading{display:block}.panel-heading p{margin-top:5px}}
`;
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f4f6f4"><title>SeitonMail · Panel Owner</title>
<style nonce="${nonce}">${styles}</style></head><body><main>
<header class="brand"><span class="mark">S</span><span><strong>SeitonMail</strong><small>Panel pengelola</small></span></header>
<section id="auth" class="panel auth">
  <div class="auth-heading"><span class="eyebrow">AKSES PRIVAT</span><h1>Masuk ke panel</h1><p>Kelola alamat email dan pesan masuk dari satu tempat.</p></div>
  <form id="setupForm" hidden>
    <label for="bootstrapToken">Bootstrap token sekali pakai</label><input id="bootstrapToken" type="password" autocomplete="off" required>
    <label for="setupPassword">Buat password Owner</label><input id="setupPassword" type="password" minlength="16" maxlength="128" autocomplete="new-password" required>
    <p class="muted-note">Gunakan password minimal 16 karakter. Token inisialisasi hanya digunakan sekali.</p>
    <button class="button" type="submit">Siapkan panel</button>
  </form>
  <form id="loginForm" hidden>
    <div id="loginPasswordGroup"><label for="loginPassword">Password Owner</label><input id="loginPassword" type="password" autocomplete="current-password" required></div>
    <div id="loginTotpGroup" hidden><label for="loginTotpCode">Kode autentikator atau recovery code</label><input id="loginTotpCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="32" placeholder="Kode 6 digit atau recovery code"></div>
    <button id="loginButton" class="button" type="submit">Masuk</button>
  </form>
  <div id="authStatus" class="status" role="status" aria-live="polite"></div>
  <p class="muted-note">Halaman ini hanya untuk pengelola. Agent terhubung menggunakan token terpisah, bukan akun Owner.</p>
</section>
<section id="dashboard" hidden>
  <div class="topbar"><div><span class="eyebrow">PENGELOLAAN EMAIL</span><h1>Mailbox</h1><p>Buat alamat, salin untuk digunakan, lalu pantau pesan masuk.</p></div>
    <div class="top-actions"><button id="refresh" class="button secondary" type="button">Perbarui inbox</button><button id="logout" class="button danger" type="button">Keluar</button></div>
  </div>
  <div id="dashboardStatus" class="status" role="status" aria-live="polite"></div>
  <div class="stats"><div class="stat"><strong id="aliasCount">0</strong><span>mailbox aktif</span></div><div class="stat"><strong id="messageCount">0</strong><span>pesan di inbox terpilih</span></div><div class="stat"><span id="lastDashboardRefresh">Belum diperbarui</span></div></div>
  <div class="grid">
    <section class="panel">
      <div class="panel-heading"><div><h2>Buat mailbox</h2><p>Alamat akan disalin otomatis setelah dibuat.</p></div></div>
      <form id="createAlias" class="create-row">
        <div><label for="aliasLabel">Nama atau label <span class="muted">(opsional)</span></label><input id="aliasLabel" maxlength="80" placeholder="Contoh: Verifikasi akun"></div>
        <div><label for="aliasTtl">Masa aktif</label><select id="aliasTtl"><option value="600">10 menit</option><option value="3600">1 jam</option><option value="21600">6 jam</option><option value="43200">12 jam</option><option value="86400" selected>1 hari</option><option value="259200">3 hari</option><option value="604800">7 hari</option><option value="1209600">14 hari</option><option value="2592000">30 hari</option></select></div>
        <div class="submit-cell"><label>&nbsp;</label><button class="button" type="submit">Buat alamat</button></div>
      </form>
      <p class="helper">Maksimal 100 email per mailbox. Pesan dihapus saat mailbox kedaluwarsa atau dicabut.</p>
      <div class="search-wrap"><label for="mailboxSearch">Cari alamat atau label</label><input id="mailboxSearch" type="search" placeholder="Ketik untuk mencari…" autocomplete="off"></div>
      <div id="aliases" class="alias-list"><p class="empty">Memuat mailbox…</p></div>
    </section>
    <section class="panel">
      <div class="panel-heading"><div><h2>Pesan masuk</h2><p id="selectedAddress" class="selected-address">Pilih mailbox untuk melihat pesan.</p></div></div>
      <div id="messages" class="message-list"><p class="empty">Pilih mailbox di sebelah kiri.</p></div>
    </section>
  </div>
  <div class="settings-grid">
    <details class="settings-card">
      <summary>Keamanan Owner dan 2FA</summary>
      <div class="settings-content">
        <p id="twoFactorStatus" class="muted">Memeriksa status 2FA…</p>
        <button id="enableTwoFactor" class="button secondary" type="button">Aktifkan 2FA</button>
        <div id="twoFactorEnrollment" hidden>
          <p class="muted">Tambahkan kunci ini di aplikasi autentikator, lalu konfirmasi dengan kode terbaru.</p>
          <label>Kunci rahasia TOTP</label><code id="twoFactorSecret" class="address"></code><button id="copyTwoFactorSecret" class="button secondary small" type="button">Salin kunci</button>
          <label>URI otpauth</label><code id="twoFactorUri" class="address"></code><button id="copyTwoFactorUri" class="button secondary small" type="button">Salin URI</button>
          <form id="confirmTwoFactorForm"><label for="twoFactorCode">Kode 6 digit</label><input id="twoFactorCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required><button class="button" type="submit">Konfirmasi 2FA</button></form>
        </div>
        <div id="recoveryCodesPanel" hidden><p><strong>Simpan recovery codes di tempat aman.</strong> Setiap kode hanya dapat digunakan sekali.</p><pre id="recoveryCodes" class="body-preview"></pre><button id="copyRecoveryCodes" class="button secondary small" type="button">Salin recovery codes</button></div>
        <form id="disableTwoFactorForm" hidden><label for="disableTwoFactorPassword">Password Owner</label><input id="disableTwoFactorPassword" type="password" autocomplete="current-password" required><label for="disableTwoFactorCode">Kode TOTP atau recovery code</label><input id="disableTwoFactorCode" type="text" autocomplete="one-time-code" required><button class="button danger" type="submit">Nonaktifkan 2FA</button></form>
      </div>
    </details>
    <details class="settings-card">
      <summary>Akses agent</summary>
      <div class="settings-content">
        <p class="muted">Buat token terpisah untuk setiap agent. Secret hanya ditampilkan satu kali.</p>
        <form id="createMachineTokenForm"><label for="machineTokenLabel">Nama agent</label><input id="machineTokenLabel" maxlength="60" placeholder="Contoh: Cue CEO" required><button class="button" type="submit">Buat token agent</button></form>
        <div id="newMachineTokenPanel" hidden><p><strong>Token baru · salin sekarang</strong></p><code id="newMachineTokenSecret" class="address"></code><button id="copyNewMachineToken" class="button secondary small" type="button">Salin token</button><p class="muted">Simpan di secret vault agent. Token tidak dapat ditampilkan kembali.</p></div>
        <div id="machineTokenList" class="alias-list"></div>
      </div>
    </details>
  </div>
  <p class="footnote">SeitonMail menerima email masuk saja. Lampiran tidak disimpan. Gunakan alamat sementara untuk pengujian dan verifikasi yang sah, bukan untuk pemulihan akun penting atau informasi finansial.</p>
</section>
</main><script nonce="${nonce}">window.MAIL_SETUP_MODE=${mode};</script><script nonce="${nonce}">${CLIENT_SCRIPT}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    }
  });
}
async function handlePanel(request, env) {
  const nonce = randomHex(32);
  const html = renderPanel(nonce, await hasOwner(env));
  return new Response(html, {
    status: 200,
    headers: securityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    })
  });
}

async function handleInboundEmail(message, env) {
  if (!env.MAIL_DB) {
    message.setReject("Mail storage is not configured");
    return;
  }
  if (Number(message.rawSize || 0) > MAX_RAW_BYTES) {
    message.setReject("Message exceeds the permitted size");
    return;
  }
  const recipient = parseAliasRecipient(message.to);
  if (!recipient) {
    message.setReject("Unknown mailbox");
    return;
  }
  const now = Date.now();
  const alias = await env.MAIL_DB.prepare(
    "SELECT id FROM mail_aliases WHERE slug=? AND status='ACTIVE' AND expires_at>? AND received_count<? LIMIT 1"
  ).bind(recipient.slug, now, MAX_MESSAGES_PER_ALIAS).first();
  if (!alias) {
    message.setReject("Mailbox is inactive or expired");
    return;
  }
  const raw = await new Response(message.raw).text();
  if (raw.length > MAX_RAW_BYTES) {
    message.setReject("Message exceeds the permitted size");
    return;
  }
  const parsed = parseEmail(raw);
  const sender = clean(message.from || parsed.from, 254);
  const subject = clean(parsed.subject || "(Tanpa subjek)", 300);
  const body = clean(parsed.text || "", MAX_BODY_CHARS);
  const code = extractVerificationCode(subject, parsed.searchText || body);
  const originalMessageId = clean(message.headers.get("message-id") || "", 300) ||
    recipient.address + ":" + sender + ":" + subject + ":" + String(now) + ":" + body.slice(0, 300);
  const messageId = await sha256Hex(originalMessageId);
  const encrypted = await encryptMessagePayload(env, alias.id, {
    sender,
    recipient: recipient.address,
    subject,
    body_text: body,
    verification_code: code || null
  });
  const active = await env.MAIL_DB.prepare(
    "UPDATE mail_aliases SET received_count=received_count+1,last_received_at=? " +
    "WHERE id=? AND status='ACTIVE' AND expires_at>? AND received_count<? RETURNING id"
  ).bind(now, alias.id, now, MAX_MESSAGES_PER_ALIAS).first();
  if (!active) {
    message.setReject("Mailbox is inactive or expired");
    return;
  }
  await env.MAIL_DB.prepare(
    "INSERT INTO mail_messages(id,alias_id,sender,recipient,subject,body_text,verification_code,message_id,received_at,payload_iv,payload_ciphertext) " +
    "VALUES(?,?,'','','','',NULL,?,?,?,?) ON CONFLICT(alias_id,message_id) DO NOTHING"
  ).bind(
    crypto.randomUUID(),
    alias.id,
    messageId,
    now,
    encrypted.iv,
    encrypted.ciphertext
  ).run();
}

async function scheduledCleanup(env) {
  const now = Date.now();
  const messageRetentionCutoff = now - 30 * 24 * 60 * 60 * 1000;
  const mailboxRetentionCutoff = now - EXPIRED_MAILBOX_RETENTION_MS;
  const inactiveMailboxSql = "SELECT id FROM mail_aliases WHERE status!='ACTIVE' OR expires_at<=?";

  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare("UPDATE mail_aliases SET status='EXPIRED' WHERE status='ACTIVE' AND expires_at<=?").bind(now),

    // Remove message payloads and public inbox credentials as soon as a mailbox expires or is revoked.
    // Keep mailbox metadata for a seven-day grace period for diagnostics and clientRef conflict handling.
    env.MAIL_DB.prepare("DELETE FROM mail_messages WHERE alias_id IN (" + inactiveMailboxSql + ")").bind(now),
    env.MAIL_DB.prepare("DELETE FROM mail_public_sessions WHERE alias_id IN (" + inactiveMailboxSql + ")").bind(now),
    env.MAIL_DB.prepare("DELETE FROM mail_public_mailboxes WHERE alias_id IN (" + inactiveMailboxSql + ")").bind(now),
    env.MAIL_DB.prepare("DELETE FROM mail_public_login_attempts WHERE alias_id IN (" + inactiveMailboxSql + ")").bind(now),

    env.MAIL_DB.prepare("DELETE FROM mail_messages WHERE received_at<?").bind(messageRetentionCutoff),
    env.MAIL_DB.prepare("DELETE FROM mail_aliases WHERE expires_at<? AND status!='ACTIVE'").bind(mailboxRetentionCutoff),
    env.MAIL_DB.prepare("DELETE FROM mail_sessions WHERE expires_at<=?").bind(now),
    env.MAIL_DB.prepare("DELETE FROM mail_public_sessions WHERE expires_at<=?").bind(now),
    env.MAIL_DB.prepare("DELETE FROM mail_public_creation_limits WHERE window_started_at<?").bind(now - PUBLIC_CREATE_WINDOW_MS * 2),
    env.MAIL_DB.prepare("DELETE FROM mail_public_login_attempts WHERE window_started_at<?").bind(now - PUBLIC_LOGIN_WINDOW_MS * 2),
    env.MAIL_DB.prepare("DELETE FROM mail_login_challenges WHERE expires_at<=?").bind(now),
    env.MAIL_DB.prepare("UPDATE mail_admin SET totp_pending_iv=NULL,totp_pending_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_attempts=0 WHERE totp_pending_expires_at IS NOT NULL AND totp_pending_expires_at<=?").bind(now),
    env.MAIL_DB.prepare("DELETE FROM mail_login_attempts WHERE window_started_at<?").bind(now - LOGIN_WINDOW_MS * 2),
    env.MAIL_DB.prepare("DELETE FROM mail_machine_aliases WHERE alias_id NOT IN (SELECT id FROM mail_aliases)"),
    env.MAIL_DB.prepare("DELETE FROM mail_machine_rate_limits WHERE window_started_at<?").bind(now - MACHINE_API_RATE_WINDOW_MS * 2)
  ]);
}

export {
  decryptMessagePayload,
  encryptMessagePayload,
  extractVerificationCode,
  parseAliasRecipient,
  mailboxAddress,
  parseBearerToken,
  passwordHash,
  randomHex,
  isAllowedMailboxTtl,
  isMailboxActive,
  MAILBOX_TTL_OPTIONS_SECONDS
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return responseJson({ ok: true, service: "seiton-mail-automation" });
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" })
      });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (error) {
        const code = error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message)
          ? error.message
          : "INTERNAL_ERROR";
        console.error(JSON.stringify({
          level: "error",
          event: "mail_api_error",
          code,
          errorName: error instanceof Error ? error.name : "UnknownError",
          detail: error instanceof Error ? String(error.message).slice(0, 160) : "NonErrorThrowable",
          stack: error instanceof Error && error.stack ? String(error.stack).slice(0, 700) : undefined
        }));
        return responseJson({ ok: false, error: "Permintaan tidak dapat diproses." }, 500);
      }
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/inbox/"))) {
      const nonce = randomHex(32);
      return renderPublicPage(nonce);
    }
    if (request.method === "GET" && (url.pathname === "/owner" || url.pathname === "/login")) {
      try { return await handlePanel(request, env); }
      catch (error) {
        console.error(JSON.stringify({ level: "error", event: "mail_panel_error", name: error?.name || "Error" }));
        return responseJson({ ok: false, error: "Panel belum siap." }, 503);
      }
    }
    return responseJson({ ok: false, error: "Not found" }, 404);
  },

  async email(message, env) {
    try {
      await handleInboundEmail(message, env);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "mail_ingest_failed",
        name: error instanceof Error ? error.name : "UnknownError"
      }));
      message.setReject("Unable to process this message");
    }
  },

  async scheduled(controller, env) {
    try {
      await scheduledCleanup(env);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "mail_cleanup_failed",
        name: error instanceof Error ? error.name : "UnknownError"
      }));
    }
  }
};

