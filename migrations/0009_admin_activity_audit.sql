-- Administrative activity history for Telegram and Web operations.
-- Order state changes continue to use order_events in the same D1 transaction.
CREATE TABLE IF NOT EXISTS admin_activity_audit (
  audit_id TEXT PRIMARY KEY,
  actor_channel TEXT NOT NULL CHECK (actor_channel IN ('telegram', 'web')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_activity_audit_created
  ON admin_activity_audit (created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_admin_activity_audit_actor
  ON admin_activity_audit (actor_channel, actor_id, created_at_ms DESC);
