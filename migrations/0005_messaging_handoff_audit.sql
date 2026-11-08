-- Messaging Core handoff audit fields.
-- Apply after 0004_messaging_core.sql.
ALTER TABLE messaging_handoff_requests ADD COLUMN claimed_by TEXT;
ALTER TABLE messaging_handoff_requests ADD COLUMN claimed_at TEXT;
ALTER TABLE messaging_handoff_requests ADD COLUMN closed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_messaging_handoff_claimed
  ON messaging_handoff_requests (tenant_id, status, claimed_by, created_at);
