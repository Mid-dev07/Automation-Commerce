# Seiton Internal QRIS Engine

## Decision

Seiton uses its own QRIS MPM payload-composition library. The checkout does not create a payment charge through Midtrans, Xendit, or another payment gateway.

The merchant credential is the original QRIS payload issued to Seiton.id by GoPay Merchant. It is stored as the Cloudflare Worker Secret `QRIS_STATIC_PAYLOAD`; it must never be committed to Git or sent in chat.

## Composition pipeline

1. Read the original static merchant payload from the Worker Secret.
2. Parse EMVCo TLV fields and validate the original CRC.
3. Validate the static MPM point-of-initiation method (`01=11`), QRIS currency (`53=360`), country (`58=ID`), and merchant-account information.
4. Preserve the merchant-account and other source fields.
5. Change point-of-initiation method to `01=12`.
6. Insert or replace amount tag `54` with the exact integer IDR amount.
7. Append tag `63` and recalculate CRC16/CCITT-FALSE.
8. Parse and validate the generated payload again before storing it in D1 and rendering it for Telegram.

Implementation: `qris.mjs` → `buildDynamicQrisPayload()`.

The payload composer is deterministic: the same merchant template and amount produce the same payload. This code validates QR payload structure; it does not authenticate the merchant, request funds, notify GoPay, confirm settlement, cancel an issued QR, or enforce single-use behavior.

## Checkout integration

The Telegram Worker already calls `getQrisCheckoutMode()` when showing payment methods. During checkout, `createOrReuseQrisPayment()` stores a per-order ledger row in D1 and either:
- stores the converted dynamic payload when `QRIS_INTERNAL_ENABLED=true`; or
- stores the original static payload when `QRIS_STATIC_FALLBACK_ENABLED=true`.

Each order currently receives a random 3-digit suffix (`001`–`999`); the expected payment amount is the order total plus that suffix. D1 has a unique index on `qris_payments.expected_amount` to prevent a duplicate expected amount from being assigned to another order. Because the suffix range is finite and expected amounts remain in the ledger, the same base amount has at most 999 unique suffix amounts across the retained ledger. Monitor this capacity before high-volume use.

The QR image is rendered by QuickChart using only the QR payload as input. QuickChart is an image-rendering dependency, not a payment gateway. The payload includes merchant payment data; a strict all-internal rendering path would replace this renderer with a bundled QR encoder.

## GoPay Merchant acceptance is a separate release gate

GoPay's published instructions describe a dynamic QRIS bill as one created in GoPay Merchant after the merchant enters the amount. Bank Indonesia describes MPM dynamic QRIS as a QR issued through an electronic device after the merchant enters the amount.

The local conversion performed by Seiton does not itself prove that GoPay has authorized or registered the resulting payload as a dynamic bill. A valid CRC only proves data integrity; it does not prove acquirer acceptance, transaction registration, expiration, or payment settlement.

Required validation using Seiton's actual GoPay-issued static QRIS template:

1. Generate a test payload without enabling it for customer checkout.
2. Scan it with GoPay and confirm the exact amount and Seiton merchant identity appear.
3. Repeat with DANA and at least one bank/mobile-banking QRIS scanner.
4. Make a small real payment from a separate payer account.
5. Confirm the successful transaction appears in the correct Seiton GoPay Merchant store and the amount matches exactly.
6. Obtain confirmation from GoPay/acquirer that this locally composed issuance method is permitted for the merchant QRIS.

Do not use the real merchant payload in public test fixtures or CI. Synthetic fixtures are used in automated tests.

A local D1 timeout does not revoke the QR already delivered to a customer. Do not claim a locally generated QR is cancelled, expired, or single-use unless the acquirer confirms that behavior. The expiry behavior of QR bills created inside GoPay Merchant must not be assumed to apply to locally composed payloads.

## Payment verification boundary

A successful QR scan or a screenshot is not proof that funds have settled. OCR is only a screening aid:
- compare amount, merchant name, timestamp, and transaction reference;
- reject reused evidence/reference identifiers;
- route uncertain or unreadable evidence to manual review;
- keep the order unpaid until an admin checks the actual incoming transaction in GoPay Merchant.

This implementation has no GoPay settlement callback/API. Automatic settlement is therefore not claimed. The current admin approval path remains the payment authority.

## Production flags observed

Read-only Cloudflare inspection on 2026-11-15 confirmed:

- `QRIS_INTERNAL_ENABLED=false`
- `QRIS_STATIC_FALLBACK_ENABLED=true`
- `QRIS_STATIC_PAYLOAD` exists as a secret binding; its value was not read.
- The Worker also has its Workers AI binding for receipt-image screening.
- The production D1 `qris_payments` table and expected-amount unique index exist.

The production bot therefore remains on static QRIS fallback until the GoPay acceptance gate above passes.

## Release procedure

1. Run the QRIS unit/regression suite and Worker audit workflow.
2. Review the source changes and keep production secrets unchanged.
3. Perform cross-wallet scanning and a small real payment with a controlled test order.
4. Confirm merchant/acquirer permission for local static-to-dynamic composition.
5. Only then set `QRIS_INTERNAL_ENABLED=true` on `seiton-order-bot`.
6. Keep `QRIS_STATIC_FALLBACK_ENABLED=true` as a rollback path.
7. Verify a live Telegram checkout, exact amount, correct merchant, D1 ledger entry, submitted proof, admin review, single receipt issuance, and reporting mirror.
8. If any scanner rejects the payload or the merchant transaction does not appear correctly, turn the internal flag off and leave static fallback enabled.

No production flag or secret is changed by this document or by the code-hardening branch.
