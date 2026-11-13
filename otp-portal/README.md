# Seiton.id — Portal Mailbox Privat

Worker terpisah untuk menampilkan email masuk pada mailbox yang telah didaftarkan dan diotorisasi oleh pemilik domain.

## Keamanan

- Worker hanya menyimpan pesan jika alamat penerima mempunyai entri `mailbox:<sha256(email)>` yang valid pada `OTP_KV`.
- Pesan yang diterima untuk mailbox tak terdaftar ditolak. Tidak ada akses inbox berdasarkan alamat email saja.
- Tautan portal memakai token acak dalam fragment URL. Nilai token mentah tidak dikirim ke server pada request awal; hanya hash token disimpan di KV.
- Konten email dienkripsi AES-GCM sebelum disimpan di KV.
- Pesan dihapus oleh TTL setelah 3600 detik; portal menampilkan maksimal lima pesan terbaru.
- Portal memakai refresh 5 detik, noindex, no-referrer, tanpa analytics atau resource eksternal.
- Email Routing catch-all **tidak boleh diaktifkan** sebelum fallback domain, mailbox allowlist, dan QA end-to-end disetujui.

## Bindings dan secrets

- KV: `OTP_KV` (namespace yang sudah dibuat pada akun Cloudflare Seiton).
- Secret: `OTP_EMAIL_ENCRYPTION_KEY` — base64 dari 32 byte acak untuk AES-256-GCM.

Jangan commit token mailbox, password akun, raw email, atau nilai secret.

## Deployment yang direncanakan

- Worker: `seiton-otp-portal`
- Custom domain: `otp.seiton.biz.id`
- Email Routing: rule spesifik mailbox terlebih dahulu. Catch-all tetap off.
- Subdomain domain klien hanya dipasang setelah verifikasi kontrol domain dan persetujuan klien.
