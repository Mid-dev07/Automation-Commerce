# Transaction D1 migration index

Canonical migration directory for `seiton-transactions-prod` is now `migrations/` in `midznight/Automation-Commerce`.

| Migration | Purpose | Status |
|---|---|---|
| `0001_transaction_core.sql` | Transaction core tables | Existing |
| `0002_multi_item_cart.sql` | Multi-item cart and inventory movement triggers | Consolidated from `midznight/seiton.id/workers/order-bot/migrations/` |
| `0003` | No file found in the current source inventory | Intentionally left as a gap; do not fabricate |
| `0004_messaging_core.sql` | Messaging core | Existing |
| `0005_messaging_handoff_audit.sql` | Messaging handoff audit | Existing |
| `0006_messaging_handoff_resolution.sql` | Messaging handoff resolution | Existing |
| `0007_admin_login_security.sql` | Admin login security | Existing |
| `0008_admin_web_sessions.sql` | Admin web sessions | Existing |
| `0009_admin_activity_audit.sql` | Admin activity audit | Existing |
| `0010_digital_products.sql` | Digital product inventory and fulfillment | Existing |

## Important

- This is a source-of-truth consolidation only.
- No migration has been applied to either production D1 database.
- The historical copy under the website repository is retained for traceability. Do not apply both copies.
- Before any new migration: inspect `wrangler.jsonc`, confirm the target database, run a local/staging dry run, and verify the production schema is compatible.
- Site-admin migrations belong to the separate `seiton-site-content-prod` database and remain under `site-admin/migrations/`.
