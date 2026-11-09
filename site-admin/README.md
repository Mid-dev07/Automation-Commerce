# Seiton owner admin Worker

Source for the production owner pricing panel at https://admin.seiton.biz.id/.

## Bindings

- `ORDER_BACKEND`: service binding to `seiton-order-bot` production.
- `SITE_DB`: D1 database `seiton-site-content-prod`.

## Login and sessions

- The owner panel forwards the edge-provided `CF-Connecting-IP` and `X-Real-IP` to `seiton-order-bot` through the same-zone service binding.
- The backend pseudonymizes the client IP with its existing `TELEGRAM_WEBHOOK_SECRET`.
- Browser sessions are registered in `SITE_DB` using a SHA-256 token fingerprint. The raw backend token is never stored in D1.
- Sessions expire after eight hours, have a last-seen timestamp, and can be revoked server-side from the panel.
- The session cookie remains `Secure; HttpOnly; SameSite=Strict`.
- Login, logout, pricing writes, and session revocation require the exact owner-panel Origin.

## Audit trail

The panel records successful logins, session revocations, and catalog changes. Pricing/catalog audit entries are written in the same D1 batch transaction as the replacement catalog rows. Audit summaries include names, prices, availability, and changed field names; they exclude passwords, session tokens, raw IP addresses, and customer-message text.

Audit history is append-only through the panel API and can be viewed from the owner admin UI.

## Site database migrations

The owner panel uses a separate database from the order bot. Its migrations live in `site-admin/migrations/` and are configured by `migrations_dir` in `site-admin/wrangler.jsonc`.

Apply the migration to the production **seiton-site-content-prod** database:

```sh
npx wrangler d1 migrations apply seiton-site-content-prod --remote --config site-admin/wrangler.jsonc
```

Do not apply these migrations to `seiton-transactions-prod`.

## Deployment

Deploy with:

```sh
npx wrangler deploy --config site-admin/wrangler.jsonc
```

Then verify that the `seiton-site-admin` Worker remains attached to `admin.seiton.biz.id`.
