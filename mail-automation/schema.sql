PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mail_admin (
  id TEXT PRIMARY KEY CHECK (id = 'owner'),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_sessions (
  session_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_sessions_expiry ON mail_sessions(expires_at);

CREATE TABLE IF NOT EXISTS mail_login_attempts (
  ip_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mail_aliases (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_received_at INTEGER,
  received_count INTEGER NOT NULL DEFAULT 0 CHECK (received_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_mail_aliases_status_expiry ON mail_aliases(status, expires_at DESC);

CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  verification_code TEXT,
  message_id TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  UNIQUE(alias_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_alias_received ON mail_messages(alias_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_messages_received ON mail_messages(received_at DESC);
