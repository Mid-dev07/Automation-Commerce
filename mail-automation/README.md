# Seiton TMail — Mail Automation

Private, inbound-only temporary mailbox service for Seiton. The public panel remains at
https://mail.seiton.biz.id/; mailbox addresses are created on seiton.my.id.

## TMail mailbox model

- New addresses use a cryptographically random 32-character hexadecimal local part:
  <random-32-hex>@seiton.my.id.
- New mailbox lifetime is fixed at 10 minutes. Clients cannot request a longer TTL.
- The Worker accepts mail only for an active mailbox record and rejects unknown, expired,
  revoked, or over-limit addresses.
- Existing receiver+<24-hex>@seiton.my.id addresses and
  receiver+<24-hex>@inbox.seiton.biz.id remain readable during the migration. Their
  original expiry is retained; no existing row or message is rewritten.
- Maximum accepted messages per mailbox remains 100.
- The cleanup cron remains every 10 minutes. It expires new TMail mailboxes and removes
  their messages after expiry. Legacy plus-alias messages keep the previous 30-day retention.

## Runtime and bindings

- Worker: seiton-mail-automation
- Entry point: worker.js
- D1: seiton-mail-automation-prod
- D1 binding: MAIL_DB
- Compatibility date: 2026-11-14
- Cron: */10 * * * *

The current design intentionally uses D1 for mailbox/session/message metadata and
AES-GCM-encrypted message payloads. It does not require KV or R2 for the 10-minute
mailbox flow. Attachments are not stored or exposed in this implementation.

The Worker continues to use these Cloudflare secrets (names only; values must never be
committed to Git):

- MAIL_MESSAGE_ENCRYPTION_KEY
- MAIL_SESSION_SECRET
- MAIL_SETUP_TOKEN
- MAIL_VM_API_TOKEN

Do not reset, recreate, or migrate the existing production D1 database as part of this
change. The legacy table names remain for backward compatibility.

## Access control

- The owner panel continues to require the existing private owner login and secure,
  HttpOnly session cookie.
- Machine endpoints continue to require the MAIL_VM_API_TOKEN Bearer token, rate
  limiting, per-token mailbox ownership, and per-token message access checks.
- Expired mailbox messages are no longer returned by the owner inbox API; scheduled
  cleanup removes them after expiration.
- The upstream T-Mail example is used only as a reference for random-address / short-TTL
  behavior. Its public address-only inbox endpoints are not copied.

## API compatibility

New owner-panel endpoints:

- GET /api/mailboxes
- POST /api/mailboxes
- DELETE /api/mailboxes/:mailboxId
- GET /api/messages?mailboxId=:mailboxId

New machine endpoints:

- GET /api/v1/machine/mailboxes
- POST /api/v1/machine/mailboxes
- DELETE /api/v1/machine/mailboxes/:mailboxId
- GET /api/v1/machine/messages?mailboxId=:mailboxId

The old /api/aliases, /api/v1/machine/aliases, and aliasId message parameter remain
accepted for existing clients while they transition. Responses retain legacy aliases
fields where useful, alongside the new mailboxes field.

## Email Routing cutover

New prefixless TMail addresses require a catch-all Email Routing rule on the dedicated
seiton.my.id zone that sends all inbound mail to seiton-mail-automation. Keep the
existing explicit receiver@seiton.my.id Worker rule in place during migration.
Do not enable catch-all on the seiton.biz.id zone. The Worker itself is the final
gatekeeper and rejects every recipient that does not resolve to an active mailbox.

Before enabling the catch-all rule, confirm that seiton.my.id is dedicated to this
mail service and that no other legitimate mailbox relies on the zone. This rule is a
production routing change and must be verified independently from the code deployment.

## Cloudflare API Token

For the D1 + Workers + Email Routing implementation, the relevant permissions are:

- Zone — Email Routing Rules — Edit
- Account — D1 — Edit
- Account — Workers Scripts — Edit

DNS Edit and Zone Settings Edit are needed only when changing DNS or zone-level settings.
Pages Edit is not required for this Worker-hosted panel. KV and R2 permissions are not
required by this D1-only implementation. Use least-privilege scope to the Seiton account
and the relevant zone.

## Validation

Run the repository Worker audit workflow. The dedicated tests cover:

- random 32-hex mailbox IDs
- TMail recipient parsing
- legacy plus-address compatibility
- invalid-recipient rejection
- address formatting and invalid slug rejection

Perform a real inbound email test only after the seiton.my.id catch-all rule is
configured and verify that expired mail is rejected. Do not use production owner
credentials or actual sensitive inbox content in automated fixtures.


## Agent Machine API

The supported agent-to-TMail contract, authentication rules, limits, request examples,
and error handling are documented in [AGENT-API.md](./AGENT-API.md). The dependency-free
JavaScript client is available in [agent-client.mjs](./agent-client.mjs).

Agents use a dedicated `MAIL_VM_API_TOKEN` Bearer credential stored in their private
secret vault. They do not receive the owner password, owner cookie, setup token, or
message-encryption key. The current Worker uses one machine credential; agents using
the same credential share its mailbox ownership scope and rate limits.
