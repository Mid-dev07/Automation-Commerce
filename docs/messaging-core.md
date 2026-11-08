# Seiton Messaging Core

## Purpose

The Messaging Core separates conversation logic from channel transport. Telegram is the first adapter. A future WhatsApp Business Platform adapter can call the same core without duplicating catalog, order, status, opt-out, or handoff logic.

This is not a WhatsApp integration by itself. No WhatsApp provider, QR pairing, Baileys runtime, or outbound WhatsApp transport is included.

## Architecture

- Cloudflare Worker remains the application and conversation entry point.
- D1 remains the source of truth for catalog and transactions.
- `messaging-core.mjs` validates normalized events, parses commands, enforces conversation mode, and records inbound/outbound event state.
- `messaging_outbox` stores outbound actions before a channel adapter sends them.
- The Telegram adapter claims Telegram outbox records and delivers them through the existing Telegram Bot API.
- Future official providers must implement their own webhook verification and sender while reusing the same normalized event contract and outbox.

## Normalized inbound contract

Required fields:

- `tenantId`: defaults to `seiton` for the current single-business bot.
- `channel`: currently `telegram` or `whatsapp`.
- `eventId`: stable provider event/update identifier.
- `externalMessageId`: stable provider message identifier.
- `conversationId`: provider conversation or chat identifier.
- `senderId`: stable sender identifier used for order ownership.
- `text`: plain text message.

Optional fields include `customerName`, `eventType`, `choiceId`, `occurredAt`, `fromMe`, and `isDirect`.

An adapter must reject or mark as non-customer any event sent by the business itself, group chats, status updates, or unsupported message types before invoking the core. Interactive provider choices should use event type `choice` with one of the neutral choice IDs `menu`, `catalog`, `orders`, `help`, or `admin`.

## Commands

| Command | Behavior |
|---|---|
| `MENU`, `HELP`, `/start` | Show help and supported commands |
| `KATALOG` | Read the active catalog |
| `PESANAN` | Show up to five recent orders owned by the sender and channel |
| `STATUS <order-id>` | Show one order only after checking sender and channel ownership |
| `BELI <SKU> <quantity> <QRIS|TRANSFER|COD>` | Create an order through the existing transaction layer |
| `ADMIN`, `BANTUAN ADMIN` | Pause bot replies and create a human handoff request |
| `STOP` | Set conversation mode to `OPTED_OUT` |
| `START` | Explicitly re-enable automatic replies |
 
Interactive choice IDs map to the same command router: `catalog`, `orders`, `help`, and `admin`.

The order ID, pricing, stock, and payment status are not trusted from the message. They are read or calculated by the existing application services.

## Persistence and delivery

Migration: `migrations/0004_messaging_core.sql`.

- `messaging_inbound_events`: deduplicates inbound provider events and uses a bounded processing lease.
- `messaging_conversations`: stores bot, human handoff, or opted-out mode for each tenant/channel/conversation.
- `messaging_outbox`: stores outbound actions with delivery attempts, leases, retry time, and provider message ID.
- `messaging_handoff_requests`: records support handoff requests.

Outbound delivery uses at-least-once processing. The outbox reduces lost messages after request failure, but a provider timeout can still leave an uncertain delivery outcome. Provider adapters must avoid blindly duplicating a message when the provider result is unknown.

## Applying the migration

Do not enable the Messaging Core until the migration has been reviewed and applied to the intended D1 database. The Worker checks for the new table and retains the previous Telegram command flow when the migration is absent.

The configured D1 database in `wrangler.jsonc` is `seiton-transactions-prod`. After reviewing the migration and confirming the target environment, apply it with:

```bash
npx wrangler d1 migrations apply seiton-transactions-prod --remote
```

This command is intentionally not run by this change. The migration is additive and creates only Messaging Core tables and indexes.

## Telegram adapter behavior

- Existing Telegram inline catalog, payment, receipt, and admin callback flows remain channel-specific and unchanged.
- Free-text customer messages use the shared core after the D1 migration is present.
- `/start` and `/help` use core responses after migration; before migration, the existing menu remains available.
- Telegram groups are ignored by the new core path.
- Existing admin commands and product forms remain in the existing handler.

## Tests

Run the channel-neutral unit tests with:

```bash
node --test tests/messaging-core.test.mjs
```

The GitHub Actions workflow `.github/workflows/messaging-core.yml` runs these tests on relevant changes.

## Not included yet

- WhatsApp Cloud API / BSP webhook adapter and sender.
- Provider-specific interactive list/button rendering.
- Conversation ordering via per-conversation Durable Object.
- Admin UI or command for claiming and closing handoff requests; the initial core records the request and pauses bot replies, but release of a human handoff remains a follow-up task.
- Payment proof upload through WhatsApp media.
- Multi-tenant provisioning and provider credentials.
