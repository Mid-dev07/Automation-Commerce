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

## Unified Owner Control Center — P2 reports and analytics

P2 implementation is on branch `feat/unified-owner-control-center-p2`, based on the merged P1 mainline.

### Business reports available in the owner panel
- Date range filters use calendar dates in `Asia/Jakarta`, inclusive at both ends.
- Revenue is calculated only from confirmed paid order states; pending, rejected, and cancelled orders are separated.
- Summary metrics include order count, paid order count, confirmed receipts, outstanding amount, average paid order value, rejected verifications, and cancellations.
- Visual breakdowns show daily confirmed revenue, best-selling products by units, payment-method revenue, and latest order statuses.
- Audit history already merges owner-panel metadata and Order Worker operational events; P2 adds client-side search and source filters.

### Export facade
- `GET /api/control/export?type=orders|finance|daily|inventory&from=YYYY-MM-DD&to=YYYY-MM-DD`
- The type and date range are allowlisted/validated by both Owner Worker and Order Worker.
- Transaction exports respect the inclusive `Asia/Jakarta` date range.
- Inventory is a current catalogue snapshot, not a date-series report.
- CSV is streamed from the Order Worker service binding with `private, no-store` headers; browser code never calls the Order Worker public hostname.
- A `REPORT_EXPORT_SENT` audit event records only report type and selected date range. It never stores report contents, customer data, proof bytes, mailbox contents, or OTP values.

### Analytics boundaries
- This screen is transaction/business analytics from the Order Worker data, not website traffic analytics.
- GA4 visitor/session/page-view metrics are explicitly marked unavailable until GA4 Data API access and read-scoped credentials are integrated and verified.
- Inventory value shown in the exported snapshot is an indicative selling-price × stock calculation, not an accounting valuation.

### P1 runtime wiring correction
A post-merge source review found that the P1 event-handler block had been appended outside the page's inline script/IIFE. This branch moves those handlers into the owner application scope before the initial session check and adds a regression test. This is a source fix; production has not been deployed.

### CI and release gates
- `tests/site-admin-p2-contract.test.cjs` covers P1 handler placement, report UI, paid/pending classification, date validation, export streaming, audit metadata, and analytics boundaries.
- Worker audit CI still runs all `tests/*.test.cjs` and `tests/*.test.mjs`, plus Worker syntax checks.
- Browser UAT and end-to-end export/download checks remain required before merge/deploy.
- No production Worker, Pages configuration, D1, QRIS flag, Telegram webhook, or Google Analytics setting was changed.


## CRM & Manajemen Proyek dalam Owner Control Center

CRM jasa terintegrasi sebagai tab di panel owner yang sama; bukan panel kedua. API menggunakan sesi owner aktif, allowlist origin untuk mutasi, dan database panel `SITE_DB` yang terpisah dari buku pesanan checkout.

### Data yang dicatat
- Pelanggan dan kanal kontak.
- Proyek, layanan, lingkup kerja, nilai penawaran, DP target, tanggal target, dan batas revisi.
- Tahap pipeline dan riwayat perubahan.
- Pembayaran jasa dan pengembalian dana yang harus dikonfirmasi oleh owner.

Jangan simpan password, OTP, access token, QRIS payload, private key, atau kredensial pihak ketiga pada CRM. Buku pembayaran proyek terpisah dari ledger QRIS/order checkout. Pengembalian tidak boleh melebihi pembayaran bersih yang tercatat.

### Migration dan release gate
- `site-admin/migrations/0002_owner_project_pipeline.sql` membuat tabel CRM/proyek, ledger pembayaran proyek, indeks, dan refund guard.
- Migration belum diterapkan ke database produksi pada branch ini.
- Terapkan hanya ke database preview terisolasi, uji create/update/event/payment/refund serta akses owner, lalu minta persetujuan eksplisit sebelum migrasi dan deployment produksi.
- CRM tidak otomatis membuat invoice, mengirim reminder ke pelanggan, atau mengubah status checkout.
