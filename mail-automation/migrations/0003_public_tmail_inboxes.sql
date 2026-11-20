-- Public TMail inbox access. Owner and Machine API access models remain separate.
-- Every public mailbox has a per-mailbox password; plaintext secrets are never stored.
CREATE TABLE IF NOT EXISTS mail_public_mailboxes (
  alias_id TEXT PRIMARY KEY,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (alias_id) REFERENCES mail_aliases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mail_public_sessions (
  session_hash TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (alias_id) REFERENCES mail_aliases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mail_public_sessions_alias
  ON mail_public_sessions(alias_id, expires_at);

CREATE TABLE IF NOT EXISTS mail_public_creation_limits (
  ip_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0)
);

CREATE TABLE IF NOT EXISTS mail_public_login_attempts (
  ip_hash TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, alias_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_public_login_attempts_window
  ON mail_public_login_attempts(window_started_at);
