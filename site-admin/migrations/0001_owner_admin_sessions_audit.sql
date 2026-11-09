-- Owner panel sessions are revocable server-side. Only a SHA-256 token fingerprint is stored.
CREATE TABLE IF NOT EXISTS site_admin_sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  CHECK (expires_at_ms > created_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_site_admin_sessions_active
  ON site_admin_sessions (revoked_at_ms, expires_at_ms, last_seen_at_ms);

-- Append-only owner/admin activity trail. Payloads exclude passwords, tokens,
-- raw client IP addresses, and customer-message text.
CREATE TABLE IF NOT EXISTS site_admin_audit (
  audit_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  client_hash TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_admin_audit_created
  ON site_admin_audit (created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_site_admin_audit_action
  ON site_admin_audit (action, created_at_ms DESC);
