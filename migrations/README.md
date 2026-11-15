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
| `0011_qris_payments.sql` | QRIS order ledger, unique amount, and receipt OCR | Applied to production D1 |
| `0012_qris_static_fallback_product_form.sql` | Static QRIS fallback mode and Telegram product form drafts | Applied to production D1 |
| `0013_payment_methods_and_bank_accounts.sql` | Admin-controlled checkout methods and multiple bank transfer accounts | Pending release |

## Important

- Before deploying code that reads migration 0013, apply `0013_payment_methods_and_bank_accounts.sql` to `seiton-transactions-prod`. It is additive and seeds QRIS, Transfer Bank, and COD as enabled; Transfer Bank remains unavailable to customers until at least one active bank account is added.
- This is a source-of-truth consolidation and deployment index.
- Migrations 0001–0011 are present in the Seiton production D1 schema; migration 0012 is applied as part of the static fallback/product wizard release.
- The historical copy under the website repository is retained for traceability. Do not apply both copies.
- Before any new migration: inspect `wrangler.jsonc`, confirm the target database, run a local/staging dry run, and verify the production schema is compatible.
- Site-admin migrations belong to the separate `seiton-site-content-prod` database and remain under `site-admin/migrations/`.


## 0011_qris_payments.sql

Creates the internal QRIS ledger: unique three-digit suffix and exact amount, dynamic MPM payload, Telegram proof reference, OCR extraction state, duplicate-file/reference protection, and admin review fields. This replaces the earlier, not-yet-applied Midtrans draft. Production D1 was inspected before this migration and had no QRIS tables. Keep the feature flag disabled until the merchant's own static QRIS payload is configured and the acquirer validates this issuance flow.


## 0012_qris_static_fallback_product_form.sql

Adds `qris_mode` to the QRIS ledger so each order remembers whether its QR image is dynamic or the original static merchant QR. Adds durable per-admin draft storage for the Telegram product add/edit wizard. It does not alter existing orders or catalog items.


## 0013_payment_methods_and_bank_accounts.sql

Adds admin-managed enabled/disabled state for QRIS, Transfer Bank, and COD plus multiple bank account destinations. Disabling a method or account affects new checkout sessions only; existing orders and their payment-verification state remain unchanged. Bank account records are soft-disabled rather than deleted, and bank/number duplicates are blocked by a unique index.


## 0014_operational_alert_state.sql

Adds cooldown state for opt-in Telegram alerts about failed/stalled Google Sheets mirrors and payment verification older than two hours. This migration is pending release. Do not set `OPERATIONAL_ALERTS_ENABLED=true` or deploy the alert code until the schema is applied to an isolated preview database and notification UAT succeeds.
