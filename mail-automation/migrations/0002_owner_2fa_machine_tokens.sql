-- Additive migration: owner TOTP 2FA, login challenges, recovery codes,
-- and separately revocable Machine API credentials. Existing records are preserved.
ALTER TABLE mail_admin ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_admin ADD COLUMN totp_secret_iv TEXT;
ALTER TABLE mail_admin ADD COLUMN totp_secret_ciphertext TEXT;
ALTER TABLE mail_admin ADD COLUMN totp_pending_iv TEXT;
ALTER TABLE mail_admin ADD COLUMN totp_pending_ciphertext TEXT;
ALTER TABLE mail_admin ADD COLUMN totp_pending_expires_at INTEGER;
ALTER TABLE mail_admin ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT -1;

CREATE TABLE IF NOT EXISTS mail_login_challenges (
  challenge_hash TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_mail_login_challenges_expires
  ON mail_login_challenges(expires_at);

CREATE TABLE IF NOT EXISTS mail_2fa_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_machine_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mail_machine_tokens_status
  ON mail_machine_tokens(status, created_at);
