# Dynamic QRIS — Seiton Core + Midtrans

The Worker contains a first-party EMV TLV/CRC16 QRIS module and a direct Midtrans HTTP adapter. No third-party QRIS SDK is required.

## Runtime settings

- QRIS_DYNAMIC_ENABLED=false (keep closed until sandbox and live checks pass)
- MIDTRANS_ENV=sandbox for testing, production for live
- MIDTRANS_QRIS_ACQUIRER=gopay (or airpay_shopee, if enabled for this merchant)
- MIDTRANS_SERVER_KEY — Cloudflare Worker Secret. Never commit this value or send it in chat.

## Merchant setup gate

The merchant must own an activated Midtrans merchant account, enable QRIS for the selected acquirer, and use that merchant's Server Key. Configure this public HTTPS endpoint as the Payment Notification URL in the Midtrans Dashboard:

https://<worker-hostname>/webhooks/midtrans

The Worker validates the Midtrans SHA-512 signature_key, order ID, QRIS payment type, currency, exact amount, and provider transaction mapping before marking an order paid.

## Flow

1. Telegram displays QRIS only when the feature flag and Server Key are configured.
2. The Worker creates the order, requests a transaction from Midtrans, and stores the provider transaction mapping in D1.
3. The Worker retrieves the provider QR image server-side and sends it to Telegram.
4. The provider webhook, or a customer status refresh using the authenticated Status API, updates the payment.
5. Only a verified settlement for the exact order and amount triggers automatic order approval, receipt generation, and digital fulfillment.

## Internal QRIS core

buildDynamicQrisPayload() validates an acquirer-issued static MPM merchant template, changes point of initiation to dynamic MPM, inserts or replaces the exact transaction amount, and recalculates CRC16/CCITT-FALSE.

This is a local payload composer and validator. It does not create merchant acquiring rights, settle money, or replace the merchant's acquirer. Do not use it to alter a third-party QR payload without written/acquirer approval. The actual checkout QR must be issued by Midtrans and the actual settlement must be confirmed by its authenticated notification/status API.

## Deployment sequence

1. Pass CI and unit tests.
2. Apply migrations/0011_qris_payments.sql to the production D1 database during the release window.
3. Add MIDTRANS_SERVER_KEY as a Worker Secret and configure non-secret settings.
4. Configure the public notification URL in the Midtrans Dashboard.
5. Keep QRIS_DYNAMIC_ENABLED=false while testing in sandbox.
6. Verify provider settlement, expiry, wrong-amount rejection, and duplicate webhook delivery.
7. Switch to production credentials and activate only after a small real transaction has been reconciled in the Midtrans Dashboard.

No live payment transaction can be created without the merchant's own credentials and approved QRIS acquirer configuration.
