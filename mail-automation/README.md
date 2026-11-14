# Seiton Mail Automation

Panel privat untuk membuat alamat email alias berbasis domain Seiton, menerima email verifikasi, mendeteksi kode OTP, dan mengelola masa aktif alias.

## Isolasi

- Worker: `seiton-mail-automation`
- Panel: `https://mail.seiton.biz.id`
- Domain alias penerima: `inbox.seiton.biz.id`
- Database terpisah: `seiton-mail-automation-prod`
- Tidak memakai `seiton-otp-portal`, `OTP_KV`, atau `MAILBOX_INDEX` milik portal lama.

## Bentuk alamat

Panel membuat alias plus-address seperti:

`receiver+<random-hex>@inbox.seiton.biz.id`

Ini adalah alamat penerima alias melalui Cloudflare Email Routing subaddressing, bukan mailbox IMAP/POP atau akun email terpisah. Worker hanya menyimpan pesan untuk alias aktif yang terdaftar di D1. Catch-all apex domain tidak diaktifkan.

## Fitur

- Setup owner sekali pakai dengan bootstrap secret.
- Login admin, sesi HttpOnly/Secure/SameSite=Strict, dan lockout login.
- Generate alias dengan masa aktif 15 menit, 1 jam, 1 hari, 7 hari, atau 30 hari.
- Inbox per alias, deteksi kode OTP/verifikasi, salin alamat/kode, cabut alias, hapus pesan.
- Retensi pesan maksimum 30 hari; tidak menyimpan lampiran.
- UI noindex, tanpa analytics dan tanpa resource eksternal.
- Email inbound only. Pengiriman email keluar bukan bagian dari panel ini.

## Cloudflare setup

1. D1 schema tersedia di `schema.sql`.
2. Set Worker secrets:
   - `MAIL_SETUP_TOKEN`: bootstrap token sekali pakai untuk menginisialisasi password owner.
   - `MAIL_SESSION_SECRET`: secret acak minimal 32 byte.
   - `MAIL_MESSAGE_ENCRYPTION_KEY`: base64 dari 32 byte acak untuk AES-256-GCM; kunci ini mengenkripsi payload email sebelum disimpan ke D1.
3. Tambahkan custom domain Worker `mail.seiton.biz.id`.
4. Tambahkan subdomain Email Routing `inbox.seiton.biz.id`.
5. Aktifkan `support_subaddress` pada Email Routing zone, lalu buat satu routing rule literal:
   - Recipient: `receiver@inbox.seiton.biz.id`
   - Action: Worker `seiton-mail-automation`
6. Uji kirim dari mailbox eksternal sebelum panel dipakai untuk akun penting.

Jangan aktifkan catch-all untuk `seiton.biz.id`. Subdomain `inbox.seiton.biz.id` dipakai khusus untuk alias generator.
