import { parseEmail } from "./email-parser.js";
import { extractVerificationCode } from "./otp-extractor.js";
import {
  MAX_RAW_BYTES, MAX_BODY_CHARS, MAX_MESSAGES_PER_ALIAS,
  LOGIN_WINDOW_MS, PUBLIC_CREATE_WINDOW_MS, PUBLIC_LOGIN_WINDOW_MS,
  EXPIRED_MAILBOX_RETENTION_MS, MACHINE_API_RATE_WINDOW_MS,
  clean, sha256Hex, encryptMessagePayload, parseAliasRecipient
} from "./core.mjs";

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
  handleInboundEmail,
  scheduledCleanup
};
