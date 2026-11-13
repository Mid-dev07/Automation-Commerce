# Automation-Commerce

## Fase 1 — produk digital dan portal mailbox privat

Implementasi bertahap berada pada branch `feat/fase-1-digital-delivery-otp`:
- Inventori akun digital dienkripsi dengan AES-GCM; kunci berada pada Worker Secret `MUSE_STOCK_ENCRYPTION_KEY`.
- Perubahan stok/claim diserialisasi pada Durable Object per SKU yang sama dengan checkout, bukan pola read-shift-write Workers KV.
- D1 menyimpan status fulfillment dan onboarding secara additive; order historis tidak diubah.
- `MUSE_KV` hanya untuk ringkasan/cache, D1 tetap sumber kebenaran inventori dan transaksi.
- `OTP_KV` menyimpan indeks akses mailbox dan akan menampung pesan dengan TTL 1 jam. Portal hanya dapat diakses menggunakan token privat per mailbox, bukan email query saja.
- Email Routing catch-all tidak diaktifkan sebelum domain fallback, pemilik mailbox, dan QA email end-to-end dikonfirmasi.
