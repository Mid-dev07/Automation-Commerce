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

## Domain migration — root-domain aliases (2026-11-15)
- Alias addresses use the root domain `seiton.my.id`, with no `inbox` subdomain.
- New aliases are generated as `receiver+<24-hex-slug>@seiton.my.id`; inbound validation accepts both `seiton.my.id` and the legacy `inbox.seiton.biz.id` while checking the same active alias format. This dual-domain compatibility is required so existing aliases continue receiving messages during cutover.
- The private web panel remains hosted at `https://mail.seiton.biz.id`; `PANEL_ORIGIN` is intentionally unchanged because this migration changes the alias email domain, not the admin-panel hostname.
- The new Cloudflare zone `seiton.my.id` is now `active` and uses `aria.ns.cloudflare.com` and `clark.ns.cloudflare.com`.
- Its Email Routing state is still `unconfigured`/disabled. The current zone has Cloudflare-generated candidate MX/SPF/DKIM settings available through the Email Routing DNS endpoint, but these have not yet been applied.
- The new zone currently has parked-domain A/TXT records. Preserve unrelated A records until the website-hosting intent for the apex and `www` is separately confirmed; the mail migration only needs the root MX, SPF, DKIM, plus-addressing setting, and Worker rule.
- The legacy `receiver+<slug>@inbox.seiton.biz.id` path must remain in place during the cutover. Its current exact Worker route is `receiver@inbox.seiton.biz.id`, with subaddressing enabled on the old zone.
- The new Email Routing rule must target `receiver@seiton.my.id` with subaddressing enabled, and deliver to the existing `seiton-mail-automation` Worker.
- Do not switch the production routing rule or claim the migration complete until the deployed Worker accepts the new domain and a real inbound test confirms alias persistence and OTP parsing end-to-end.

## Release boundary
This domain change is repository source work only until the reviewed release is deployed. No production Worker, D1 migration, secret, service binding, DNS record, or Email Routing setting was changed by this commit.
