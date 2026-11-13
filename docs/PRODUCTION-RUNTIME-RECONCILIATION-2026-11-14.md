# Production Runtime Reconciliation — 2026-11-14

## Scope and result

The live Cloudflare module bundles were read directly through the Cloudflare Workers API and compared with GitHub source. No secret values were read, written, or committed. This change updates only the repository; it does not alter production Workers, routes, D1 data, KV data, R2 objects, Telegram webhook settings, or Email Routing.

## `seiton-order-bot`

- Production entry point: `worker.js`; compatibility date: `2026-11-03`.
- The live `worker.js` matches repository source exactly.
- `transaction-layer.js`, `messaging-core.mjs`, and `digital-products.mjs` match after trimming the terminal newline only; no code-line differences were found.
- Bindings: D1 `DB`; KV `MUSE_KV`, `OTP_KV`; Durable Object `ORDER_COORDINATOR`; R2 `PRODUCT_MEDIA`; rate limiter `ADMIN_LOGIN_RATE_LIMITER`; vars `GOOGLE_SHEETS_ID`, `OTP_EMAIL_ROUTING_READY`, `OTP_PORTAL_URL`; Telegram, Google, admin, and stock-encryption secrets.
- Repository config now declares production R2 binding. Optional `ORDERS_KV` and `TOKEN_KV` code paths are guarded and do not block primary runtime when absent.

## `seiton-otp-portal`

- Production entry point: `index.js`; compatibility date: `2026-11-13`; compatibility flag: `nodejs_compat`.
- Production modules `index.js` and `email-parser.js` are now versioned in the repository.
- The older `otp-portal/worker.js` remains for historical traceability; it is not the deployment entry point.
- Bindings: Durable Object `MAILBOX_INDEX` / `MailboxIndex` (SQLite namespace verified in Cloudflare); KV `MUSE_KV`, `OTP_KV`; vars `OTP_ALLOWED_DOMAINS`, `OTP_PORTAL_URL`; secrets `OTP_EMAIL_ENCRYPTION_KEY`, `OTP_INTERNAL_SECRET`.
- Wrangler config now reflects the entry point, compatibility flag, vars, KV namespaces, and existing Durable Object binding.
- The existing Durable Object namespace is confirmed to exist. Its migration history was not exposed by the runtime settings read; do not deploy until the existing class migration history is checked against Wrangler migration metadata.

## `seiton-site-admin`

- Production entry point: `worker.js`; compatibility date: `2026-11-04`.
- The production source replaced the shorter, stale repository copy.
- Bindings: service `ORDER_BACKEND` → `seiton-order-bot`; service `OTP_BACKEND` → `seiton-otp-portal`; D1 `SITE_DB`; secret `OTP_INTERNAL_SECRET`.
- Wrangler config now declares both service bindings and the existing D1 binding.
- The source contains an unused legacy HMAC session helper that references `SITE_ADMIN_SESSION_SECRET`; it has no call sites. Do not provision a new secret solely for that dead helper. Remove it in a later reviewed cleanup if desired.

## Validation added

- CI syntax checks now include the production OTP portal entry point, email parser, and site-admin Worker.
- A regression test verifies all three Wrangler configs against the observed entry points and critical bindings.
- Existing Worker and Messaging Core regression suites remain enabled.
- No production D1 migrations were applied.

## Release status

Repository reconciliation is prepared for CI and review. Production deploy remains blocked pending:
1. Passing CI for this branch/PR.
2. Preview smoke tests for order bot, OTP portal, and site-admin.
3. Verification of the existing OTP Durable Object migration history.
4. Explicit approval before any production deployment.
