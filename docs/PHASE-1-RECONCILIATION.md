# Phase 1 — Production/source reconciliation

Date: 2026-11-09  
Status: review required; no production resources changed.

## Scope and safety

This phase reconciles the deployed Seiton Workers with the backend repository and records migration/configuration findings. The inspection was read-only against Cloudflare production. No Worker was deployed, no remote D1 migration was applied, no binding or secret was changed, and no customer/order rows were queried.

The baseline Git tag `baseline-2026-11-09` was intentionally skipped at the owner's direction. The baseline audit remains on the separate feature branch/PR; create and push the tag later if required by release governance.

## 1. Deployed Worker source comparison

The active Cloudflare source exports were fetched from the deployed Worker script content endpoints and compared byte-for-byte (after normalizing CRLF/LF) with the corresponding repository files.

| Worker | Production deployment | Repository file | Result |
|---|---|---|---|
| `seiton-order-bot` | deployment `32052c68-edfd-4e69-bfe7-c45809bef4f2`, active version `44252ad2-4969-437b-a5cc-e0f8b593d666` | `worker.js` | Identical |
| `seiton-order-bot` | same deployment/version | `transaction-layer.js` | Identical |
| `seiton-order-bot` | same deployment/version | `messaging-core.mjs` | Identical |
| `seiton-site-admin` | deployment `05ca865d-28a7-4a49-9c1f-2b1e59756355`, active version `34f66741-a0cc-470c-a4d4-20067ca0cb42` | `site-admin/worker.js` | Identical |

**Conclusion:** no runtime-source reconciliation patch is required for these four entry/source files. The earlier apparent differences were caused by an incorrect multipart extraction during the initial comparison; the corrected per-part comparison confirms exact equality. Do not replace deployed code based on the earlier false mismatch.

This source comparison does not independently prove that every production request path is behaviorally correct. Existing tests and route-level behavior still need to be validated in the later implementation phases.

## 2. Production bindings observed (names/types only)

### `seiton-order-bot`

- `DB`: D1 database `seiton-transactions-prod`
- `ORDER_COORDINATOR`: Durable Object class `OrderCoordinator`
- `PRODUCT_MEDIA`: R2 bucket `seiton-product-media`
- `ADMIN_LOGIN_RATE_LIMITER`: rate limiter
- `GOOGLE_SHEETS_ID`: plain-text configuration
- Secret bindings present: `ADMIN_CHAT_ID`, `ADMIN_WEB_PASSWORD`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`

Secret values were not read, displayed, copied, or modified.

### `seiton-site-admin`

- `ORDER_BACKEND`: service binding to `seiton-order-bot`
- `SITE_DB`: D1 database `seiton-site-content-prod`

The production R2 binding exists, but the inspected deployed bot source does not currently contain an R2 upload implementation or use `PRODUCT_MEDIA`. Treat image upload/serving as not implemented in the source until Phase 3 adds and tests it. Do not infer that the bucket contains product images merely from the binding.

## 3. D1 placement and schema observations

Read-only schema inspection (table/trigger names only; no business rows) found:

- `seiton-transactions-prod` contains transactional tables including `orders`, `catalog_products`, `inventory_movements`, `order_items`, and `order_item_inventory_movements`, as well as messaging, outbox, and transaction-admin audit/session tables.
- `seiton-site-content-prod` contains `site_services`, `site_addons`, `site_meta`, `site_admin_sessions`, and `site_admin_audit`.

Therefore:
- Owner-panel pricing/catalog content and owner-panel sessions/audit belong to `seiton-site-content-prod` through `SITE_DB`.
- Order, inventory, Telegram transaction state, and bot-admin audit/session data belong to `seiton-transactions-prod` through `DB`.
- The owner panel accesses the order backend through the `ORDER_BACKEND` service binding; do not move owner-panel tables into the transaction DB without a separately reviewed architecture change.

The D1 migration ledger could not be verified in this audit; no conclusion is made about whether production migration history is fully tracked.

## 4. Multi-item cart migration placement

The additive SQL file previously existed only at:

`seiton.id/workers/order-bot/migrations/0002_multi_item_cart.sql`

It is now copied into the backend repository at:

`Automation-Commerce/migrations/0002_multi_item_cart.sql`

The migration creates `order_items`, `order_item_inventory_movements`, indexes, and reserve/release triggers with `IF NOT EXISTS`. It is additive and does not drop or alter existing tables. The production D1 schema already exposes these cart-related tables and triggers, but the runtime source comparison is not evidence that the current checkout flow uses them.

### Numbering gap

The backend migration directory now contains:

- `0001_transaction_core.sql`
- `0002_multi_item_cart.sql`
- `0004_messaging_core.sql`
- `0005_messaging_handoff_audit.sql`
- `0006_messaging_handoff_resolution.sql`
- `0007_admin_login_security.sql`
- `0008_admin_web_sessions.sql`
- `0009_admin_activity_audit.sql`

There is no `0003` migration in the repository. Its intended purpose and whether it was ever applied are unknown. **Do not invent a 0003 migration or renumber 0004–0009.** Keep the gap documented until historical migration provenance can be established. No remote migration was run as part of this phase.

## 5. Wrangler configuration review — proposal only

The backend root currently has both `wrangler.jsonc` and `wrangler.toml` for `seiton-order-bot`.

- `wrangler.jsonc` includes D1, Durable Object, cron, and rate-limit configuration, but does not declare the production `PRODUCT_MEDIA` R2 binding or all production settings.
- `wrangler.toml` is incomplete: it declares the worker and a `GOOGLE_SHEETS_ID` variable, but omits the D1, Durable Object, R2, and rate-limit configuration.
- `site-admin/wrangler.jsonc` separately declares `SITE_DB` and `ORDER_BACKEND`, consistent with the observed production topology.

**Proposal:** designate one canonical root configuration for `seiton-order-bot` after reviewing deployment automation and all environment-specific IDs. Treat `wrangler.jsonc` as the current stronger candidate because it already declares the core runtime resources. Before changing it, prepare a separate diff to reconcile the R2 binding and non-secret variables against the verified production binding names. Do not copy secret values into vars or config. Do not delete `wrangler.toml` in this phase. No Wrangler configuration was changed.

## 6. Duplicate frontend worker tree — proposal only

The public-site repository contains a `workers/` subtree with copies of worker/admin code and a cart migration. At least the duplicate `workers/site-admin/worker.js` is older and shorter than the backend source of truth. The active deployed source matches `Automation-Commerce`, not the duplicate frontend copy.

**Proposal:** keep `Automation-Commerce` as the only source of truth for backend Workers. Remove or archive the duplicated `seiton.id/workers/` subtree only in a separately reviewed change after checking every reference, Pages build/deploy workflow, and any contributor workflow. Do not delete the duplicate tree as part of this phase.

## 7. Verification and remaining work

- Production source export comparison: exact match for all four files listed above.
- Production D1 inspection: schema metadata only; no customer/order data queried.
- Existing CI baseline remains as recorded in `docs/BASELINE.md`.
- This phase does not run local D1/Miniflare tests because no local runtime environment was available in the connected repository workflow.
- No production deploy, remote D1 migration, secret access, binding mutation, or production configuration update occurred.

### Required before proceeding to Phase 2

1. Review and approve this reconciliation report and the migration copy.
2. Preserve the `0003` numbering gap unless historical provenance supplies the missing migration.
3. Keep production migration/deploy operations owner-run and separately approved.
4. Phase 2 must validate the cart transaction path against local D1/Miniflare and the existing trigger semantics before any production rollout.
