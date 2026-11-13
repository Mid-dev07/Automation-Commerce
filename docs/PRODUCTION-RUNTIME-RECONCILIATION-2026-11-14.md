# Production Runtime Reconciliation — 2026-11-14

## Scope

Read-only comparison of Cloudflare production Worker metadata, deployed module inventory, repository source inventory, and binding configuration. No Worker source, secrets, bindings, database schema/data, webhook, route, or deployment was modified.

## Production Worker inventory

### `seiton-order-bot`

Production compatibility date: `2026-11-03`

Bindings observed:
- D1 `DB` → `seiton-transactions-prod`
- KV `MUSE_KV`, `OTP_KV`
- Durable Object `ORDER_COORDINATOR` / `OrderCoordinator`
- R2 `PRODUCT_MEDIA` → `seiton-product-media`
- Rate limiter `ADMIN_LOGIN_RATE_LIMITER`
- Plain vars `GOOGLE_SHEETS_ID`, `OTP_EMAIL_ROUTING_READY`, `OTP_PORTAL_URL`
- Secrets exist for Telegram, Google service account, admin password/chat ID, and stock encryption. Secret values are intentionally not recorded.

Deployed modules and byte counts observed:
- `worker.js` — 208,963
- `transaction-layer.js` — 38,096
- `messaging-core.mjs` — 29,385
- `digital-products.mjs` — 18,030

Repository root has corresponding module names. File sizes are close; this is not a cryptographic equality proof. The current root `wrangler.jsonc` includes D1, both KV namespaces, Durable Object, and rate limiter, but omits the production R2 binding `PRODUCT_MEDIA`. Do not deploy until this omission is corrected and the bundle is reproducibly built and tested.

### `seiton-otp-portal`

Production compatibility date: `2026-11-13`

Bindings observed:
- Durable Object `MAILBOX_INDEX` / `MailboxIndex`
- KV `MUSE_KV`, `OTP_KV`
- Plain vars `OTP_ALLOWED_DOMAINS`, `OTP_PORTAL_URL`
- Secrets `OTP_EMAIL_ENCRYPTION_KEY`, `OTP_INTERNAL_SECRET`

Deployed modules:
- `index.js` — 31,074 bytes
- `email-parser.js` — 5,745 bytes

Repository source currently has `otp-portal/worker.js` (17,046 bytes), and its Wrangler config only declares `OTP_KV`. Entrypoint, module inventory, and bindings therefore materially differ. This Worker cannot safely be deployed from the current repository.

### `seiton-site-admin`

Production compatibility date: `2026-11-04`

Bindings observed:
- Service `ORDER_BACKEND` → `seiton-order-bot` production
- Service `OTP_BACKEND` → `seiton-otp-portal` production
- D1 `SITE_DB` → `seiton-site-content-prod`
- Secret `OTP_INTERNAL_SECRET`

Deployed module:
- `worker.js` — 49,047 bytes

Repository `site-admin/worker.js` is 39,603 bytes. The current config declares `ORDER_BACKEND` and `SITE_DB` but omits `OTP_BACKEND`. This Worker cannot safely be deployed from the current repository.

## Required reconciliation actions

1. Recover the exact deployed OTP portal source modules and add them to version control as source files, with an audited diff against the current legacy `worker.js`.
2. Recover the exact deployed site-admin source and replace or archive the shorter repository version only after behavior and tests are compared.
3. Add the production R2 binding declaration to the order-bot deploy configuration, preserving its exact bucket name.
4. Add `MAILBOX_INDEX`, `MUSE_KV`, `OTP_ALLOWED_DOMAINS`, `OTP_PORTAL_URL`, and required secret *names* to OTP deployment documentation/configuration; never commit secret values.
5. Add `OTP_BACKEND` service binding to site-admin config.
6. Build all three Workers from the repository and compare module inventory, bindings, compatibility dates, and entrypoint against the Cloudflare runtime.
7. Add staging/preview contract tests for order bot, OTP portal, and admin before any production deployment.

## Safety status

- No production deployment was performed.
- No secrets were read or written.
- No D1 migrations or data mutations were performed.
- Existing live Workers and routes were left unchanged.
- The current GitHub source remains non-deployable for OTP portal and site-admin until steps 1–2 are completed.
