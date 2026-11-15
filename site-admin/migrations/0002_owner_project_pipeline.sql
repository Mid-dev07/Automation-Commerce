PRAGMA foreign_keys = ON;

-- Internal owner CRM. Store only the contact and project details needed to deliver services.
-- Never put passwords, OTPs, access tokens, bank credentials, or full customer message contents here.
CREATE TABLE IF NOT EXISTS owner_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  business_name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  contact_channel TEXT NOT NULL DEFAULT 'LAINNYA'
    CHECK (contact_channel IN ('WHATSAPP','EMAIL','INSTAGRAM','TELEGRAM','LAINNYA')),
  contact_value TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS owner_clients_name_idx ON owner_clients(name);
CREATE INDEX IF NOT EXISTS owner_clients_created_idx ON owner_clients(created_at DESC);

CREATE TABLE IF NOT EXISTS owner_projects (
  project_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES owner_clients(client_id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 140),
  service_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'KONTAK_BARU'
    CHECK (status IN ('KONTAK_BARU','KONSULTASI','PENAWARAN','MENUNGGU_DP','MENUNGGU_BAHAN','DIKERJAKAN','MENUNGGU_REVIEW','MENUNGGU_PELUNASAN','SERAH_TERIMA','MAINTENANCE','SELESAI','DIBATALKAN')),
  scope_summary TEXT NOT NULL DEFAULT '',
  quote_amount INTEGER NOT NULL DEFAULT 0 CHECK (quote_amount BETWEEN 0 AND 1000000000),
  deposit_target_amount INTEGER NOT NULL DEFAULT 0 CHECK (deposit_target_amount BETWEEN 0 AND 1000000000),
  due_at TEXT NOT NULL DEFAULT '',
  revision_limit INTEGER NOT NULL DEFAULT 0 CHECK (revision_limit BETWEEN 0 AND 20),
  revision_used INTEGER NOT NULL DEFAULT 0 CHECK (revision_used BETWEEN 0 AND 20),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS owner_projects_status_updated_idx ON owner_projects(status,updated_at DESC);
CREATE INDEX IF NOT EXISTS owner_projects_due_idx ON owner_projects(due_at,status);

CREATE TABLE IF NOT EXISTS owner_project_payments (
  payment_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES owner_projects(project_id),
  payment_type TEXT NOT NULL CHECK (payment_type IN ('DP','PELUNASAN','LAINNYA','PENGEMBALIAN')),
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000000000),
  payment_method TEXT NOT NULL DEFAULT '',
  payment_reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_project_payments_project_idx ON owner_project_payments(project_id,created_at DESC);

CREATE TABLE IF NOT EXISTS owner_project_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES owner_projects(project_id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_project_events_project_idx ON owner_project_events(project_id,created_at DESC);


-- Database-level protection against concurrent or repeated over-refunds.
CREATE TRIGGER IF NOT EXISTS owner_project_refund_guard
BEFORE INSERT ON owner_project_payments
WHEN NEW.payment_type='PENGEMBALIAN'
BEGIN
  SELECT CASE
    WHEN NEW.amount > COALESCE((
      SELECT SUM(CASE WHEN payment_type='PENGEMBALIAN' THEN -amount ELSE amount END)
      FROM owner_project_payments
      WHERE project_id=NEW.project_id
    ),0)
    THEN RAISE(ABORT,'PROJECT_REFUND_EXCEEDS_NET_PAYMENTS')
  END;
END;
