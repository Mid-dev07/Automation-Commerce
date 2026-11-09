-- Server-side registry for web-admin HMAC bearer tokens.
-- Raw bearer tokens are never persisted; only their SHA-256 fingerprints are stored.
CREATE TABLE IF NOT EXISTS admin_web_sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  CHECK (expires_at_ms > issued_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_admin_web_sessions_active
  ON admin_web_sessions (revoked_at_ms, expires_at_ms);
