# Automation-Commerce

## Fase 1 — produk digital dan portal mailbox privat

Implementasi bertahap berada pada branch `feat/fase-1-digital-delivery-otp`:
- Inventori akun digital dienkripsi dengan AES-GCM; kunci berada pada Worker Secret `MUSE_STOCK_ENCRYPTION_KEY`.
- Perubahan stok/claim diserialisasi pada Durable Object per SKU yang sama dengan checkout, bukan pola read-shift-write Workers KV.
- D1 menyimpan status fulfillment dan onboarding secara additive; order historis tidak diubah.
- `MUSE_KV` hanya untuk ringkasan/cache, D1 tetap sumber kebenaran inventori dan transaksi.
- `OTP_KV` menyimpan indeks akses mailbox dan akan menampung pesan dengan TTL 1 jam. Portal hanya dapat diakses menggunakan token privat per mailbox, bukan email query saja.
- Email Routing catch-all tidak diaktifkan sebelum domain fallback, pemilik mailbox, dan QA email end-to-end dikonfirmasi.


## Portal OTP
Source terpisah tersedia di `otp-portal/`. Portal menampilkan inbox untuk mailbox yang didaftarkan oleh admin/owner domain. Token akses di URL fragment diverifikasi menggunakan hash, isi email disimpan terenkripsi di `OTP_KV`, dan pesan memiliki TTL 3600 detik. Email Routing tetap nonaktif sampai aturan mailbox spesifik dan fallback domain disetujui.


## Internal QRIS Engine

The Telegram order Worker contains a local QRIS MPM payload composer in `qris.mjs`. It converts a merchant-issued static template to a transaction-specific payload (MPM point-of-initiation `11` → `12`, inserts tag `54`, recalculates tag `63` CRC16/CCITT-FALSE). It does not call a payment gateway or create a transaction through a GoPay API.

The production QRIS feature flag remains disabled until the GoPay-issued template passes cross-wallet scan tests, a small real payment reaches the correct merchant account, and the acquirer confirms this issuance method. Static QRIS remains the live fallback. See [internal QRIS engine and release gates](docs/INTERNAL-QRIS-ENGINE.md).
