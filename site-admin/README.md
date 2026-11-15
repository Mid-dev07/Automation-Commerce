# Seiton owner admin Worker

Source for the production owner pricing panel at https://admin.seiton.biz.id/.

## Bindings produksi

- `ORDER_BACKEND`: service binding ke `seiton-order-bot` production.
- `OTP_BACKEND`: service binding ke `seiton-otp-portal` production.
- `SITE_DB`: D1 database `seiton-site-content-prod`.
- Secret: `OTP_INTERNAL_SECRET` untuk komunikasi internal dengan portal OTP.

Nilai secret tidak boleh dimasukkan ke Git. Source pada `worker.js` disinkronkan dari modul produksi Cloudflare, bukan file Worker versi lama.

## Login, sesi, dan audit

- Validasi sesi owner mengandalkan record sesi pada `SITE_DB` dan validasi token melalui `ORDER_BACKEND`.
- Sesi memiliki masa berlaku terbatas dan dapat dicabut dari panel.
- Cookie sesi menggunakan atribut keamanan HttpOnly/Secure/SameSite.
- Perubahan katalog/harga dicatat pada audit trail.

## Site database migrations

Panel owner menggunakan database terpisah dari order bot. Migrasi milik panel berada di `site-admin/migrations/` dan hanya boleh diterapkan ke `seiton-site-content-prod`, setelah schema produksi diverifikasi.

## Deployment

Gunakan konfigurasi `site-admin/wrangler.jsonc`. Jangan mengubah service binding atau menerapkan migrasi ke production sebelum preview dan smoke test berhasil.

## Unified Owner Control Center — implementasi P0

Implementasi P0 tersedia pada branch `feat/unified-owner-control-center-p0`:

- Shell responsif dengan sidebar dan navigasi satu aplikasi.
- Beranda menampilkan ringkasan diagnostik Worker/Telegram, katalog, serta antrean status pembayaran.
- Modul Bot & Katalog dan Harga Website menggunakan endpoint yang sudah ada.
- Pengelolaan mailbox OTP sudah berada di dalam sesi owner yang sama; `/otp` mengarah ke tab Email & OTP.
- Riwayat audit dan sesi owner tersedia sebagai modul terpisah.
- Waktu audit dan sesi ditampilkan dalam zona `Asia/Jakarta`.

P0 belum mencakup pengelolaan pesanan/pembayaran penuh, metode pembayaran, laporan bisnis, dan Mail Automation. Item tersebut tetap berada pada tahapan P1–P3 sesuai dokumen arsitektur. Worker belum di-deploy; lakukan review dan UAT preview sebelum rilis produksi.
