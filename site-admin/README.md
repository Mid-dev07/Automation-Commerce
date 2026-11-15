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

## Unified Owner Control Center — P0/P1

Implementasi berada pada branch `feat/unified-owner-control-center-p1` dan menggabungkan shell P0 dengan workspace operasional P1.

### Modul tersedia di UI
- Beranda dan diagnostik operasional.
- Bot & Katalog (edit/arsip produk dan monitoring Telegram).
- Pesanan (pencarian, filter, dan ubah status melalui transisi backend).
- Pembayaran (antrean verifikasi, bukti, nilai QRIS/OCR, approve/reject).
- Metode Pembayaran dan Rekening Bank (toggle, tambah, dan edit).
- Harga Website.
- Email & OTP.
- Aktivitas dan Keamanan/Sesi.

### API facade owner untuk P1
Seluruh route berikut menggunakan owner session dan Order Worker service binding:
- `GET /api/control/data`
- `GET|POST /api/control/payment-methods`
- `POST /api/control/payment`
- `POST /api/control/order-status`
- `GET /api/control/proof`

Mutasi memeriksa Origin allowlist, sesi owner aktif, JSON body dengan batas ukuran, action/method/status allowlist, dan payload yang dibentuk ulang dari field yang diizinkan. Proof menggunakan stream privat `no-store`, bukan URL file publik.

### Batas keselamatan transaksi
- Logika transaksi, idempotensi pembayaran, verifikasi QRIS, pembuatan receipt, dan validasi status tetap berada di Order Worker.
- Owner UI menampilkan OCR sebagai bantuan pemeriksaan, bukan konfirmasi uang masuk.
- Persetujuan tetap memerlukan pemeriksaan transaksi aktual di akun merchant.
- Mismatch QRIS dan QRIS yang belum memiliki bukti dikunci pada UI; backend tetap melakukan validasi sendiri.
- Tombol metode hanya mengubah konfigurasi ketersediaan metode untuk checkout baru; tidak mengubah QRIS runtime feature flag, template, atau kredensial merchant.
- Rekening yang dinonaktifkan tetap tersimpan; tidak ada penghapusan permanen dari Control Center.
- Tidak ada perubahan skema D1, data transaksi, atau binding produksi.

### Pengujian dan rilis
- Contract tests untuk API facade P1 berada di `tests/site-admin-p1-contract.test.cjs`.
- Workflow `Worker audit checks` menjalankan `node --check site-admin/worker.js` dan seluruh regression tests pada Pull Request.
- Browser UAT untuk desktop/mobile dan pengujian end-to-end tetap wajib sebelum merge/deploy.
- Belum ada deployment produksi.
