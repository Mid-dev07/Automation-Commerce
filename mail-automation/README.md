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
- Payload email (pengirim, penerima, subjek, isi, dan kode) dienkripsi AES-256-GCM dengan AAD yang terikat ke alias sebelum disimpan ke D1; IV acak disimpan terpisah.
- Hanya hash Message-ID yang disimpan untuk deduplikasi; plaintext email tidak ditulis ke kolom D1.
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

## Machine API untuk VM

API machine-to-machine disediakan khusus untuk VM yang dipercaya. API ini tidak memakai sesi browser owner dan tidak membuka akses D1 langsung.

### Authentication

- Worker secret: `MAIL_VM_API_TOKEN` (Bearer token acak, minimal 40 karakter).
- Kirim pada header `Authorization: Bearer <token>`.
- Jangan masukkan token ke Git, log, URL query string, atau file yang dapat dibaca user lain.
- Rate limit: 120 request/menit dan maksimum 20 alias baru per jam untuk token ini.
- Token dapat dirotasi dengan mengganti Worker secret `MAIL_VM_API_TOKEN`.

### Endpoint

Create alias:

```http
POST /api/v1/machine/aliases
Authorization: Bearer <MAIL_VM_API_TOKEN>
Content-Type: application/json

{
  "label": "VM Muse",
  "ttlSeconds": 3600,
  "clientRef": "muse-registration-001"
}
```

`clientRef` opsional dan idempotent: retry dengan referensi yang sama akan mengembalikan alias aktif yang sama, bukan membuat alias baru. Masa aktif mengikuti daftar TTL panel: 900, 3600, 86400, 604800, atau 2592000 detik.

Read OTP messages:

```http
GET /api/v1/machine/messages?aliasId=<uuid>
Authorization: Bearer <MAIL_VM_API_TOKEN>
```

Untuk polling bertahap, ambil `next_cursor.after` dan `next_cursor.afterId`, lalu kirim sebagai query `after` dan `afterId`. Maksimum 50 pesan per halaman. Respons hanya membuka `sender`, `subject`, `verification_code`, dan `received_at`; isi email lengkap dan kunci AES tidak pernah dikirim ke VM.

Revoke machine alias:

```http
DELETE /api/v1/machine/aliases/<uuid>
Authorization: Bearer <MAIL_VM_API_TOKEN>
```

Alias yang dibuat lewat Machine API ditandai pada `mail_machine_aliases`. Token hanya dapat membaca dan mencabut alias yang tercatat dengan token hash miliknya sendiri. Panel owner tetap memakai endpoint dan sesi browser yang sudah ada.

### Database migration

Jalankan `migrations/0003_machine_api.sql` pada D1 `seiton-mail-automation-prod` sebelum Worker versi baru dilayani.
