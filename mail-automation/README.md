# SeitonMail — Mail Automation

Public, inbound-only temporary mailbox service for Seiton. The public SeitonMail experience
is served at https://mail.seiton.biz.id/; the private Owner panel is at
https://mail.seiton.biz.id/owner (and the legacy /login path remains available).
Mailbox addresses are created on seiton.my.id.

## SeitonMail mailbox model

- Public **Generate** addresses use a cryptographically random 32-character hexadecimal
  local part and expire after 10 minutes.
- Public **Custom** addresses accept a validated 3–32 character local part on
  seiton.my.id and expire after 365 days.
- Every public mailbox is password protected. Generated mailboxes receive a random
  access password shown once; custom mailboxes require a password chosen by the user.
  Password hashes, not plaintext passwords, are stored.
- The Worker accepts mail only for an active mailbox record and rejects unknown, expired,
  revoked, or over-limit addresses.
- Existing receiver+<24-hex>@seiton.my.id addresses and
  receiver+<24-hex>@inbox.seiton.biz.id remain readable during the migration. Their
  original expiry is retained; no existing row or message is rewritten.
- Maximum accepted messages per mailbox remains 100.
- Owner-created and Machine API mailboxes support selectable lifetimes of 10 minutes,
  1 hour, 6 hours, 12 hours, 1 day, 3 days, 7 days, 14 days, or 30 days. The Owner
  panel defaults to 1 day; existing Machine API clients that omit `ttlSeconds` retain
  the 10-minute default for compatibility.
- Public Generate addresses remain 10 minutes and Public Custom addresses remain 365 days.
- The Owner panel lists only active, unexpired mailboxes. Expired or revoked mailbox
  messages and public inbox credentials are removed by the next cleanup run; mailbox
  metadata is retained for a seven-day grace period, then purged. The cleanup cron
  remains every 10 minutes. The general message-retention ceiling remains 30 days.

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

- The public root page offers Generate and Custom mailbox creation, password-protected
  inboxes, automatic OTP extraction, and a five-second inbox refresh.
- Owner access is separate at /owner (legacy /login is retained) and starts with the
  existing password. TOTP 2FA can be enrolled from the authenticated panel using any RFC 6238-compatible authenticator (Aegis, Google
  Authenticator, or Microsoft Authenticator).
- The TOTP secret is encrypted with AES-GCM using a key derived from
  MAIL_SESSION_SECRET. The panel issues 10 one-time recovery codes; only their hashes
  are stored. Activating or disabling 2FA revokes existing Owner sessions.
- Each agent can have an independent Machine API Bearer token, created and revoked
  from the Owner panel. Plaintext tokens are shown once; only SHA-256 hashes are stored.
- MAIL_VM_API_TOKEN remains as a legacy compatibility identity during migration.
  Move agents to individual tokens before removing the legacy Worker secret.
- Machine endpoints enforce per-token rate limits, mailbox ownership, and message
  access checks. Agents never receive Owner cookies or Owner credentials.
- Expired and revoked mailboxes no longer appear in the Owner panel or return messages
  through the owner inbox API. Scheduled cleanup removes their message payloads and
  public inbox credentials, then purges mailbox metadata after a seven-day grace period.
- Public inbox APIs require a mailbox-specific HttpOnly session cookie issued only
  after mailbox creation or password verification. A guessed address alone cannot read mail.

## API compatibility

New public SeitonMail endpoints:
- POST /api/public/mailboxes
- POST /api/public/unlock
- GET /api/public/inbox?slug=:localPart
- POST /api/public/logout

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

New random and custom SeitonMail addresses require a catch-all Email Routing rule on the
dedicated seiton.my.id zone that sends all inbound mail to seiton-mail-automation. Keep the
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

The supported agent-to-SeitonMail contract, authentication rules, limits, request examples,
and error handling are documented in [AGENT-API.md](./AGENT-API.md). The dependency-free
JavaScript client is available in [agent-client.mjs](./agent-client.mjs).

Each agent should use its own `TMAIL_API_TOKEN` Bearer credential stored in its private
secret vault. The variable name is retained for compatibility; the product identity is
SeitonMail. Create and revoke individual credentials in the Owner panel. The legacy
`MAIL_VM_API_TOKEN` remains temporarily accepted during migration, so old integrations
can be moved without an outage. Agents do not receive the Owner password, Owner cookie,
setup token, or message-encryption key.


## Public SeitonMail experience

The public page and mailbox interaction are documented in [PUBLIC-SERVICE.md](./PUBLIC-SERVICE.md).
The Worker serves the landing page at `/`, mailbox pages at `/inbox/:localPart`, and
the private Owner panel at `/owner`. The page exposes only the one domain with a
verified inbound Email Routing path: `seiton.my.id`. Do not advertise or issue
addresses on other domains until their MX/Email Routing configuration has been tested.
