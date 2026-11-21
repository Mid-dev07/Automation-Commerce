import {
  MAX_BODY_CHARS, PUBLIC_TEMP_TTL_SECONDS, PUBLIC_CUSTOM_TTL_SECONDS,
  PUBLIC_SESSION_TTL_SECONDS, PUBLIC_CREATE_LIMIT, PUBLIC_CREATE_WINDOW_MS,
  PUBLIC_LOGIN_MAX_ATTEMPTS, PUBLIC_LOGIN_WINDOW_MS,
  responseJson, clean, randomHex, isCustomLocalPart, mailboxAddress,
  sha256Hex, constantTimeEqual, bytesToBase64, base64ToBytes,
  decryptMessagePayload, passwordHash, getCookie, isSameOrigin, readJson
} from "./core.mjs";
import { hasOwner, loginIpHash } from "./owner-api.mjs";

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


export {
  handlePublicMailboxCreate,
  handlePublicMailboxUnlock,
  handlePublicInboxGet,
  handlePublicMailboxLogout
};
