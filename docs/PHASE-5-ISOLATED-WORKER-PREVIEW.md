# Phase 5 — Isolated Worker Preview

Date: 2026-11-09  
Status: Preview D1/R2 resources provisioned; eight D1 migrations and stock-flow smoke tests passed; Worker Preview deployment held until Preview-only Access is initialized.

Latest successful GitHub Actions run before the docs-only status update: Worker/cart regression **93/93 passed**, Messaging Core **26/26 passed**. Preview URL opt-in is covered by a regression test.

## 1. Isolated resources provisioned

The Cloudflare account now has dedicated, empty Preview resources in APAC:

| Resource | Name | Identifier |
| --- | --- | --- |
| D1 | `seiton-preview-transactions-20261109` | `c98e9147-8a53-4fb1-bee2-d33e966baeb7` |
| R2 | `seiton-preview-product-media-20261109` | Bucket name |

The D1 database was created with read replication disabled. The new D1 database reported zero tables at creation time. The R2 bucket uses the Standard storage class. Neither resource is the production D1 database or production R2 bucket.

## 2. Preview configuration

The root `wrangler.jsonc` includes a dedicated `previews` block:

- `DB` points to `seiton-preview-transactions-20261109`.
- `PRODUCT_MEDIA` points to `seiton-preview-product-media-20261109`.
- `ORDER_COORDINATOR` is configured for the Preview runtime. Cloudflare provisions separate Durable Object namespace/storage for each Preview.
- `APP_ENV=preview` is set.
- Production cron triggers, routes, and service bindings are not copied into the Preview block.
- No production secrets, Telegram credentials, Google service account, or Google Sheets identifier are configured for Preview. The Preview must not send Telegram messages or mirror into the production Sheet unless a separate test-only integration is intentionally configured.

A separate `wrangler.preview-migrations.jsonc` points D1 migrations directly at the isolated Preview database. This avoids accidentally applying migrations to the production database named in the top-level Wrangler config.

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

## 4. Why Preview deployment is currently blocked

Cloudflare documents that Preview URLs are public by default unless protected by Cloudflare Access. Both the Access API read and a scoped attempt to create a `preview_worker` Access application returned `access.api.error.not_enabled`. The saved browser profile available to this session has no recorded Cloudflare sign-in, so the dashboard's initial Access activation still requires the owner to authenticate interactively.

A read-only Workers subdomain check returned `enabled=true` and `previews_enabled=false`: the production `workers.dev` route is enabled, but Preview URLs remain disabled. No Access application was created. No Preview deployment or URL was published.

Do not enable Preview URLs or run the Preview command until Cloudflare Access protects **Preview URLs only** on `seiton-order-bot`, with an Allow policy for the owner's sign-in identity. Do not enable Access for production traffic or all Workers.

Dashboard sequence:

1. Open **Workers & Pages** and select `seiton-order-bot`.
2. Open **Settings → Domains & Routes** and enable Cloudflare Access for **Preview URLs only**.
3. Configure the Access allow policy for the owner's sign-in identity.
4. Open the Worker's **Domains** tab. Under **Worker URL**, enable **Preview** only after Access protection is active.
5. Confirm the Preview URL is protected before creating the Preview.

The repository intentionally does not set `preview_urls: true`; a regression test prevents enabling Preview URLs from source before the Access gate is completed.

Cloudflare documentation:
- https://developers.cloudflare.com/workers/previews/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://developers.cloudflare.com/workers/previews/resources/

## 5. Controlled Preview commands

The eight migrations have already been applied to the Preview D1 database via the Cloudflare D1 API because the saved session did not allow interactive Wrangler CLI execution. The equivalent Wrangler config is pinned to the same Preview database ID. Do not re-run the migrations blindly: first check `d1_migrations` or use the read-only list command below.

```sh
npx --yes wrangler@4.135.0 d1 migrations list seiton-preview-transactions-20261109 --config wrangler.preview-migrations.jsonc --remote
```

After Preview-only Access is active, create the Preview from this branch:

```sh
npx --yes wrangler@4.135.0 preview --name phase-5-isolated-preview --ignore-base-config --json
```

Worker Previews require Wrangler 4.135.0 or later. Continue to use `wrangler.preview-migrations.jsonc` for any D1 migration commands; it targets the isolated Preview database, never the production database.

## 6. Test-only secrets

Do not copy production secrets into Preview. For browser-admin tests, configure a new test-only password for this Preview using Wrangler's interactive prompt:

```sh
npx --yes wrangler@4.135.0 preview secret put ADMIN_WEB_PASSWORD --name phase-5-isolated-preview
```

For Telegram end-to-end testing, use a separate test bot and test chat only. Do not use the live Seiton bot token, live admin chat ID, Google service-account key, or production Sheets identifier. No test Telegram credentials are configured here, so Telegram send/webhook tests remain unexecuted.

## 7. Regression coverage

`tests/worker-preview-config.test.cjs` verifies:

- Preview D1 ID and name differ from the production D1 binding.
- Preview R2 bucket name differs from the production bucket.
- The standalone migration config targets the same Preview D1 as the Preview runtime.
- Durable Object binding is present.
- Preview does not declare cron triggers, production routes, or service bindings.
- Production secret names and the Google Sheets target are absent from Preview configuration.

GitHub Actions also runs the existing Worker/cart regression and Messaging Core suites. Passing CI validates repository contracts, not the remote Preview runtime.

## 8. Safety status

- Created only the two dedicated Preview resources listed above.
- No production Worker deployment or update was performed.
- No Preview deployment or public Preview URL was created. The live Worker subdomain setting still reports `previews_enabled=false`.
- Eight D1 migrations were applied to Preview only; production D1 was not modified.
- No production rows or secrets were read or written.
- No production binding, R2 bucket, bot token, Sheets destination, cron, or route was changed.
- Preview runtime smoke testing remains pending Preview-only Cloudflare Access protection.
