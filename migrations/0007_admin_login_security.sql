-- Track failed admin dashboard logins using HMAC-derived client identifiers.
-- Raw client IP addresses are never persisted.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  client_key TEXT PRIMARY KEY,
  window_started_ms INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL CHECK (failed_attempts BETWEEN 1 AND 5),
  blocked_until_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_updated
  ON admin_login_attempts (updated_at_ms);
