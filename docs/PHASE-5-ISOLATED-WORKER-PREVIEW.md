# Phase 5 — Isolated Worker Preview

Date: 2026-11-09  
Status: **Preview deployed and protected by Preview-only Cloudflare Access. Runtime health, admin session, dashboard, and catalog create/update smoke tests passed. Native-confirm delete UI test remains inconclusive; all synthetic rows were cleaned.**

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

A Preview named `phase-5-isolated-preview` is active:

- Preview ID: `65581d90e03c42e286c033d07861e1b4`
- Latest deployment number: **4**
- Latest deployment ID: `5e9333cd-4539-4b4c-8bf1-acfd4be5034a`
- Source commit: `2883f78012bee8b36c0c4d2071f0a02e16d3a465`
- Uploaded modules: `worker.js`, `transaction-layer.js`, `cart-layer.mjs`, `messaging-core.mjs`, `product-media.mjs`

Stable Preview URLs:

- `https://phase-5-isolated-preview.automate-bot.seiton.biz.id`
- `https://phase-5-isolated-preview-seiton-order-bot.midzpribadi.workers.dev`

Latest deployment URLs:

- `https://5e9333cd.automate-bot.seiton.biz.id`
- `https://5e9333cd-seiton-order-bot.midzpribadi.workers.dev`

Latest deployment bindings were re-checked after deployment #4:

| Binding | Preview target |
| --- | --- |
| `DB` | Preview D1 `c98e9147-8a53-4fb1-bee2-d33e966baeb7` |
| `PRODUCT_MEDIA` | Preview R2 `seiton-preview-product-media-20261109` |
| `ORDER_COORDINATOR` | Preview-specific SQLite Durable Object namespace `2bae989dc0364fef855fd80d3fc0cf4c` |
| `ADMIN_LOGIN_RATE_LIMITER` | Preview-only namespace `2026110902` |
| `APP_ENV` | `preview` |

Both `ADMIN_WEB_PASSWORD` and `TELEGRAM_WEBHOOK_SECRET` remain attached as secret bindings. Deployment #4 was created using a JSON Merge Patch that changed the code modules and annotations only; omitted bindings were inherited from the latest Preview deployment. Secret values were not read, copied, or changed in this patch.

The Preview deployment does not contain `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY`, or `TELEGRAM_TOKEN`. Production secret values and Production resource bindings were not copied into this Preview.

Deployment #1 was deleted after an audit found an unexpected secret binding in its metadata. Deployments #2 and #3 are earlier Preview revisions; deployment #4 is the latest active version.

## 6. Runtime validation status

The account owner completed the Cloudflare Access sign-in in a dedicated Browser Context Profile. Subsequent browser checks passed through the Preview-only Access application without presenting another Access login screen. The application admin session remained active across deployment #4.

### Health and dashboard

- `GET /health` returned HTTP **200**.
- Health JSON reported `ok: true`, service `seiton-order-bot`, and `transaction_store: READY`.
- The root admin dashboard loaded and showed the expected navigation: Ringkasan, Pesanan, Verifikasi Pembayaran, Produk & Katalog, and Laporan.
- Dashboard metrics loaded without visible errors. With an empty transaction database, verified revenue, orders, and pending verification were all zero.

### D1 initialization and isolation

The repository migration files had created the schema, but the application readiness marker was initially absent. The normal `/migrasi_d1` Telegram command reads Google Sheets to import historical catalog/order data. That command was deliberately not run in Preview because doing so would require a Production Sheets credential and could import real Production data.

Instead, Preview was initialized with an empty legacy import marker and `transaction_store_state=READY`. This did not import any Production rows. Two synthetic catalog fixtures were inserted only for the browser display test.

After testing, all synthetic catalog fixtures and their pending catalog-mirror outbox rows were removed. Before cleanup, D1 was checked for references in `orders`, `order_items`, and `inventory_movements`; all counts were zero. Post-cleanup verification:

| Preview D1 table/state | Count/value |
| --- | ---: |
| `catalog_products` | 0 |
| `orders` | 0 |
| `order_items` | 0 |
| `inventory_movements` | 0 |
| `app_meta.transaction_store_state` | `READY` |

### Catalog CRUD smoke test

Deployment #2 exposed a Preview-specific problem: the product mutation handler called `ensureCatalogHeaders()` and attempted a Google Sheets operation before saving to D1. Preview intentionally has no Production Google Sheets ID or service-account key.

Commit `2883f78012bee8b36c0c4d2071f0a02e16d3a465` fixes that boundary:

- `APP_ENV=preview` skips the Google Sheets catalog-header preflight.
- Preview catalog save/delete paths skip Google Sheets mirroring.
- Non-Preview behavior is unchanged.

The fix was deployed as Preview deployment #4. Browser smoke tests then confirmed:

- **Create:** synthetic SKU `PH5-CRUD-CHECK` was created successfully.
- **Update:** its price changed from Rp 12.345 to Rp 12.346 and stock from 3 to 4 successfully.
- **Delete:** the browser automation clicked the Hapus control but did not complete the native browser `confirm()` interaction. A D1 check showed the SKU remained active; therefore the delete endpoint was not confirmed by this test. The synthetic SKU and the two catalog fixtures were subsequently cleaned directly from the isolated Preview D1 after verifying that no order or inventory references existed.

The implementation's current delete path is a **soft delete** (sets `active=0`) to preserve catalog references/history, rather than physically removing the row. The UI's native confirmation behavior and the soft-delete endpoint still need a dedicated interactive check in a normal browser.

### Remaining untested areas

- R2 product-photo upload/read/delete with synthetic image bytes.
- Full cart/checkout/order lifecycle in Preview.
- Telegram end-to-end messaging. No Telegram bot token is configured in Preview.
- Production Google Sheets mirror behavior. It is intentionally not configured in Preview.

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

- Preview D1, Preview R2, and the Preview-specific Durable Object namespace are isolated from Production resources.
- The Preview-only Cloudflare Access application targets the exact `seiton-order-bot` Preview.
- Preview URLs are protected by the owner-only Access policy.
- Preview D1 migrations were applied only to `seiton-preview-transactions-20261109`.
- Preview was initialized with an empty legacy import; no Production catalog or order rows were imported.
- Synthetic catalog fixtures and their catalog-mirror outbox rows were removed after testing. Preview D1 has zero catalog products, orders, order items, and inventory movements; readiness remains `READY`.
- Preview catalog CRUD changes are guarded by `APP_ENV=preview`; Google Sheets preflight and mirroring are skipped only for Preview.
- No Production Worker deployment or update was performed.
- No Production D1 or R2 resource was modified.
- No Production secret values were read or copied.
- No Production bindings, routes, cron triggers, Sheets destination, bot token, or admin chat ID were changed.
- Work remains on `feat/phase-3-r2-product-media-2026-11-09`; no merge to `main` was performed.
