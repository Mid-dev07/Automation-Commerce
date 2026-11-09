# Phase 5 — Isolated Worker Preview

Date: 2026-11-09  
Status: preview resources provisioned and branch configuration prepared; runtime deployment held until Preview URL access is protected.

## 1. Isolated resources provisioned

The Cloudflare account now has dedicated, empty Preview resources in APAC:

| Resource | Name | Identifier |
| --- | --- | --- |
| D1 | `seiton-preview-transactions-20261109` | `c98e9147-8a53-4fb1-bee2-d33e966baeb7` |
| R2 | `seiton-preview-product-media-20261109` | Bucket name |

The D1 database was created with read replication disabled. The new D1 database reported zero tables at creation time. The R2 bucket uses the Standard storage class. Neither resource is the production D1 database or production R2 bucket.

## 2. Preview configuration

The root `wrangler.jsonc` now includes a dedicated `previews` block:

- `DB` points to `seiton-preview-transactions-20261109`.
- `PRODUCT_MEDIA` points to `seiton-preview-product-media-20261109`.
- `ORDER_COORDINATOR` is configured for the Preview runtime. Cloudflare provisions separate Durable Object namespace/storage for each Preview.
- `APP_ENV=preview` is set.
- Production cron triggers, routes, and service bindings are not copied into the Preview block.
- No production secrets, Telegram credentials, Google service account, or Google Sheets identifier are configured for Preview. The Preview must not send Telegram messages or mirror into the production Sheet unless a separate test-only integration is intentionally configured.

A separate `wrangler.preview-migrations.jsonc` points D1 migrations directly at the isolated Preview database. This is intentional: running a migration command with the root `wrangler.jsonc` and no explicit Preview-migration config would be unsafe because its top-level D1 binding still identifies production.

## 3. Why Preview deployment is currently blocked

Cloudflare documents that Preview URLs are public by default unless protected by Cloudflare Access. An account-level Access API read returned `access.api.error.not_enabled`. Access is not enabled on this account at present.

No Preview deployment was created and no Preview URL was published. Do not run the Preview command until Access protection has been enabled for **Preview URLs only** on the `seiton-order-bot` Worker, with an allow policy for the owner. Do not enable protection for production traffic or all Workers as a side effect.

Dashboard path:

1. Open **Workers & Pages** and select `seiton-order-bot`.
2. Open **Settings → Domains & Routes**.
3. Enable Cloudflare Access for **Preview URLs only**.
4. Set the allow policy to the owner's sign-in identity.
5. Confirm the Preview URL is protected before creating the Preview.

Cloudflare documentation:
- https://developers.cloudflare.com/workers/previews/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://developers.cloudflare.com/workers/previews/resources/

## 4. Controlled Preview commands

After Preview-only Access is confirmed, run these commands from the Phase 5 branch. The exact Wrangler version is pinned because Worker Previews require Wrangler 4.135.0 or later.

First, apply migrations to the Preview database only:

```sh
npx --yes wrangler@4.135.0 d1 migrations apply seiton-preview-transactions-20261109 --config wrangler.preview-migrations.jsonc --remote
```

Inspect the Preview migration list:

```sh
npx --yes wrangler@4.135.0 d1 migrations list seiton-preview-transactions-20261109 --config wrangler.preview-migrations.jsonc --remote
```

Only after Preview URL protection has been verified, create the Preview:

```sh
npx --yes wrangler@4.135.0 preview --name phase-5-isolated-preview --ignore-base-config --json
```

The commands above are deliberately not executed by this phase. The migration command targets only the D1 resource declared in `wrangler.preview-migrations.jsonc`; it must not be changed to the production database name.

## 5. Test-only secrets

Do not copy production secrets into Preview. For browser-admin tests, configure a new test-only password for the specific Preview using Wrangler's interactive prompt:

```sh
npx --yes wrangler@4.135.0 preview secret put ADMIN_WEB_PASSWORD --name phase-5-isolated-preview
```

For Telegram end-to-end testing, use a separate test bot and test chat only; add its credentials to the specific Preview with `wrangler preview secret put`. Do not use the live Seiton bot token, live admin chat ID, Google service-account key, or production Sheets identifier. The absence of test Telegram credentials is intentional and means Telegram send/webhook tests remain unexecuted in this preview.

## 6. Regression coverage

`tests/worker-preview-config.test.cjs` verifies:

- Preview D1 ID and name differ from the production D1 binding.
- Preview R2 bucket name differs from the production bucket.
- The standalone migration config targets the same Preview D1 ID as the Preview runtime.
- Durable Object binding is present.
- Preview does not declare cron triggers, production routes, or service bindings.
- No production secret names or Google Sheets ID are configured under Preview.

GitHub Actions also runs the existing Worker/cart regression and Messaging Core suites. Passing CI validates repository contracts, not the remote Preview runtime.

## 7. Safety status

- Created only the two dedicated Preview resources listed above.
- No production Worker deployment or update was performed.
- No Preview deployment or public Preview URL was created.
- No D1 migration was applied to production or Preview in this phase.
- No production rows or secrets were read or written.
- No production binding, R2 bucket, bot token, Sheets destination, cron, or route was changed.
- Preview runtime smoke testing remains pending Preview-only Cloudflare Access protection and the owner's controlled deploy/migration run.
