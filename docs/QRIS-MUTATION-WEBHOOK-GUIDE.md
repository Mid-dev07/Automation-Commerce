# Panduan Setup QRIS Auto-Approval (GoPay Merchant) & Outbound Webhook

Dokumen ini menjelaskan cara menghubungkan notifikasi **GoPay Merchant / GoBiz** dari perangkat Android ke `seiton-order-bot` (`POST /api/v1/mutations/ingest`) serta cara memverifikasi webhook `HMAC-SHA256` di situs penerima.

## 1. Prasyarat Migrasi & Mode QRIS
- Pastikan `QRIS_STATIC_FALLBACK_ENABLED=true` tetap aktif (wajib untuk GoPay Merchant karena GoPay Merchant hanya mengirim notifikasi pembayaran masuk pada QRIS statis dengan nominal unik).
- Terapkan migrasi D1 `migrations/0015_payment_mutations_and_webhooks.sql` saat siap rilis produksi:
  ```bash
  npx wrangler d1 migrations apply <NAMA_DB_D1> --remote
  ```
- Buat Device Token melalui Admin Dashboard → **Metode Pembayaran** → **Listener Mutasi Android** → **Buat Device Token** (token `dt_...` hanya ditampilkan sekali; server hanya menyimpan hash SHA-256).

## 2. Setup Android Listener (MacroDroid / Tasker)
Aktifkan izin **Notification Access** dan nonaktifkan **Battery Optimization** untuk MacroDroid/Tasker serta GoPay Merchant.

### Konfigurasi MacroDroid
- **Trigger:** `Device Events` → `Notification` → `Notification Received`
  - Pilih aplikasi: **GoPay Merchant** (`com.gojek.gopaymerchant`) dan/atau **GoBiz** (`com.gojek.gobiz`).
- **Action:** `Web Interactions` → `HTTP Request`
  - **Method:** `POST`
  - **URL:** `https://<domain-worker-anda>/api/v1/mutations/ingest`
  - **Headers:**
    - `Content-Type: application/json`
    - `X-Device-Token: dt_<TOKEN_DARI_DASHBOARD>`
  - **Content Body (JSON):**
    ```json
    {
      "source_app": "[not_app_package]",
      "title": "[not_title]",
      "text": "[notification]"
    }
    ```

### Respon Endpoint Ingest
- `200 OK` dengan `status`:
  - `MATCHED` — nominal cocok eksak dengan order QRIS aktif (`expected_amount`); order otomatis lunas (`DIBAYAR`), receipt Telegram dikirim 1x, dan webhook diantrekan.
  - `UNMATCHED` — nominal terbaca tetapi tidak ada order aktif yang cocok atau order sudah kedaluwarsa.
  - `IGNORED` — notifikasi promo/keluar/non-pembayaran masuk.
  - `DUPLICATE` — notifikasi identik sudah pernah diproses.
- `401 Unauthorized` — `X-Device-Token` tidak valid atau sudah dicabut.

## 3. Verifikasi Outbound Webhook (`HMAC-SHA256`)
Tambahkan URL HTTPS tujuan di Admin Dashboard → **Metode Pembayaran** → **Webhook Pembayaran (HMAC-SHA256)**.

### Header yang Dikirim
- `X-Seiton-Event`: `payment.paid` (atau `webhook.test` saat klik **Tes Ping**)
- `X-Seiton-Timestamp`: Unix timestamp (detik)
- `X-Seiton-Signature`: hex lowercase dari `HMAC_SHA256(timestamp + "." + rawBody, signing_secret)`
- `X-Seiton-Delivery-Id`: ID unik tetap lintas retry (kunci idempotensi)
- `X-Seiton-Attempt`: nomor percobaan (`1`..`5`, backoff otomatis 30s → 2m → 10m → 30m → 2h)

### Contoh Payload (Flat JSON)
```json
{
  "event": "payment.paid",
  "transaction_id": "QR-20261123-XXXX",
  "external_order_id": "ORD-20261123-XXXX",
  "base_amount": 50000,
  "unique_code": 7,
  "total_amount": 50007,
  "customer_name": "Budi",
  "receipt_code": "SEI-20261123-ABC123",
  "source_app": "com.gojek.gopaymerchant",
  "paid_at": "2026-11-23T09:15:22+07:00",
  "created_at": "2026-11-23T09:10:00+07:00"
}
```

### Contoh Verifikasi Node.js
```js
import crypto from "node:crypto";

export function verifySeitonWebhook(rawBody, headers, secret) {
  const ts = Number(headers["x-seiton-timestamp"]);
  const sig = String(headers["x-seiton-signature"] || "").replace(/^sha256=/i, "").toLowerCase();
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```
