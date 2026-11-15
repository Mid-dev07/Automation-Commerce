# Internal QRIS + unique-code receipt verification — Seiton Core

Seiton checkout composes a transaction-specific QRIS MPM payload from the merchant's own acquirer-issued GoPay Merchant static QRIS template. The payload conversion is implemented inside Seiton's own library; it does not request a charge from Midtrans or another payment gateway. The library validates QR data structure, not GoPay settlement or acceptance.

## Worker configuration

Configure the Cloudflare Worker `seiton-order-bot`:

- `QRIS_INTERNAL_ENABLED=true` — keep false until the acquirer confirms this static-template-to-dynamic issuance flow is supported.
- `QRIS_STATIC_PAYLOAD` — exact EMVCo/QRIS payload decoded from Seiton.id's own static merchant QR. Store as a Cloudflare Worker Secret; never commit it or send it in chat.
- Add Workers AI binding named `AI`. Receipt image extraction uses `@cf/moondream/moondream3.1-9B-A2B`.

The Worker validates the static payload CRC, merchant-account information, country/currency, and static point-of-initiation before exposing QRIS checkout. Each order receives a random three-digit unique suffix (`001`–`999`); exact expected amount is base order total plus that suffix. D1 enforces globally unique expected amounts so the same amount is never assigned to a second order.

## Checkout and evidence flow

1. The customer creates a QRIS order.
2. The Worker changes point-of-initiation to `12`, inserts tag `54` with the exact expected amount, and recalculates tag `63` CRC16/CCITT-FALSE.
3. The QR payload is rendered to PNG and sent in Telegram, along with base total, unique code, and exact transfer amount.
4. If dynamic issuance is approved, the customer scans a QR containing the amount. Otherwise, the fallback displays the original static merchant QR and instructs the customer to enter the exact amount (order total plus unique suffix) manually. The customer then uploads a screenshot as a Telegram photo or image document. PDF remains accepted but routes to manual review.
5. Workers AI extracts visible amount, merchant, transaction timestamp, and reference. Deterministic server code compares them to the D1 order and rejects re-use of evidence or transaction references.
6. Admin sees both the original evidence and OCR assessment, then checks the merchant account's actual transaction history before approving and issuing a pickup receipt.

## GoPay Merchant compatibility gate

The internal converter is a local EMVCo/QRIS payload composer. It does not call GoPay, create a GoPay bill through a merchant API, or register a transaction in GoPay's backend. GoPay's published merchant instructions currently describe creating a dynamic QRIS bill by entering the amount in the GoPay Merchant app. Therefore, a locally composed payload is not considered production-compatible merely because its TLV and CRC are valid.

Before enabling `QRIS_INTERNAL_ENABLED`, verify with the GoPay-issued merchant QR template:
- GoPay, DANA, and at least one banking app recognize the generated QR and show the exact amount and the correct Seiton merchant.
- A small payment from a separate payer account reaches the correct GoPay Merchant store and appears as a successful transaction in its transaction history.
- The merchant/acquirer confirms this issuance method is permitted for the QRIS merchant.

A local timeout or D1 status does not revoke a QR that has already been shown. Do not tell customers a generated QR is expired or single-use unless GoPay/acquirer behavior confirms it. GoPay's app-generated bill behavior and its expiry rules must not be assumed to apply to a QR composed locally.

## Important security boundaries

- OCR does **not** prove settlement. Screenshots may be edited. Even `OCR_MATCHED` is only a screening state and never changes the order to `PAID`.
- Only admin approval after verifying the merchant's actual transaction history changes the order to paid.
- Unreadable/uncertain/mismatched OCR is routed to manual review; OCR does not automatically reject a customer claim.
- The payload composer does not create acquiring rights or guarantee issuer/acquirer acceptance. Obtain confirmation from the QRIS acquirer and test the resulting dynamic payload in multiple payment apps before enabling production checkout.
- QR PNG rendering uses QuickChart with only the QRIS payload as its input; customer name, Telegram ID, and order ID are not sent. For strict all-internal processing, replace this renderer with a bundled QR encoder before enabling the feature.
- Moondream is a third-party vision model hosted by Cloudflare Workers AI; OCR may misread cropped, blurred, or small text. The evidence itself remains retrievable from Telegram via its file ID.

## Release order

1. Pass CI and tests.
2. Ensure migrations 0011 and 0012 are applied to `seiton-transactions-prod`.
3. Add the Workers AI binding named `AI`.
4. Store `QRIS_STATIC_PAYLOAD` as a Worker Secret.
5. Enable `QRIS_STATIC_FALLBACK_ENABLED=true` so customers can scan the original static QR and type the exact expected amount.
6. Obtain acquirer confirmation for static-to-dynamic payload issuance; test small payments with different issuer apps.
7. Only after acquirer validation, set `QRIS_INTERNAL_ENABLED=true` to prioritize dynamic QR.

No QRIS option appears while the feature flag is disabled or the static payload is absent/invalid.


## Customer catalog visibility

The customer Telegram catalog now lists all valid D1 products, including inactive or sold-out records, with explicit availability labels. Only active products with available stock receive a purchase button. This avoids confusing catalog-count differences without accidentally selling disabled or out-of-stock items.

## Telegram product form

Admin add/edit is a guided one-field-at-a-time wizard, stored in D1 for 30 minutes. The admin reviews the completed fields and confirms Save or Cancel. Optional photo and description fields support `/skip` and `/hapus`; no pipe-delimited row is required.
