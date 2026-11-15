# Site Admin D1 migrations

Database: `seiton-site-content-prod`  
Wrangler binding: `SITE_DB`  
Migration directory: `site-admin/migrations/`

| Migration | Purpose | Release status |
|---|---|---|
| `0001_owner_admin_sessions_audit.sql` | Owner sessions and audit history | Existing production schema |
| `0002_owner_project_pipeline.sql` | Owner CRM, projects, project payment ledger, and event history | Pending release |

## 0002 — owner project pipeline

This is an additive migration. It creates:
- `owner_clients`: minimal customer contact record.
- `owner_projects`: service project, scope, quotation, DP target, status, due date, revision count.
- `owner_project_payments`: manually recorded incoming payments/refunds for service projects. It is separate from the checkout QRIS transaction ledger.
- `owner_project_events`: append-only project activity metadata.

The CRM does not collect passwords, OTPs, access tokens, bank credentials, QRIS payloads, or mailbox links. Payment entries require explicit owner confirmation that funds were actually received. Refund entries are capped at the net payment balance.

Do not apply this migration to production as part of source synchronization. Before release:
1. Back up / record the current SITE_DB recovery point.
2. Apply to an isolated preview database.
3. Run schema and owner-session tests.
4. Verify customer/project creation, status changes, payment recording, refunds, and event history.
5. Obtain explicit owner approval before production migration and Worker deployment.
