# Phase 2 — Multi-item Telegram cart

Date: 2026-11-09  
Status: implementation and CI regression checks passed; awaiting owner review.

## 1. Customer commands

The Telegram command parser now supports:

| Command | Behavior |
|---|---|
| `TAMBAH SKU JUMLAH` | Add quantity to the customer's cart |
| `KERANJANG` | Display item lines, current D1 prices, stock availability, and estimated product total |
| `UBAH SKU JUMLAH` | Replace the quantity for an SKU already in the cart |
| `HAPUS SKU` | Remove one SKU |
| `KOSONGKAN` | Remove all cart lines |
| `CHECKOUT QRIS` | Create a payment order from the cart |
| `CHECKOUT TRANSFER` | Create a transfer order from the cart |
| `CHECKOUT COD` | Create a COD order from the cart |

The existing `BELI SKU JUMLAH QRIS|TRANSFER|COD` command remains unchanged for one-SKU orders.

## 2. Cart state and ownership

Each cart is owned by a Durable Object name scoped to channel and customer identity. Cart rows, mutation idempotency records, and the last checkout snapshot are stored in the Durable Object's SQLite storage.

The cart is not stored in Google Sheets. Google Sheets remains a reporting mirror; the cart reads current product prices and stock from the transactional D1 database.

The Durable Object keeps:
- `cart_items`: one current quantity per SKU.
- `cart_meta`: cart version and most recent successful checkout snapshot.
- `cart_mutations`: event/operation identifiers and results for replay-safe mutations, pruned after seven days.

Writes to the cart state and mutation record are grouped in `transactionSync()`. Asynchronous product lookups happen before that synchronous state transaction.

## 3. Checkout data model and atomicity

A cart checkout creates one parent row in `orders` with `sku='MULTI'`. That parent remains the payment, order-status, and receipt unit. Each SKU becomes one child row in `order_items`.

For the checkout:
1. The Worker checks that the D1 transaction store is READY.
2. The cart coordinator reads its current cart version and item list.
3. The backend loads each current product, active flag, price, and stock from D1. Client-provided price/subtotal values are not accepted.
4. The backend validates quantity limits, payment method, safe integer arithmetic, and stock preconditions.
5. One D1 `batch()` inserts the parent order, child item rows, per-SKU RESERVE movements, order event, admin activity audit, and Google Sheets outbox event.

The existing SQLite triggers validate each reservation against the current stock inside the D1 batch. If any SKU fails its stock guard, the batch fails rather than leaving a partially created order or partially deducted inventory. Successful orders deduct each tracked SKU exactly once.

Checkout idempotency uses:
- The Telegram update/event ID in the Durable Object's mutation record.
- A cart-version idempotency key stored in `orders.idempotency_key`.

If D1 commits and the Durable Object is interrupted before clearing its local cart, retrying the same cart version returns the existing D1 order, then completes cart clearing without a second stock deduction.

## 4. Cancellation and legacy compatibility

Unpaid multi-item cancellation uses `order_item_inventory_movements` with one RELEASE per child SKU. The status change, releases, stock restoration triggers, reservation flag update, order event, audit event, and Sheets outbox write are submitted in the same D1 batch.

The RELEASE movement has a unique constraint per order/SKU/type. The parent reservation flag is cleared only after every child SKU has a RELEASE movement. Replaying a cancellation cannot increment stock a second time.

Existing single-SKU orders continue to use the original `inventory_movements` flow. Existing payment approval requirements and the paid-order cancellation guard remain in place.

## 5. Catalog consistency

When the D1 transaction store is READY, the Telegram catalog now reads `catalog_products` from D1, including the stored product image URL and description. Google Sheets catalog reads remain only as a fallback when the transactional D1 store is not active.

This keeps the customer-facing catalog, add-to-cart validation, and checkout pricing aligned to the D1 catalog source of truth.

## 6. Validation

GitHub Actions validation on the Phase 2 head completed successfully:

- Worker audit (Node.js 22): syntax and regression suite passed on the preceding Phase 2 commit.
- Cart regression workflow (Node.js 24.22.2): `node --check` for `worker.js`, `transaction-layer.js`, `cart-layer.mjs`, and `messaging-core.mjs` passed.
- Cart regression workflow: `node --test tests/*.test.cjs` — 72 passed, 0 failed.
- Messaging Core workflow: `node --test tests/messaging-core.test.mjs` — 26 passed, 0 failed.

SQLite tests use an in-memory database, checked-in migrations, fake product rows, and a local transaction adapter. They cover successful multi-item checkout, insufficient stock rollback, duplicate checkout, concurrent checkouts for the final unit, exactly-once cancellation stock release, legacy single-SKU inventory, and invalid/safe-money inputs.

The suite does not exercise an actual Cloudflare-hosted Durable Object instance end-to-end. Durable Object state/serialization behavior is additionally guarded by Worker contract tests and must still receive a controlled preview/runtime smoke test before a production rollout.

## 7. Production safety

No production Worker was deployed. No remote D1 migration was applied. No Cloudflare binding, Durable Object class, R2 bucket, secret, pricing, or production schema was changed. No customer/order rows were read or written.

The migration `0002_multi_item_cart.sql` is present in the backend source branch. It is not applied remotely by this phase. Production D1 previously showed the cart tables and triggers in its schema, but migration ledger provenance remains unverified.

## 8. Before production rollout

1. Review and merge the Phase 2 code only after owner approval.
2. Run an isolated preview/runtime test with a dedicated test customer and test SKUs. Confirm cart create/update/remove/clear, checkout, and cancellation end-to-end.
3. Verify the current D1 migration state using the owner's controlled migration history. Do not blindly apply `0002` to production.
4. Test the existing payment-proof, approval, receipt, admin dashboard, export, and Sheets mirror paths with multi-item parent orders.
5. Deploy only under a separate, explicit production release approval.

Phase 3 (R2 image upload/serving) is not part of this change and remains blocked until Phase 2 review is complete.
