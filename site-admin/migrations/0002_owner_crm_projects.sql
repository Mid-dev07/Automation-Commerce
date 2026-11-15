-- Owner-only CRM and project tracking.
-- Additive: does not touch transaction D1, existing pricing, sessions, or audit rows.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site_crm_leads (
  lead_id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL CHECK(length(business_name) BETWEEN 1 AND 120),
  contact_name TEXT NOT NULL DEFAULT '',
  contact_channel TEXT NOT NULL DEFAULT 'whatsapp',
  contact_value TEXT NOT NULL DEFAULT '',
  service_interest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK(status IN ('NEW','QUALIFIED','PROPOSAL_SENT','WON','LOST')),
  next_follow_up_ms INTEGER,
  contact_permission INTEGER NOT NULL DEFAULT 0 CHECK(contact_permission IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_crm_leads_status_followup
  ON site_crm_leads(status, next_follow_up_ms, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS site_crm_projects (
  project_id TEXT PRIMARY KEY,
  lead_id TEXT,
  client_name TEXT NOT NULL,
  business_name TEXT NOT NULL DEFAULT '',
  service_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING_DP'
    CHECK(status IN ('WAITING_DP','WAITING_MATERIALS','IN_PROGRESS','REVIEW','WAITING_FINAL_PAYMENT','HANDOVER','MAINTENANCE','CLOSED','CANCELLED')),
  scope TEXT NOT NULL DEFAULT '',
  deliverables TEXT NOT NULL DEFAULT '',
  agreed_total INTEGER NOT NULL DEFAULT 0 CHECK(agreed_total >= 0),
  dp_amount INTEGER NOT NULL DEFAULT 0 CHECK(dp_amount >= 0),
  final_amount INTEGER NOT NULL DEFAULT 0 CHECK(final_amount >= 0),
  dp_paid_at_ms INTEGER,
  final_paid_at_ms INTEGER,
  start_at_ms INTEGER,
  due_at_ms INTEGER,
  handover_at_ms INTEGER,
  maintenance_until_ms INTEGER,
  revision_limit INTEGER NOT NULL DEFAULT 2 CHECK(revision_limit BETWEEN 0 AND 50),
  revisions_used INTEGER NOT NULL DEFAULT 0 CHECK(revisions_used >= 0 AND revisions_used <= revision_limit),
  notes TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(dp_amount + final_amount = agreed_total),
  FOREIGN KEY (lead_id) REFERENCES site_crm_leads(lead_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_site_crm_projects_status_due
  ON site_crm_projects(status, due_at_ms, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_site_crm_projects_lead
  ON site_crm_projects(lead_id, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS site_crm_tasks (
  task_id TEXT PRIMARY KEY,
  lead_id TEXT,
  project_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK(priority IN ('LOW','NORMAL','HIGH')),
  due_at_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','COMPLETED')),
  completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(lead_id IS NOT NULL OR project_id IS NOT NULL),
  FOREIGN KEY (lead_id) REFERENCES site_crm_leads(lead_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES site_crm_projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_site_crm_tasks_status_due
  ON site_crm_tasks(status, due_at_ms, priority);
CREATE INDEX IF NOT EXISTS idx_site_crm_tasks_project
  ON site_crm_tasks(project_id, status, due_at_ms);
CREATE INDEX IF NOT EXISTS idx_site_crm_tasks_lead
  ON site_crm_tasks(lead_id, status, due_at_ms);
