# Seiton Mail Automation Worker

Source runtime disinkronkan dari Worker Cloudflare `seiton-mail-automation` pada 15 November 2026.

## Runtime
- Custom domain: `https://mail.seiton.biz.id`
- Entry point: `worker.js`
- Email parser: `email-parser.js`
- Compatibility date: `2026-11-14`
- Cron: `*/10 * * * *`
- D1: `seiton-mail-automation-prod`
- Production handlers: HTTP fetch, inbound email, scheduled cleanup.

## Integrasi Admin Seiton.id
Mail Automation ditampilkan di Seiton Owner Control Center melalui service binding `MAIL_BACKEND`.
Bridge internal memakai secret `MAIL_OWNER_BRIDGE_SECRET` pada kedua Worker: `seiton-mail-automation` dan `seiton-site-admin`.
Gunakan satu nilai secret acak minimal 32 byte yang sama pada kedua Worker. Nilainya tidak boleh masuk GitHub, Wrangler vars, browser, log, atau chat. Owner Worker menyimpan secret dan memanggil Mail Worker lewat service binding; browser hanya memanggil proxy Owner Worker.

Endpoint bridge:
- `GET /api/internal/owner/aliases`
- `POST /api/internal/owner/aliases`
- `DELETE /api/internal/owner/aliases/{id}`
- `GET /api/internal/owner/messages?aliasId={id}`
- `DELETE /api/internal/owner/messages/{id}`

Endpoint membaca isi pesan terenkripsi setelah autentikasi internal melalui service binding. Jangan menampilkan isi pesan/OTP pada dashboard ringkasan; detail hanya dimuat ketika owner membuka inbox mailbox yang dipilih.

## Secrets runtime
- `MAIL_MESSAGE_ENCRYPTION_KEY`
- `MAIL_SESSION_SECRET`
- `MAIL_SETUP_TOKEN`
- `MAIL_VM_API_TOKEN`
- `MAIL_OWNER_BRIDGE_SECRET` (secret bridge baru)

Tidak ada nilai secret pada repository.

## Catatan rilis
Konfigurasi ini mencerminkan D1 dan cron trigger yang ditemukan pada runtime. Domain custom dan Email Routing tetap dikelola di Cloudflare. Jangan deploy Worker ini sampai:
1. Konfigurasi D1 production dan Email Routing dicatat dan dibackup.
2. Seluruh secret existing tetap dipertahankan.
3. `MAIL_OWNER_BRIDGE_SECRET` dibuat dan dipasang pada kedua Worker.
4. Uji alias, inbox, expiry, revoke, dekripsi body, dan auth failure di staging.
5. Riwayat Email Routing serta cron diverifikasi.