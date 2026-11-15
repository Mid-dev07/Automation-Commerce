CREATE TABLE IF NOT EXISTS operational_alert_state (
  alert_key TEXT PRIMARY KEY,
  last_sent_at_ms INTEGER NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at_ms INTEGER NOT NULL
);
