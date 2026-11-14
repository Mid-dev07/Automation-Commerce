-- Isolated service-to-service access for the trusted VM.
-- The VM never receives D1 access or the AES-GCM encryption key.
CREATE TABLE IF NOT EXISTS mail_machine_aliases (
  alias_id TEXT PRIMARY KEY,
  client_ref TEXT UNIQUE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (alias_id) REFERENCES mail_aliases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mail_machine_aliases_created
  ON mail_machine_aliases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_machine_aliases_token
  ON mail_machine_aliases(token_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_machine_rate_limits (
  token_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0)
);
