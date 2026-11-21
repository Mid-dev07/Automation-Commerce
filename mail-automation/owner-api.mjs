import { generateTotpSecret, verifyTotp } from "./totp.mjs";
import {
  SESSION_TTL_SECONDS, LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS, LOGIN_CHALLENGE_TTL_MS,
  TOTP_ENROLLMENT_TTL_MS, TOTP_RECOVERY_CODE_COUNT, DEFAULT_MAILBOX_TTL_SECONDS,
  isAllowedMailboxTtl, isMailboxActive, responseJson, clean, randomHex, mailboxAddress,
  sha256Hex, constantTimeEqual, bytesToBase64, base64ToBytes, decryptMessagePayload,
  passwordHash, getCookie, sessionCookie, clearedSessionCookie, loginChallengeCookie,
  clearedLoginChallengeCookie, isSameOrigin, readJson, encryptTotpSecret,
  decryptTotpSecret, recoveryCodeHash, consumeRecoveryCode, verifyOwnerTotp
} from "./core.mjs";

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



export {
  hasOwner,
  loginIpHash,
  currentSession,
  requireSession,
  handleSetup,
  handleLogin,
  handleLoginTwoFactor,
  handleLogout,
  handleTwoFactorStatus,
  handleTwoFactorEnroll,
  handleTwoFactorConfirm,
  handleTwoFactorDisable,
  handleMachineTokensList,
  handleMachineTokenCreate,
  handleMachineTokenRevoke,
  handleAliasesGet,
  handleAliasCreate,
  handleAliasRevoke,
  handleMessagesGet,
  handleMessageDelete
};
