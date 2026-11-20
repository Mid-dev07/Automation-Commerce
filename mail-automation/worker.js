import { parseEmail } from "./email-parser.js";
import { extractVerificationCode } from "./otp-extractor.js";

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
const ALLOWED_TTLS = new Set([600]); // T-Mail mailboxes expire after ten minutes.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function responseJson(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      ...headers
    }
  });
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

function mailboxAddress(slug) {
  const value = clean(slug, 64).toLowerCase();
  if (/^[a-f0-9]{24}$/.test(value)) return BASE_LOCAL_PART + "+" + value + "@" + MAIL_DOMAIN;
  if (/^[a-f0-9]{32}$/.test(value)) return value + "@" + MAIL_DOMAIN;
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

  // Prefixless TMail addresses are issued only on the primary mail domain.
  if (recipientDomain !== MAIL_DOMAIN || !/^[a-f0-9]{32}$/.test(localPart)) return null;
  return {
    slug: localPart,
    address: normalized,
    format: "tmail"
  };
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
    "SELECT password_salt,password_hash FROM mail_admin WHERE id='owner' LIMIT 1"
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
  await env.MAIL_DB.prepare("DELETE FROM mail_login_attempts WHERE ip_hash=?").bind(lock.ipHash).run();
  const token = await createSession(env);
  return responseJson({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function handleLogout(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  const session = await currentSession(request, env);
  if (session) {
    await env.MAIL_DB.prepare("DELETE FROM mail_sessions WHERE session_hash=?").bind(session.tokenHash).run();
  }
  return responseJson({ ok: true }, 200, { "Set-Cookie": clearedSessionCookie() });
}

async function handleAliasesGet(env) {
  const result = await env.MAIL_DB.prepare(
    "SELECT id,slug,label,status,created_at,expires_at,last_received_at,received_count " +
    "FROM mail_aliases ORDER BY created_at DESC LIMIT 100"
  ).all();
  const mailboxes = result.results || [];
  return responseJson({ ok: true, mailboxes, aliases: mailboxes });
}

async function handleAliasCreate(request, env) {
  if (!isSameOrigin(request)) return responseJson({ ok: false, error: "Origin tidak valid." }, 403);
  let body;
  try { body = await readJson(request); }
  catch { return responseJson({ ok: false, error: "Data mailbox tidak valid." }, 400); }
  const label = clean(body.label, 80);
  const ttlSeconds = Number(body.ttlSeconds ?? 600);
  if (!ALLOWED_TTLS.has(ttlSeconds)) {
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
  // TMail mailboxes are unreadable after their 10-minute TTL. Legacy aliases retain
  // their previous owner-inbox behavior until the existing 30-day cleanup removes them.
  const isTMailMailbox = /^[a-f0-9]{32}$/.test(String(alias.slug || ""));
  if (isTMailMailbox && (alias.status !== "ACTIVE" || Number(alias.expires_at) <= Date.now())) {
    return responseJson({ ok: false, error: "Mailbox sudah kedaluwarsa." }, 410);
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
  if (!env.MAIL_VM_API_TOKEN || !env.MAIL_DB) {
    return { response: responseJson({ ok: false, error: "Machine API belum dikonfigurasi." }, 503) };
  }
  const supplied = parseBearerToken(request);
  if (!supplied || !constantTimeEqual(supplied, env.MAIL_VM_API_TOKEN)) {
    return { response: responseJson({ ok: false, error: "Token API tidak valid." }, 401) };
  }

  const tokenHash = await sha256Hex(env.MAIL_VM_API_TOKEN);
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

  const ttlSeconds = Number(body.ttlSeconds ?? 600);
  if (!ALLOWED_TTLS.has(ttlSeconds)) {
    return responseJson({ ok: false, error: "Masa aktif mailbox tidak valid." }, 400);
  }
  const rawClientRef = body.clientRef == null ? "" : String(body.clientRef);
  const clientRef = clean(rawClientRef, 100);
  if (clientRef && (!/^[A-Za-z0-9._:-]{1,100}$/.test(clientRef) || clientRef !== rawClientRef.trim())) {
    return responseJson({ ok: false, error: "clientRef hanya boleh berisi huruf, angka, titik, garis bawah, titik dua, dan tanda hubung." }, 400);
  }

  if (clientRef) {
    const existing = await env.MAIL_DB.prepare(
      "SELECT a.id,a.slug,a.label,a.status,a.created_at,a.expires_at,a.received_count " +
      "FROM mail_machine_aliases m JOIN mail_aliases a ON a.id=m.alias_id " +
      "WHERE m.client_ref=? AND m.token_hash=? LIMIT 1"
    ).bind(clientRef, tokenHash).first();
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
    ).bind(id, clientRef || null, tokenHash, now)
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
    status: row.status === "ACTIVE" && Number(row.expires_at) <= now ? "EXPIRED" : row.status,
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
  if (request.method === "GET" && url.pathname === "/api/session") {
    return responseJson({
      ok: true,
      configured: await hasOwner(env),
      authenticated: Boolean(await currentSession(request, env))
    });
  }
  if (request.method === "POST" && url.pathname === "/api/setup") return handleSetup(request, env);
  if (request.method === "POST" && url.pathname === "/api/login") return handleLogin(request, env);
  if (request.method === "POST" && url.pathname === "/api/logout") return handleLogout(request, env);

  const session = await requireSession(request, env);
  if (!session) return responseJson({ ok: false, error: "Sesi admin tidak valid atau sudah berakhir." }, 401);

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
    await navigator.clipboard.writeText(value);
    setStatus("Berhasil disalin.");
  } catch {
    setStatus("Clipboard tidak tersedia pada browser ini.", true);
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
  statusBox = byId("authStatus");
  byId("auth").hidden = false;
  byId("dashboard").hidden = true;
  byId("setupForm").hidden = configured;
  byId("loginForm").hidden = !configured;
  setStatus(configured ? "Masuk untuk membuka panel privat." : "Setup awal: gunakan bootstrap token yang diberikan owner.");
}
function showDashboard() {
  statusBox = byId("dashboardStatus");
  byId("auth").hidden = true;
  byId("dashboard").hidden = false;
  setStatus("Panel TMail terhubung. Mailbox dan pesan tersimpan di database privat.");
  loadAliases().catch((error) => setStatus(error.message, true));
}
function renderAliases() {
  const target = byId("aliases");
  target.replaceChildren();
  if (!aliasCache.length) {
    target.append(element("p", "empty", "Belum ada mailbox. Buat mailbox pertama."));
    return;
  }
  for (const alias of aliasCache) {
    const card = element("article", "alias-card");
    const heading = element("div", "alias-heading");
    const title = element("strong", "", alias.label || "Mailbox tanpa label");
    const state = element("span", "state " + String(alias.status).toLowerCase(), alias.status);
    heading.append(title, state);
    const address = element("code", "address", emailFor(alias));
    const detail = element("p", "muted", "Berakhir: " + formatDate(alias.expires_at) + " • Email: " + alias.received_count);
    const actions = element("div", "alias-actions");
    const copy = element("button", "button small", "Salin alamat");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(emailFor(alias)));
    const open = element("button", "button secondary small", "Lihat inbox");
    open.type = "button";
    open.addEventListener("click", () => selectAlias(alias.id));
    actions.append(copy, open);
    if (alias.status === "ACTIVE" && Number(alias.expires_at) > Date.now()) {
      const revoke = element("button", "button danger small", "Cabut");
      revoke.type = "button";
      revoke.addEventListener("click", () => revokeAlias(alias.id));
      actions.append(revoke);
    }
    card.append(heading, address, detail, actions);
    target.append(card);
  }
}
async function loadAliases() {
  const data = await api("/api/mailboxes");
  aliasCache = data.mailboxes || data.aliases || [];
  renderAliases();
  byId("aliasCount").textContent = String(aliasCache.filter((item) => item.status === "ACTIVE" && Number(item.expires_at) > Date.now()).length);
  if (!selectedAliasId && aliasCache.length) {
    const first = aliasCache.find((item) => item.status === "ACTIVE" && Number(item.expires_at) > Date.now());
    if (first) await selectAlias(first.id);
  } else if (selectedAliasId) {
    await loadMessages(selectedAliasId);
  }
}
async function selectAlias(id) {
  selectedAliasId = id;
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
    const preview = element("pre", "body-preview", (item.body_text || "").slice(0, 1200));
    card.append(preview);
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
    await api("/api/login", { method: "POST", body: { password: byId("loginPassword").value } });
    byId("loginPassword").value = "";
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
    setStatus("Mailbox TMail dibuat dan disalin: " + data.mailbox.email);
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
  return "<!doctype html><html lang=\"id\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<meta name=\"robots\" content=\"noindex,nofollow\"><meta name=\"referrer\" content=\"no-referrer\">" +
    "<title>Seiton Mail Automation</title><style nonce=\"" + nonce + "\">" +
    " :root{color-scheme:dark;--bg:#080f1e;--surface:#111c2f;--surface2:#17243a;--line:#25354e;--text:#e7edf5;--muted:#9baabd;--accent:#10b981;--danger:#f87171}" +
    " *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0%,#182b43 0,transparent 32%),var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}" +
    " main{max-width:1180px;margin:0 auto;padding:34px 22px 60px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:28px}.mark{width:42px;height:42px;border-radius:13px;background:var(--accent);color:#06271e;display:grid;place-items:center;font-weight:900;font-size:20px}.brand small{display:block;color:var(--muted)}" +
    " h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:0 0 14px}.muted{color:var(--muted);font-size:13px}.panel{background:linear-gradient(180deg,var(--surface),#0e192b);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 48px #0003}" +
    " .auth{max-width:440px;margin:50px auto}.auth p{color:var(--muted)}label{display:block;color:#c6d1df;font-size:13px;margin:12px 0 6px}input,select{width:100%;background:#0b1526;border:1px solid var(--line);border-radius:10px;padding:12px;color:var(--text);font:inherit}button{cursor:pointer;font:inherit}.button{border:0;border-radius:10px;background:var(--accent);color:#06271e;font-weight:750;padding:10px 14px}.button.secondary{background:#26374e;color:var(--text)}.button.danger{background:#552f3a;color:#ffd8df}.button.small{padding:7px 10px;font-size:12px}.auth .button{width:100%;margin-top:18px}.status{min-height:24px;color:#9ce4c7;font-size:13px;margin:10px 0}.status.error{color:#fca5a5}.muted-note{color:var(--muted);font-size:12px;margin-top:14px}" +
    " .topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.topbar p{margin:0;color:var(--muted)}.top-actions{display:flex;gap:8px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:minmax(280px,.8fr) minmax(0,1.5fr);gap:18px}.panel+.panel{margin-top:18px}.create-row{display:grid;grid-template-columns:1fr 180px auto;gap:10px;align-items:end}.create-row label{margin-top:0}.alias-list,.message-list{display:grid;gap:10px;margin-top:14px}" +
    " .alias-card,.message-card{background:var(--surface2);border:1px solid var(--line);border-radius:13px;padding:14px;min-width:0}.alias-heading,.message-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.alias-heading strong,.message-top strong{overflow-wrap:anywhere}.state{font-size:10px;padding:3px 8px;border-radius:20px;background:#1a463b;color:#8df0cb}.state.expired,.state.revoked{background:#3d3340;color:#e8b7c6}.address{display:block;color:#a7f3d0;font-size:12px;overflow-wrap:anywhere;margin:10px 0}.alias-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.empty{color:var(--muted);padding:14px;text-align:center;border:1px dashed var(--line);border-radius:12px}.selected-address{font-size:12px;overflow-wrap:anywhere;color:#a7f3d0}" +
    " .code-row{display:flex;align-items:center;gap:12px;margin:14px 0}.otp-code{font-size:22px;letter-spacing:3px;background:#08291f;border:1px solid #1c614a;color:#9cf2ce;border-radius:10px;padding:8px 12px}.body-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;background:#0a1423;border-radius:9px;padding:10px;font:12px/1.5 ui-monospace,monospace;color:#cbd5e1}.message-card .muted{margin:7px 0}.footnote{color:var(--muted);font-size:12px;margin-top:22px;line-height:1.7}.stats{display:flex;gap:10px;margin:12px 0}.stat{background:#0b1526;border:1px solid var(--line);padding:8px 12px;border-radius:10px;color:var(--muted);font-size:12px}.stat strong{color:var(--text);font-size:16px;margin-right:5px}" +
    " @media(max-width:820px){main{padding:22px 14px 40px}.grid{grid-template-columns:1fr}.create-row{grid-template-columns:1fr 1fr}.create-row .submit-cell{grid-column:1/-1}.create-row .button{width:100%}.topbar{align-items:flex-start;flex-direction:column}}@media(max-width:420px){.create-row{grid-template-columns:1fr}.create-row .submit-cell{grid-column:auto}.panel{padding:16px}.top-actions{width:100%}.top-actions button{flex:1}}" +
    "</style></head><body><main><header class=\"brand\"><div class=\"mark\">S</div><div><strong>Seiton TMail</strong><small>Private temporary inbox · " + MAIL_DOMAIN + "</small></div></header>" +
    "<section id=\"auth\" class=\"panel auth\"><h1>Panel TMail privat</h1><p>Kelola mailbox sementara dan kode verifikasi yang masuk.</p>" +
    "<form id=\"setupForm\" hidden><label for=\"bootstrapToken\">Bootstrap token sekali pakai</label><input id=\"bootstrapToken\" type=\"password\" autocomplete=\"off\" required><label for=\"setupPassword\">Buat password owner (min. 16 karakter)</label><input id=\"setupPassword\" type=\"password\" minlength=\"16\" maxlength=\"128\" autocomplete=\"new-password\" required><button class=\"button\" type=\"submit\">Inisialisasi panel</button></form>" +
    "<form id=\"loginForm\" hidden><label for=\"loginPassword\">Password owner</label><input id=\"loginPassword\" type=\"password\" autocomplete=\"current-password\" required><button class=\"button\" type=\"submit\">Masuk</button></form>" +
    "<div id=\"authStatus\" class=\"status\" role=\"status\" aria-live=\"polite\"></div><div class=\"muted-note\">Panel hanya menerima email masuk. Ini bukan layanan IMAP/POP dan tidak mengirim email keluar.</div></section>" +
    "<section id=\"dashboard\" hidden><div class=\"topbar\"><div><h1>TMail inbox</h1><p>Buat mailbox acak, terima email dan kode verifikasi, lalu biarkan kedaluwarsa otomatis setelah 10 menit.</p></div><div class=\"top-actions\"><button id=\"refresh\" class=\"button secondary\" type=\"button\">Perbarui inbox</button><button id=\"logout\" class=\"button danger\" type=\"button\">Keluar</button></div></div>" +
    "<div id=\"dashboardStatus\" class=\"status\" role=\"status\" aria-live=\"polite\"></div>" +
    "<div class=\"stats\"><div class=\"stat\"><strong id=\"aliasCount\">0</strong> mailbox aktif</div><div class=\"stat\"><strong id=\"messageCount\">0</strong> pesan di mailbox terpilih</div></div>" +
    "<div class=\"grid\"><section class=\"panel\"><h2>Buat mailbox baru</h2><form id=\"createAlias\" class=\"create-row\"><div><label for=\"aliasLabel\">Label (opsional)</label><input id=\"aliasLabel\" maxlength=\"80\" placeholder=\"Contoh: akun layanan A\"></div><div><label for=\"aliasTtl\">Masa aktif</label><select id=\"aliasTtl\"><option value=\"600\" selected>10 menit</option></select></div><div class=\"submit-cell\"><label>&nbsp;</label><button class=\"button\" type=\"submit\">Buat TMail</button></div></form><p class=\"muted-note\">Alamat unik akan disalin otomatis setelah dibuat. Setiap mailbox maksimal menerima 100 pesan.</p><div id=\"aliases\" class=\"alias-list\"></div></section>" +
    "<section class=\"panel\"><h2>Pesan masuk</h2><p id=\"selectedAddress\" class=\"selected-address\">Pilih mailbox untuk melihat inbox.</p><div id=\"messages\" class=\"message-list\"><p class=\"empty\">Pilih mailbox di sebelah kiri.</p></div></section></div>" +
    "<p class=\"footnote\">Email untuk mailbox yang tidak dikenal atau sudah kedaluwarsa akan ditolak. Isi email dihapus saat mailbox berakhir. Lampiran belum disimpan. Jangan gunakan alamat ini untuk pemulihan akun kritis atau menerima informasi finansial penting.</p></section>" +
    "</main><script nonce=\"" + nonce + "\">window.MAIL_SETUP_MODE=" + mode + ";</script><script nonce=\"" + nonce + "\">" + CLIENT_SCRIPT + "</script></body></html>";
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
  const retentionCutoff = now - 30 * 24 * 60 * 60 * 1000;
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare("UPDATE mail_aliases SET status='EXPIRED' WHERE status='ACTIVE' AND expires_at<=?").bind(now),
    env.MAIL_DB.prepare("DELETE FROM mail_messages WHERE alias_id IN (SELECT id FROM mail_aliases WHERE length(slug)=32 AND expires_at<=?)").bind(now),
    env.MAIL_DB.prepare("DELETE FROM mail_messages WHERE received_at<?").bind(retentionCutoff),
    env.MAIL_DB.prepare("DELETE FROM mail_aliases WHERE expires_at<? AND status!='ACTIVE'").bind(retentionCutoff),
    env.MAIL_DB.prepare("DELETE FROM mail_sessions WHERE expires_at<=?").bind(now),
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
  randomHex
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
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
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

