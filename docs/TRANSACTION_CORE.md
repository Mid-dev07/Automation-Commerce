# Transaction core: D1 + Durable Objects

The Worker keeps Google Sheets as a reporting mirror while D1 becomes the transactional source of truth after import.

## Cloudflare resources

- D1: `seiton-transactions-prod` (APAC)
- D1 binding: `DB`
- Durable Object binding: `ORDER_COORDINATOR`
- Durable Object class: `OrderCoordinator` (SQLite-backed)

## Deployment and migration

1. Deploy the Worker version with D1 and Durable Object bindings and the existing secrets inherited.
2. Confirm `GET /health` reports `transaction_store: MIGRATION_REQUIRED`.
3. As a Telegram admin, send `/migrasi_d1` to the bot.
4. The importer snapshots `Katalog_Produk!A2:G` and `Pesanan!A2:T` into D1. Historical orders are imported with `stock_reserved=0`; their quantities are not deducted a second time.
5. Confirm the bot's success message and `GET /health` reports `transaction_store: READY`.

The importer is idempotent and skips duplicate catalog SKUs/order IDs. If import is interrupted before READY, rerun the admin command; inserts use conflict-safe semantics.

## Transaction rules

- Checkout is serialized by SKU Durable Object and committed in a D1 batch.
- The D1 inventory ledger and triggers reserve finite stock and reject overselling.
- Unique idempotency keys prevent repeated Telegram updates from creating duplicate orders.
- Payment approval, rejection, status changes, and pickup actions use order IDs and conditional D1 writes.
- Cancellation releases stock once. Paid orders require a separate refund flow and cannot be cancelled in the current UI.
- Google Sheets writes are best-effort mirrors; they are not used for stock locks or transaction decisions.

## Operational notes

- Back up D1 before destructive schema changes.
- Do not edit transactional product stock directly in Google Sheets after READY; manage it through the admin panel.
- Keep D1 data and the reporting Sheet protected. The Sheet mirror may lag if Google API calls fail; the Worker logs those failures and D1 remains authoritative.
