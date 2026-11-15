# Mail Automation source and P3 integration

## Runtime provenance
- Production Worker: `seiton-mail-automation`.
- The deployed source was retrieved read-only from the Cloudflare Workers Script Content API on 2026-11-15.
- `worker.js` and `email-parser.js` are the repository-managed source used for review and future controlled releases.
- The repository source includes P3 machine API additions that are not yet present in the currently deployed Worker. Do not treat repository source as deployed runtime state.

## Machine API contract
All machine endpoints require `Authorization: Bearer <MAIL_VM_API_TOKEN>`. The token is compared in constant-time and hashed before it is used to scope records.

- `GET /api/v1/machine/health`: reports Worker/D1 readiness, not inbound Email Routing readiness.
- `GET /api/v1/machine/aliases?limit=50&offset=0`: lists aliases owned by the token hash; returns metadata only.
- `POST /api/v1/machine/aliases`: creates an alias; `clientRef` is idempotent within the token scope.
- `GET /api/v1/machine/messages?aliasId=...`: lists message metadata for an alias owned by the token.
- `GET /api/v1/machine/messages/:id?aliasId=...`: decrypts a message only after alias ownership is verified.
- `DELETE /api/v1/machine/aliases/:id`: revokes an alias only when it belongs to the token hash.

Alias creation idempotency and hourly quota are scoped by `token_hash`; one machine integration must not consume another integration's quota or collide on its client reference.

## Owner Control Center integration
- `MAIL_BACKEND` is a Cloudflare service binding from `seiton-site-admin` to `seiton-mail-automation`.
- `MAIL_VM_API_TOKEN` is a server-side secret on the Owner Worker. Never place it in browser HTML, JavaScript, logs, or repository files.
- Owner endpoints require the owner session. Mutations additionally require the configured same-origin allowlist.
- Message bodies and verification codes are fetched only after the owner explicitly opens a message.
- Audit events store alias identifiers and action metadata only; no message body or OTP value.
- Email Routing remains `unverified` until the configured inbound route is tested end-to-end.

## Release boundary
This branch is source/code work only. No production Worker, D1 migration, secret, service binding, DNS, or Email Routing configuration has been changed. Before release, reconcile bindings and secret names, run CI, deploy to a preview/staging environment, and perform authenticated desktop/mobile UAT plus a controlled inbound-email test.

## Known schema constraint
The current production schema defines `mail_machine_aliases.client_ref` as globally UNIQUE, not UNIQUE per `token_hash`. The application lookup and hourly quota are token-hash scoped, but a future second machine token using the same client reference could still hit a database uniqueness conflict. This is not an authorization bypass; it is a multi-token compatibility limitation. Do not claim multi-token isolation until a reviewed D1 table-rebuild migration changes the constraint to `UNIQUE(token_hash, client_ref)` and passes migration tests. No migration has been applied.

## Domain migration dependency (2026-11-15)
The requested migration target is `seiton.my.id`. Cloudflare currently has the new zone `seiton.my.id` in `pending` status; its DNS still contains parked-domain A/TXT records and Email Routing is `unconfigured`/disabled. The existing `seiton.biz.id` zone is active and its `inbox.seiton.biz.id` Email Routing subdomain is `ready`, with the current Worker rule targeting `receiver@inbox.seiton.biz.id`.

This repository snapshot still hard-codes `PANEL_ORIGIN=https://mail.seiton.biz.id` and `MAIL_DOMAIN=inbox.seiton.biz.id`. Do not deploy the P3 Mail Worker integration or change the live routing until the domain migration is completed deliberately. The target hostname and alias address must be confirmed from the migration plan, then all recipient validation, generated alias addresses, origin checks, DNS, Email Routing subdomain/rule, and Worker settings must move together. Keep the old zone and route available during cutover until inbound delivery on the new zone is proven end-to-end.
