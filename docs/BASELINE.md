# Baseline audit — Automation-Commerce

**Snapshot:** 2026-11-09  
**Audited branch:** `main`  
**Audited commit:** `fd41a0de75cd8de4119e8a8f24e9e1699b4a8044`  
**Audit branch:** `feat/baseline-audit-2026-11-09`  
**Purpose:** read-only baseline before implementation work. This document records repository and production observations; it does not authorize deployment or remote database changes.

## 1. Repository structure

| Path | Responsibility |
|---|---|
| `worker.js` | Main Telegram/order Worker; currently a large single-file runtime |
| `transaction-layer.js` | D1 transactional services and inventory operations |
| `messaging-core.mjs` | Channel-neutral command, conversation, and handoff core |
| `migrations/` | Transaction, messaging, admin login/session, and activity-audit migrations |
| `site-admin/worker.js` | Owner-facing website pricing/session/audit Worker |
| `site-admin/wrangler.jsonc` | Owner Worker configuration |
| `site-admin/migrations/` | Owner-panel session and audit schema |
| `tests/` | Worker, transaction, messaging, and owner-panel contract tests |
| `.github/workflows/` | CI workflows |
| `setupDashboard.gs` | Google Sheets dashboard setup |
| `docs/` | Transaction and Messaging Core design notes |

There is no root `package.json`; the checked-in workflows use Node's built-in test runner and do not run an npm build.

## 2. Production Worker snapshot (read-only Cloudflare inspection)

The deployed source was fetched through the Cloudflare API. Secret values were not requested or recorded.

| Worker | Active deployment | Version at 100% traffic | Created (UTC) |
|---|---|---|---|
| `seiton-order-bot` | `32052c68-edfd-4e69-bfe7-c45809bef4f2` | `44252ad2-4969-437b-a5cc-e0f8b593d666` | 2026-11-09 06:25:04 |
| `seiton-site-admin` | `05ca865d-28a7-4a49-9c1f-2b1e59756355` | `34f66741-a0cc-470c-a4d4-20067ca0cb42` | 2026-11-09 06:25:16 |

### 2.1 Runtime routes observed

The following literal route checks were found in the deployed source. This is a source inspection, not a live HTTP smoke test.

**`seiton-order-bot`**

| Route | Purpose inferred from route/source naming |
|---|---|
| `GET /` | Root handler |
| `/admin` | Web admin/dashboard UI |
| `/health` | Health/readiness |
| `/telegram` | Telegram webhook |
| `/pickup` | Pickup flow |
| `/api/admin/activity-audit` | Admin activity history |
| `/api/admin/data` | Admin data |
| `/api/admin/export` | Report export |
| `/api/admin/login` | Admin login |
| `/api/admin/order-status` | Order status update |
| `/api/admin/payment` | Payment action |
| `/api/admin/products` | Product CRUD |
| `/api/admin/proof` | Payment-proof access |
| `/api/admin/session/revoke` | Session revocation |

**`seiton-site-admin`**

| Route | Purpose inferred from route/source naming |
|---|---|
| `GET /`, `GET /index.html` | Owner panel |
| `GET /api/session` | Current session |
| `POST /api/login`, `POST /api/logout` | Login/logout |
| `GET /api/pricing` | Public read-only pricing |
| `GET /api/admin/pricing`, `PUT /api/admin/pricing` | Owner pricing CRUD |
| `GET /api/admin/audit` | Owner audit history |
| `GET /api/admin/sessions` | Session listing |
| `POST /api/admin/sessions/revoke` | Session revocation |

The bot Worker is the runtime associated with the order-bot and UMKM dashboard hostnames. The repository's own UMKM documentation describes that dashboard as **single-store**, not a multi-tenant self-service product.

### 2.2 Production bindings observed (names and resource types only)

**`seiton-order-bot`**

| Binding | Type / target |
|---|---|
| `DB` | D1: `seiton-transactions-prod` |
| `ORDER_COORDINATOR` | Durable Object namespace; class `OrderCoordinator` |
| `PRODUCT_MEDIA` | R2 bucket: `seiton-product-media` |
| `ADMIN_LOGIN_RATE_LIMITER` | Rate limiter |
| `ADMIN_CHAT_ID` | Secret binding; value intentionally not inspected |
| `ADMIN_WEB_PASSWORD` | Secret binding; value intentionally not inspected |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Secret binding; value intentionally not inspected |
| `GOOGLE_SHEETS_ID` | Plain-text binding; value omitted |
| `TELEGRAM_TOKEN` | Secret binding; value intentionally not inspected |
| `TELEGRAM_WEBHOOK_SECRET` | Secret binding; value intentionally not inspected |

**`seiton-site-admin`**

| Binding | Type / target |
|---|---|
| `SITE_DB` | D1: `seiton-site-content-prod` |
| `ORDER_BACKEND` | Service binding to `seiton-order-bot` |

### 2.3 Production D1 schema observed

Schema was read from `sqlite_master` only. No customer/order rows were queried.

**D1 `seiton-transactions-prod`**

Tables:

- `app_meta`
- `catalog_products`
- `orders`
- `inventory_movements`
- `order_events`
- `outbox`
- `order_items`
- `order_item_inventory_movements`
- `messaging_conversations`
- `messaging_inbound_events`
- `messaging_outbox`
- `messaging_handoff_requests`
- `admin_login_attempts`
- `admin_web_sessions`
- `admin_activity_audit`

Triggers observed:

- `orders_safe_amounts`
- `inventory_reserve_guard`
- `inventory_reserve_apply`
- `inventory_release_apply`
- `order_item_inventory_guard`
- `order_item_inventory_reserve_apply`
- `order_item_inventory_release_apply`

**D1 `seiton-site-content-prod`**

Tables:

- `site_services`
- `site_addons`
- `site_meta`
- `site_login_attempts`
- `site_admin_sessions`
- `site_admin_audit`

**Finding:** the live owner-panel pricing tables (`site_services`, `site_addons`) and its session/audit tables (`site_admin_sessions`, `site_admin_audit`) are present in the **same** D1 database, `seiton-site-content-prod`. The transaction database separately has its own `admin_web_sessions`, `admin_login_attempts`, and `admin_activity_audit`; those are not the owner-panel tables above.

## 3. Repository migrations and configuration

### 3.1 Backend migrations currently in GitHub main

- `migrations/0001_transaction_core.sql`
- `migrations/0004_messaging_core.sql`
- `migrations/0005_messaging_handoff_audit.sql`
- `migrations/0006_messaging_handoff_resolution.sql`
- `migrations/0007_admin_login_security.sql`
- `migrations/0008_admin_web_sessions.sql`
- `migrations/0009_admin_activity_audit.sql`
- `site-admin/migrations/0001_owner_admin_sessions_audit.sql`

The multi-item migration is **not** in this repository. It currently exists only at `midznight/seiton.id/workers/order-bot/migrations/0002_multi_item_cart.sql`. No `0003` file was found in either repository. The reason for the 0002–0003 gap has not been established and must not be guessed.

Production schema contains `order_items`, `order_item_inventory_movements`, and their three triggers. This confirms those schema objects exist in production; the migration ledger/origin was not confirmed during this read-only audit.

### 3.2 Wrangler configuration discrepancy

- Root `wrangler.jsonc` describes `seiton-order-bot`, D1 binding `DB`, Durable Object `ORDER_COORDINATOR`, cron `*/5 * * * *`, and `ADMIN_LOGIN_RATE_LIMITER`.
- Root `wrangler.toml` also names `seiton-order-bot`, but contains only a partial configuration and a plain-text `GOOGLE_SHEETS_ID` variable. It does not declare the D1 or Durable Object resources.
- `site-admin/wrangler.jsonc` describes `SITE_DB` and service binding `ORDER_BACKEND`.
- The root order-bot `wrangler.jsonc` does not declare the production `PRODUCT_MEDIA` R2 binding, although that binding is present in the deployed Worker settings.

No configuration was changed in this phase.

## 4. Production-versus-repository differences verified

1. **Deployed code and repository code are not equivalent snapshots.** The deployed Worker source was fetched independently; the exact per-function reconciliation is deferred to Phase 1.
2. **Cart schema exists, but cart runtime is not present in the deployed source inspected.** The deployed order creation path still validates a single `sku` plus `quantity`; the deployed source has no cart/order-items implementation or use of `order_items`. Therefore the live schema alone does not establish that multi-item checkout works.
3. **R2 binding exists, but R2 upload is not implemented in the deployed source inspected.** The binding `PRODUCT_MEDIA` points to `seiton-product-media`; the deployed code did not reference that binding or perform product-media R2 operations. Existing product data uses `photo_url`.
4. **UMKM dashboard is not multi-tenant.** The checked-in UMKM documentation explicitly calls it a single-store dashboard and says tenant isolation/provisioning is not implemented.
5. **Google Sheets is still present as a migration/reporting integration.** D1 is documented as transaction source of truth; Sheets remains an import/report mirror. No Sheet value or service-account secret was inspected.
6. **Owner pricing and owner sessions/audit share one D1.** Verified through the live `seiton-site-content-prod` schema.
7. **WhatsApp Cloud API is not active.** Telegram is the active bot transport; the Messaging Core is channel-neutral but its documentation says it does not include a WhatsApp provider/webhook/sender.
8. **Configuration is ambiguous.** Both root `wrangler.jsonc` and `wrangler.toml` exist for the same Worker; only `wrangler.jsonc` contains the D1/DO/ratelimit configuration.

## 5. CI/test baseline

### Workflows

| Workflow | Trigger | Commands |
|---|---|---|
| `.github/workflows/messaging-core.yml` | Relevant file changes on main/PR; manual dispatch | `node --test tests/messaging-core.test.mjs` |
| `.github/workflows/worker-audit.yml` | Push to main and PR targeting main | `node --check worker.js`; `node --check transaction-layer.js`; `node --test tests/*.test.cjs` |

### Latest observed GitHub Actions evidence

For main commit `fd41a0de75cd8de4119e8a8f24e9e1699b4a8044` on 2026-11-09:

- Messaging Core: **22 passed, 0 failed**.
- Worker syntax check: passed.
- Transaction-layer syntax check: passed.
- Contract/regression tests: **59 passed, 0 failed**.

The logs belong to the checked-in main commit and were inspected as baseline CI evidence. A fresh local run was not possible in this execution environment because `git clone` could not resolve `github.com`; no test result is represented as a local run.

## 6. Not changed / deferred

- No Worker deployment or Cloudflare account configuration was changed.
- No remote migration or D1 write was executed.
- No secret values were read or written.
- No prices, triggers, or bindings were changed.
- Cart/R2 runtime reconstruction, migration relocation, Wrangler consolidation, and per-function source reconciliation are deferred to later phases and require the relevant approval checkpoint.
- The removal of stale frontend Worker copies is only a proposal for a later phase; this repository audit does not delete them.
