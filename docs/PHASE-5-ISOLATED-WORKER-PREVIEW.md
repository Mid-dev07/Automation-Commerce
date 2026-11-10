# Phase 5 — Isolated Worker Preview

Date: 2026-11-10  
Status: **Preview deployment #5 active. Health, dashboard, D1 readiness, catalog create/update, R2 bucket object CRUD, and SQL soft-delete semantics have been checked. Browser-level photo upload and post-#5 delete confirmation still need an authenticated browser run.**

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
- Latest deployment number: **5**
- Latest deployment ID: `05becbf1-f34c-41fe-9b86-82d293499033`
- Source commit: `51c00fff1fe9bdffda26fcf4998f696e6268a479`
- Uploaded modules: `worker.js`, `transaction-layer.js`, `cart-layer.mjs`, `messaging-core.mjs`, `product-media.mjs`

Stable Preview URLs:

- `https://phase-5-isolated-preview.automate-bot.seiton.biz.id`
- `https://phase-5-isolated-preview-seiton-order-bot.midzpribadi.workers.dev`

Latest deployment URLs:

- `https://05becbf1.automate-bot.seiton.biz.id`
- `https://05becbf1-seiton-order-bot.midzpribadi.workers.dev`

Latest deployment bindings were checked after deployment #5:

| Binding | Preview target |
| --- | --- |
| `DB` | Preview D1 `c98e9147-8a53-4fb1-bee2-d33e966baeb7` |
| `PRODUCT_MEDIA` | Preview R2 `seiton-preview-product-media-20261109` |
| `ORDER_COORDINATOR` | Preview-specific SQLite Durable Object namespace `2bae989dc0364fef855fd80d3fc0cf4c` |
| `ADMIN_LOGIN_RATE_LIMITER` | Preview-only namespace `2026110902` |
| `APP_ENV` | `preview` |

Both `ADMIN_WEB_PASSWORD` and `TELEGRAM_WEBHOOK_SECRET` remain attached as secret bindings. Deployment #5 was created with a JSON Merge Patch that changed the Worker module and annotations only; omitted bindings were inherited from deployment #4. Secret values were not read, copied, or changed.

The Preview does not contain `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY`, or `TELEGRAM_TOKEN`. Production secret values and Production resource bindings were not copied into this Preview.

Deployment #1 was deleted after an audit found an unexpected secret binding in its metadata. Deployments #2–#4 are earlier Preview revisions; deployment #5 is the latest active version.

## 6. Runtime validation status

The account owner completed the Cloudflare Access sign-in in a dedicated Browser Context Profile. Authenticated browser checks on deployment #4 passed through the Preview-only Access application and showed the admin dashboard. The D1-backed session registry was preserved when deployment #5 was patched, but the updated delete dialog has not yet been re-checked in a browser after deployment #5.

### Health and dashboard

- On deployment #4, `GET /health` returned HTTP **200**.
- The health JSON reported `ok: true`, service `seiton-order-bot`, and `transaction_store: READY`.
- The root admin dashboard loaded with navigation: Ringkasan, Pesanan, Verifikasi Pembayaran, Produk & Katalog, and Laporan.
- With the clean transaction store, verified revenue, orders, and pending verification were zero; the two synthetic catalog fixtures appeared as active products.

### D1 initialization and isolation

The repository migrations created the schema, but the application readiness marker was initially absent. The normal `/migrasi_d1` Telegram command reads Google Sheets to import historical catalog/order data. That command was deliberately not run in Preview because it would require Production Sheets credentials and could import real Production rows.

Instead, Preview was initialized with an empty legacy import marker and `transaction_store_state=READY`. No Production rows were imported.

After the catalogue and soft-delete checks, all synthetic catalog fixtures, temporary outbox rows, and test SKUs were removed. Before cleanup, references in `orders`, `order_items`, and `inventory_movements` were checked and were zero. Latest post-cleanup verification:

| Preview D1 table/state | Count/value |
| --- | ---: |
| `catalog_products` | 0 |
| `orders` | 0 |
| `order_items` | 0 |
| `inventory_movements` | 0 |
| `app_meta.transaction_store_state` | `READY` |

### Catalog create/update and Preview isolation

Deployment #2 exposed a Preview-specific problem: the product mutation handler called `ensureCatalogHeaders()` and attempted a Google Sheets operation before saving to D1. Preview intentionally has no Production Google Sheets ID or service-account key.

Commit `2883f78012bee8b36c0c4d2071f0a02e16d3a465` fixed that boundary:

- `APP_ENV=preview` skips the Google Sheets catalog-header preflight.
- Preview catalog save/delete paths skip Google Sheets mirroring.
- Non-Preview behavior is unchanged.

Deployment #4 browser smoke tests confirmed Create and Update for the synthetic SKU `PH5-CRUD-CHECK`: price changed from Rp 12.345 to Rp 12.346 and stock from 3 to 4. The SKU and the two initial fixtures were then cleaned from Preview D1 after verifying that no order or inventory references existed.

### Delete behavior

The current catalog delete operation is intentionally a **soft delete**: it sets `catalog_products.active=0` and enqueues a retryable catalog mirror, preserving transaction/history references. It does not physically delete the catalog row.

The previous browser automation could not complete the native `window.confirm()` dialog. The UI was therefore changed in commit `51c00fff1fe9bdffda26fcf4998f696e6268a479` to use the panel's own modal confirmation. The dialog now explicitly explains that the product will be hidden from customers, history is retained, and the product can be reactivated through Atur. Deployment #5 contains this change.

A D1 SQL-level synthetic soft-delete check confirmed the test SKU becomes `active=0`; the temporary row and mirror outbox entry were then removed. This validates the database semantics, not the authenticated Worker endpoint or the updated browser modal. Those require a browser verification after deployment #5.

### R2 product-media checks

The R2 bucket was checked empty before testing. A synthetic 1×1 PNG (70 bytes) was uploaded directly to the Preview R2 bucket through the Cloudflare R2 API. The object was read back as 70 bytes with the PNG signature `89504e470d0a1a0a`, then deleted. A follow-up GET returned HTTP 404, and a final prefix listing showed zero objects.

This verifies Preview bucket object PUT/GET/DELETE. It does **not** exercise the authenticated application endpoint `POST /api/admin/products/photo`, the Worker `storeProductImage` binding path, or the public Worker `GET /media/...` route. A public route fetch was intercepted by Cloudflare Access when attempted without a profile-bound browser session. Full upload-and-render verification remains pending.

### Remaining untested areas

- Authenticated browser test of the deployment #5 soft-delete modal and resulting non-active product row.
- Full admin photo upload through `POST /api/admin/products/photo`, followed by a public `/media/...` GET/HEAD check and cleanup.
- Full cart/checkout/order lifecycle in Preview.
- Telegram end-to-end messaging. No Telegram bot token is configured in Preview.
- Production Google Sheets mirror behavior. It is intentionally not configured in Preview.
- GitHub Actions contract tests added on the feature branch have not been triggered by the current workflow rules (the workflow runs on `main` pushes and pull requests targeting `main`).

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
- Preview D1 migrations and the empty readiness initialization were applied only to `seiton-preview-transactions-20261109`.
- No Production catalog or order rows were imported into Preview.
- Synthetic D1 products, outbox rows, and the R2 object created during testing were removed. Latest checks show zero catalog products, orders, order items, inventory movements, and R2 objects; readiness remains `READY`.
- Preview catalog mutation paths skip Google Sheets header preflight and mirroring only when `APP_ENV=preview`.
- Deployment #5 changed only the Preview worker module and deployment annotations; secret values and bindings were preserved and verified by type/presence and resource IDs.
- No Production Worker deployment or update was performed.
- No Production D1 or R2 resource was modified.
- No Production secret values were read or copied.
- No Production bindings, routes, cron triggers, Sheets destination, bot token, or admin chat ID were changed.
- Work remains on `feat/phase-3-r2-product-media-2026-11-09`; no merge to `main` was performed.


## 9. Non-browser regression continuation — 2026-11-10

This continuation intentionally avoided TinyFish and did not change Worker runtime code.

### Product-media unit coverage

The existing `tests/product-media.test.cjs` suite already covered signature detection, forged MIME rejection, generated R2 keys, safe HTTP metadata, URL construction, GET/HEAD media serving, path validation, delete-key validation, and R2 compensation when D1 persistence fails.

Three additional boundary cases were added:

- Accept an image exactly at the 5 MiB limit.
- Return HTTP 503 when media storage is unavailable and HTTP 415 when a stored object has an unsupported MIME type.
- Return HTTP 412 when an R2 GET result has no body.

Commit: `7a8389b2bfbdcee2ed04ab374a41909d9bca627b`.

### Feature-branch CI trigger

The `Cart regression checks` workflow now also runs on pushes to this isolated feature branch:

`feat/phase-3-r2-product-media-2026-11-09`

It still runs for pull requests targeting `main` and retains its manual `workflow_dispatch` trigger. The workflow runs Worker/module syntax checks, all `tests/*.test.cjs` suites, and Messaging Core unit tests under Node 24.

Commit: `8fc7588c04c37550ef9bc0f46235c9e25c1f1b08`.

The connected GitHub status endpoint did not expose a verifiable run result for this branch-push event. Therefore the new commit is **not recorded as CI-passing** here. The last previously documented successful workflow result remains Worker/cart regression 93/93 and Messaging Core 26/26, before these latest test changes.

### Read-only Preview resource recheck

Cloudflare API read-only queries confirmed:

- Preview D1 `transaction_store_state=READY`.
- `catalog_products=0`, `orders=0`, `order_items=0`, and `inventory_movements=0`.
- Preview R2 prefix `products/` contains zero objects.

No synthetic records or objects were created by this recheck. No Worker code was uploaded, no Preview deployment was created, and no Production resource was written.

### Remaining verification

- Confirm the GitHub Actions run for the branch-push commit from the Actions page.
- Authenticated browser test of the deployment #5 delete modal and the complete admin product-photo upload flow.
- Full cart/checkout/order lifecycle and Telegram end-to-end checks remain separate follow-up work.
