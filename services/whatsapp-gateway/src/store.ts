import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface OutboundPayload {
  jid: string;
  text: string;
}

interface EncryptedValue {
  iv: string;
  ciphertext: string;
  tag: string;
  keyVersion: number;
}

export class GatewayStore {
  private readonly db: Database.Database;
  private readonly encryptionKey: Buffer;

  constructor(databasePath: string, encryptionKey: Buffer) {
    if (encryptionKey.length !== 32) throw new Error("Encryption key must be 32 bytes.");
    mkdirSync(dirname(databasePath), { recursive: true });
    this.encryptionKey = encryptionKey;
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS auth_records (" +
      "record_key TEXT PRIMARY KEY, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, " +
      "auth_tag TEXT NOT NULL, key_version INTEGER NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS inbound_events (" +
      "event_id TEXT PRIMARY KEY, chat_hash TEXT NOT NULL, status TEXT NOT NULL, " +
      "received_at TEXT NOT NULL, processed_at TEXT, error_code TEXT);" +
      "CREATE TABLE IF NOT EXISTS outbound_jobs (" +
      "action_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, chat_hash TEXT NOT NULL, " +
      "iv TEXT NOT NULL, ciphertext TEXT NOT NULL, auth_tag TEXT NOT NULL, " +
      "key_version INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, " +
      "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT);" +
      "CREATE INDEX IF NOT EXISTS idx_outbound_jobs_status ON outbound_jobs(status, created_at);" +
      "CREATE TABLE IF NOT EXISTS conversation_controls (" +
      "chat_hash TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'BOT', " +
      "opted_out_at TEXT, updated_at TEXT NOT NULL);"
    );
  }

  private encrypt(recordKey: string, value: unknown): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(recordKey, "utf8"));
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      keyVersion: 1
    };
  }

  private decrypt<T>(recordKey: string, encrypted: EncryptedValue): T {
    if (encrypted.keyVersion !== 1) throw new Error("Unsupported encrypted record version.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(encrypted.iv, "base64")
    );
    decipher.setAAD(Buffer.from(recordKey, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }

  getEncryptedJson<T>(recordKey: string): T | null {
    const row = this.db.prepare(
      "SELECT iv,ciphertext,auth_tag,key_version FROM auth_records WHERE record_key=?"
    ).get(recordKey) as {
      iv: string; ciphertext: string; auth_tag: string; key_version: number;
    } | undefined;

    if (!row) return null;
    return this.decrypt<T>(recordKey, {
      iv: row.iv, ciphertext: row.ciphertext, tag: row.auth_tag, keyVersion: row.key_version
    });
  }

  setEncryptedJson(recordKey: string, value: unknown): void {
    const encrypted = this.encrypt(recordKey, value);
    this.db.prepare(
      "INSERT INTO auth_records(record_key,iv,ciphertext,auth_tag,key_version,updated_at) " +
      "VALUES(?,?,?,?,?,?) ON CONFLICT(record_key) DO UPDATE SET " +
      "iv=excluded.iv,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag," +
      "key_version=excluded.key_version,updated_at=excluded.updated_at"
    ).run(
      recordKey, encrypted.iv, encrypted.ciphertext, encrypted.tag,
      encrypted.keyVersion, new Date().toISOString()
    );
  }

  deleteEncryptedJson(recordKey: string): void {
    this.db.prepare("DELETE FROM auth_records WHERE record_key=?").run(recordKey);
  }

  claimInbound(eventId: string, chatHash: string): boolean {
    const result = this.db.prepare(
      "INSERT OR IGNORE INTO inbound_events(event_id,chat_hash,status,received_at) " +
      "VALUES(?,?,'PROCESSING',?)"
    ).run(eventId, chatHash, new Date().toISOString());
    return result.changes === 1;
  }

  completeInbound(eventId: string): void {
    this.db.prepare(
      "UPDATE inbound_events SET status='PROCESSED',processed_at=?,error_code=NULL WHERE event_id=?"
    ).run(new Date().toISOString(), eventId);
  }

  failInbound(eventId: string, errorCode: string): void {
    this.db.prepare(
      "UPDATE inbound_events SET status='FAILED',processed_at=?,error_code=? WHERE event_id=?"
    ).run(new Date().toISOString(), errorCode.slice(0, 80), eventId);
  }

  setConversationMode(chatHash: string, mode: "BOT" | "HUMAN" | "OPTED_OUT"): void {
    const optedOutAt = mode === "OPTED_OUT" ? new Date().toISOString() : null;
    this.db.prepare(
      "INSERT INTO conversation_controls(chat_hash,mode,opted_out_at,updated_at) VALUES(?,?,?,?) " +
      "ON CONFLICT(chat_hash) DO UPDATE SET mode=excluded.mode," +
      "opted_out_at=excluded.opted_out_at,updated_at=excluded.updated_at"
    ).run(chatHash, mode, optedOutAt, new Date().toISOString());
  }

  getConversationMode(chatHash: string): "BOT" | "HUMAN" | "OPTED_OUT" {
    const row = this.db.prepare(
      "SELECT mode FROM conversation_controls WHERE chat_hash=?"
    ).get(chatHash) as { mode: string } | undefined;
    if (!row) return "BOT";
    if (row.mode === "HUMAN" || row.mode === "OPTED_OUT") return row.mode;
    return "BOT";
  }

  enqueueOutbound(actionId: string, eventId: string, chatHash: string, payload: OutboundPayload): void {
    const encrypted = this.encrypt("outbound:" + actionId, payload);
    this.db.prepare(
      "INSERT OR IGNORE INTO outbound_jobs(action_id,event_id,chat_hash,iv,ciphertext,auth_tag," +
      "key_version,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'PENDING',?,?)"
    ).run(
      actionId, eventId, chatHash, encrypted.iv, encrypted.ciphertext, encrypted.tag,
      encrypted.keyVersion, new Date().toISOString(), new Date().toISOString()
    );
  }

  nextPendingOutbound(): { actionId: string; payload: OutboundPayload } | null {
    const row = this.db.prepare(
      "SELECT action_id,iv,ciphertext,auth_tag,key_version FROM outbound_jobs " +
      "WHERE status='PENDING' ORDER BY created_at LIMIT 1"
    ).get() as {
      action_id: string; iv: string; ciphertext: string; auth_tag: string; key_version: number;
    } | undefined;

    if (!row) return null;
    const payload = this.decrypt<OutboundPayload>("outbound:" + row.action_id, {
      iv: row.iv, ciphertext: row.ciphertext, tag: row.auth_tag, keyVersion: row.key_version
    });
    return { actionId: row.action_id, payload };
  }

  markOutboundAttempting(actionId: string): boolean {
    const result = this.db.prepare(
      "UPDATE outbound_jobs SET status='ATTEMPTING',attempts=attempts+1,updated_at=? " +
      "WHERE action_id=? AND status='PENDING'"
    ).run(new Date().toISOString(), actionId);
    return result.changes === 1;
  }

  markOutbound(actionId: string, status: "SUBMITTED" | "FAILED" | "UNKNOWN", errorCode?: string): void {
    this.db.prepare(
      "UPDATE outbound_jobs SET status=?,error_code=?,updated_at=? WHERE action_id=?"
    ).run(status, errorCode ? errorCode.slice(0, 80) : null, new Date().toISOString(), actionId);
  }

  recoverAfterRestart(): void {
    this.db.prepare(
      "UPDATE outbound_jobs SET status='UNKNOWN',error_code='PROCESS_RESTART_DURING_SEND',updated_at=? " +
      "WHERE status='ATTEMPTING'"
    ).run(new Date().toISOString());
    this.db.prepare(
      "UPDATE inbound_events SET status='FAILED',error_code='PROCESS_RESTART_DURING_EVENT',processed_at=? " +
      "WHERE status='PROCESSING'"
    ).run(new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
