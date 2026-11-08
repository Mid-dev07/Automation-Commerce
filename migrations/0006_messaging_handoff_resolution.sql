-- Track whether a handoff was successfully resolved or declined by an admin.
-- Apply after 0004_messaging_core.sql and 0005_messaging_handoff_audit.sql.
ALTER TABLE messaging_handoff_requests
  ADD COLUMN resolution TEXT NOT NULL DEFAULT 'RESOLVED'
  CHECK (resolution IN ('RESOLVED', 'DECLINED'));

CREATE INDEX IF NOT EXISTS idx_messaging_handoff_resolution
  ON messaging_handoff_requests (tenant_id, resolution, closed_at);
