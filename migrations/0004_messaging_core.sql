-- Seiton Messaging Core
-- Additive migration: shared, channel-neutral inbound deduplication,
-- conversation controls, support handoff records, and outbound outbox.

CREATE TABLE IF NOT EXISTS messaging_conversations (
  tenant_id TEXT NOT NULL DEFAULT 'seiton',
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  conversation_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT 'Pelanggan',
  mode TEXT NOT NULL DEFAULT 'BOT'
    CHECK (mode IN ('BOT', 'HUMAN', 'OPTED_OUT')),
  state TEXT NOT NULL DEFAULT 'IDLE',
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  opted_out_at TEXT,
  handoff_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, channel, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_conversations_mode
  ON messaging_conversations (tenant_id, channel, mode, updated_at);

CREATE TABLE IF NOT EXISTS messaging_inbound_events (
  tenant_id TEXT NOT NULL DEFAULT 'seiton',
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  event_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'message'
    CHECK (event_type IN ('message', 'choice')),
  status TEXT NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 1,
  lease_until TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_code TEXT,
  PRIMARY KEY (tenant_id, channel, event_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_inbound_conversation
  ON messaging_inbound_events (tenant_id, channel, conversation_id, received_at);

CREATE TABLE IF NOT EXISTS messaging_outbox (
  action_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'seiton',
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  conversation_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'text'
    CHECK (action_type IN ('text')),
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until TEXT,
  provider_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT,
  error_code TEXT,
  UNIQUE (tenant_id, channel, source_event_id, action_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_outbox_dispatch
  ON messaging_outbox (channel, status, available_at, lease_until);

CREATE INDEX IF NOT EXISTS idx_messaging_outbox_conversation
  ON messaging_outbox (tenant_id, channel, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS messaging_handoff_requests (
  handoff_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'seiton',
  source_channel TEXT NOT NULL CHECK (source_channel IN ('telegram', 'whatsapp')),
  conversation_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT 'Pelanggan',
  source_event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'CLAIMED', 'CLOSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (tenant_id, source_channel, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_handoff_open
  ON messaging_handoff_requests (tenant_id, status, created_at);
