# Phase 5 — Isolated Worker Preview

Date: 2026-11-09  
Status: **Preview deployed and protected by Preview-only Cloudflare Access. Runtime app validation is pending one authenticated Access browser session.**

Latest successful GitHub Actions run before the docs-only status update: Worker/cart regression **93/93 passed**, Messaging Core **26/26 passed**. Preview URL opt-in is covered by a regression test.

## 1. Isolated resources provisioned

The Cloudflare account has dedicated Preview resources in APAC:

| Resource | Name | Identifier |
| --- | --- | --- |
| D1 | `seiton-preview-transactions-20261109` | `c98e9147-8a53-4fb1-bee2-d33e966baeb7` |
| R2 | `seiton-preview-product-media-20261109` | Bucket name |

The D1 database was created with read replication disabled. The R2 bucket uses the Standard storage class. Neither resource is the production D1 database or production R2 bucket.

## 2. Preview configuration

The root `wrangler.jsonc` includes a dedicated `previews` block:

- `DB` points to `seiton-preview-transactions-20261109`.
- `PRODUCT_MEDIA` points to `seiton-preview-product-media-20261109`.
- `ORDER_COORDINATOR` is configured for the Preview runtime. Cloudflare provisions separate Durable Object namespace/storage for each Preview.
- `APP_ENV=preview` is set.
- Production cron triggers, routes, and service bindings are not copied into the Preview block.
- Production Google Sheets ID, Google service account, Telegram bot token, and admin chat ID are not configured in the Preview deployment.

A separate `wrangler.preview-migrations.jsonc` points D1 migrations directly at the isolated Preview database. This avoids accidentally applying migrations to the production database named in the top-level Wrangler config.

The direct Preview deployment also includes a Preview-only rate-limit binding under namespace `2026110902`; the production namespace is not reused.

## 3. Preview D1 migrations and smoke tests

The eight repository migrations were applied to the isolated Preview D1 database only, in one transactional D1 API batch. The `d1_migrations` tracking table uses the same schema as Wrangler's migration runner and records these filenames in order:

- `0001_transaction_core.sql`
- `0002_multi_item_cart.sql`
- `0004_messaging_core.sql`
- `0005_messaging_handoff_audit.sql`
- `0006_messaging_handoff_resolution.sql`
- `0007_admin_login_security.sql`
- `0008_admin_web_sessions.sql`
- `0009_admin_activity_audit.sql`

Verification confirmed all eight entries, the expected application tables, indexes, and triggers. A Preview-only SQL smoke test verified stock transitions:

| Flow | Starting stock | After reserve | After release |
| --- | ---: | ---: | ---: |
| Single-SKU order | 5 | 3 | 5 |
| Multi-item cart item | 8 | 5 | 8 |

All synthetic smoke-test rows were deleted in the same batch after the checks. Follow-up counts for synthetic products, orders, and both movement tables were all zero. No customer/test orders remain in the Preview database.

## 4. Preview-only Cloudflare Access

Cloudflare Zero Trust Free has been activated by the account owner.

An Access application was created and verified:

- Application: `Seiton Worker Preview Access`
- Application ID: `b3929527-97e2-4307-8319-52963331e8e6`
- Destination type: `preview_worker`
- Target Worker ID: `ebc1b01e36104524b9f8e62a3576dc28`
- Policy: one `Allow` policy for the owner identity, with a one-hour session.
- No `worker`, `all_workers`, or account-wide Preview destination was configured.

Only after verifying the exact Preview-only destination and owner policy, the Worker subdomain setting was updated to:

- `enabled=true` — existing Production `workers.dev` setting, unchanged.
- `previews_enabled=true` — Preview URLs enabled for `seiton-order-bot`.

No production Access application or production Access policy was added.

## 5. Preview deployment

A Preview named `phase-5-isolated-preview` was created:

- Preview ID: `65581d90e03c42e286c033d07861e1b4`
- Latest deployment number: `2`
- Deployment ID: `213b28ea-c161-44e4-95d4-83d19d6a9eb2`
- Source commit: `4f8787046741bbdcc94deedf0c9190ea3c1ace0b`
- Uploaded modules: `worker.js`, `transaction-layer.js`, `cart-layer.mjs`, `messaging-core.mjs`, `product-media.mjs`

Stable Preview URLs (both protected by the `preview_worker` Access application):

- `https://phase-5-isolated-preview.automate-bot.seiton.biz.id`
- `https://phase-5-isolated-preview-seiton-order-bot.midzpribadi.workers.dev`

Latest deployment URLs:

- `https://213b28ea.automate-bot.seiton.biz.id`
- `https://213b28ea-seiton-order-bot.midzpribadi.workers.dev`

The latest deployment's bindings were verified:

| Binding | Preview target |
| --- | --- |
| `DB` | Preview D1 `c98e9147-8a53-4fb1-bee2-d33e966baeb7` |
| `PRODUCT_MEDIA` | Preview R2 `seiton-preview-product-media-20261109` |
| `ORDER_COORDINATOR` | Preview-specific SQLite Durable Object namespace |
| `ADMIN_LOGIN_RATE_LIMITER` | Preview-only namespace `2026110902` |
| `APP_ENV` | `preview` |

For admin login verification, `ADMIN_WEB_PASSWORD` and `TELEGRAM_WEBHOOK_SECRET` were explicitly overridden with fresh, Preview-only random secret values. Their values are not stored in Git or this document. No production secret values were copied into the Preview. No Telegram bot token, Google service-account key, Google Sheets identifier, or production admin chat ID is included.

The initial deployment number 1 was deleted after an audit found an unexpected secret binding in its returned metadata. Deployment number 2 is the only remaining deployment and has explicit Preview-only secret overrides.

## 6. Runtime validation status

The first browser check opened `/health` and `/` on the stable Preview URL. Both were redirected to the Cloudflare Access login page before reaching the Worker application.

This verifies that Cloudflare Access intercepts and protects Preview requests. It does **not** yet verify the application-level `/health` response or render of the Seiton admin login UI, because the browser profile does not yet have an authenticated session for the Zero Trust Access login domain.

Runtime checks still pending an authenticated Access browser session:

- `GET /health`
- Render the root admin login page
- Admin login/session flow using the Preview-only test credentials
- D1-backed catalog/cart/checkout flow with synthetic data and cleanup
- R2 product-media upload/read/delete with synthetic image bytes and cleanup

Telegram end-to-end messaging remains untested. No live Telegram token, live admin chat ID, Google service-account key, or production Sheets destination is configured.

## 7. Regression coverage

`tests/worker-preview-config.test.cjs` verifies:

- Preview D1 ID and name differ from the production D1 binding.
- Preview R2 bucket name differs from the production bucket.
- The standalone migration config targets the same Preview D1 as the Preview runtime.
- Durable Object binding is present.
- Preview does not declare cron triggers, production routes, or service bindings.
- Production secret names and the Google Sheets target are absent from Preview configuration.
- Preview URLs are not enabled in repository config before the explicit Access gate.

GitHub Actions also runs the existing Worker/cart regression and Messaging Core suites. Passing CI validates repository contracts, not the remote Preview runtime.

## 8. Safety status

- Only the dedicated Preview D1 and R2 resources were created for this phase.
- A Preview-only Access application targets the exact `seiton-order-bot` Preview deployments.
- Preview URLs are enabled for `seiton-order-bot` only after the Access policy was verified.
- Only deployment number 2 remains; the initial deployment was deleted.
- Eight D1 migrations and stock-flow smoke tests were performed against Preview D1 only.
- No Production Worker deployment or update was performed.
- No Production D1 or R2 resource was modified.
- No Production secret values were read or copied.
- No Production bindings, routes, cron triggers, Sheets destination, bot token, or admin chat ID were changed.
- `main` was not updated; the source is the approved Phase 3 feature branch.
- Application runtime validation remains pending an authenticated Cloudflare Access browser session.
