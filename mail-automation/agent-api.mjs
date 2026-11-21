import {
  MAX_BODY_CHARS, DEFAULT_MAILBOX_TTL_SECONDS,
  MACHINE_API_RATE_WINDOW_MS, MACHINE_API_RATE_LIMIT, MACHINE_ALIAS_HOURLY_LIMIT,
  isAllowedMailboxTtl, isMailboxActive, responseJson, clean, randomHex,
  mailboxAddress, sha256Hex, constantTimeEqual, decryptMessagePayload, readJson
} from "./core.mjs";
import { hasOwner } from "./owner-api.mjs";

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

export {
  parseBearerToken,
  handleMachineApi
};
