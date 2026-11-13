# Seiton.id — Portal Mailbox Privat

Worker terpisah untuk menampilkan email masuk pada mailbox yang didaftarkan dan diotorisasi oleh pemilik domain.

## Runtime yang sedang digunakan

- Entry point produksi: `index.js`.
- Modul MIME/email: `email-parser.js`.
- `worker.js` lama tetap disimpan sebagai implementasi historis; bukan entry point produksi saat ini.
- Compatibility date: `2026-11-13`, dengan `nodejs_compat`.
- Worker: `seiton-otp-portal`; custom domain: `otp.seiton.biz.id`.

## Bindings produksi

- Durable Object: `MAILBOX_INDEX` → class `MailboxIndex` (namespace SQLite yang sudah ada).
- KV: `MUSE_KV` dan `OTP_KV`.
- Vars: `OTP_ALLOWED_DOMAINS`, `OTP_PORTAL_URL`.
- Secrets: `OTP_EMAIL_ENCRYPTION_KEY`, `OTP_INTERNAL_SECRET`.

Nilai secret tidak boleh dimasukkan ke Git. Namespace Durable Object telah terdeteksi di Cloudflare; sebelum deploy melalui Wrangler, cocokkan kembali riwayat migrasi class dengan konfigurasi deploy karena metadata migrasi tidak tersedia dari pembacaan binding runtime.

## Keamanan

- Email hanya disimpan untuk mailbox yang telah didaftarkan dan diotorisasi.
- Token mailbox tidak disimpan mentah; yang disimpan adalah hash.
- Isi email dienkripsi AES-GCM sebelum disimpan ke KV.
- Pesan memiliki TTL 3600 detik.
- Portal tidak boleh membuka inbox hanya berdasarkan alamat email.
- Email Routing catch-all tetap nonaktif sampai fallback domain, allowlist mailbox, dan QA end-to-end disetujui.

## Operasional

Jangan mengaktifkan catch-all atau mengubah aturan Email Routing sebagai bagian dari rekonsiliasi source. Uji provisioning, rotate, revoke, dan pembacaan inbox hanya pada mailbox uji sebelum rilis produksi.
