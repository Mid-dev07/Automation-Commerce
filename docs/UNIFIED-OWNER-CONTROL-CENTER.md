# Unified Owner Control Center — Seiton.id

Status: **architecture and UX specification**  
Baseline: **15 November 2026**  
Canonical UI target: **https://admin.seiton.biz.id**  
Production code has not been changed by this document.

## 1. Tujuan

Seiton.id dioperasikan oleh satu owner tanpa tim operasional manusia. Panel admin harus mengurangi context switching, menghindari login berulang, serta menampilkan pekerjaan yang perlu ditangani sesuai prioritas.

Tujuan produk:
- Satu alamat panel untuk seluruh kegiatan owner Seiton.id.
- Satu sesi login owner untuk navigasi internal.
- Satu navigasi dan pola interaksi konsisten.
- Dashboard berorientasi tindakan, bukan hanya kumpulan angka.
- Data sensitif tidak muncul pada ringkasan umum.
- Perubahan penting memerlukan konfirmasi eksplisit dan tercatat.
- Kegagalan satu service tidak membuat seluruh panel tidak dapat digunakan.

## 2. Keputusan arsitektur utama

**Satukan control plane, jangan satukan semua data plane.**

seiton-site-admin menjadi Owner Control Center / Backend-for-Frontend (BFF) yang melayani UI pada admin.seiton.biz.id. Worker ini mengatur autentikasi owner, navigasi, agregasi dashboard, dan meneruskan permintaan ke service backend melalui Cloudflare Service Bindings.

Backend yang sudah ada tetap dipertahankan:
- seiton-order-bot tetap pemilik proses transaksi, katalog bot, stok, order, payment ledger, dan laporan operasional.
- seiton-site-admin tetap pemilik data layanan/harga website, sesi owner, serta audit panel.
- seiton-otp-portal tetap pemilik provisioning mailbox OTP dan portal privat.
- seiton-mail-automation tetap pemilik alias email dan pesan masuk automation.
- Cloudflare Pages tetap meng-host website publik dan demo.

D1 transaksi, D1 site-content, D1 mail, R2, KV, serta Durable Objects **tidak digabung menjadi satu database**. Setiap service tetap menjaga schema, lifecycle, dan kontrol aksesnya. Satu panel menggabungkan pengalaman pengguna dan alur kerja, bukan menghapus batas antar-service.

### Diagram target

~~~text
Owner
  |
  | satu login + satu session
  v
admin.seiton.biz.id
Owner Control Center UI
  |
  v
seiton-site-admin (BFF + auth + audit)
  |                 |                 |
  | Service Binding | Service Binding | Service Binding
  v                 v                 v
seiton-order-bot    seiton-otp-portal  seiton-mail-automation
  |                 |                 |
D1 transaksi       DO/KV + D1        D1 mail + encrypted body
R2 media           mailbox state     machine alias/message state
Telegram           private portal    Email Routing / parser
  |
Google Sheets reporting mirror

seiton.biz.id dan demo.seiton.biz.id tetap menjadi situs publik.
~~~

## 3. Satu lokasi panel dan navigasi

### Alamat
- Canonical panel: https://admin.seiton.biz.id/
- https://owner.seiton.biz.id/ menjadi alias/redirect menuju canonical panel.
- https://umkm.seiton.biz.id/ tidak lagi menjadi entry point owner sehari-hari. Setelah migrasi dan UAT, host tersebut dapat diarahkan ke bagian Operasional pada canonical panel.
- /otp tidak lagi menjadi aplikasi terpisah; rute ini diarahkan ke tab Email & OTP.
- mail.seiton.biz.id dan otp.seiton.biz.id tetap tersedia untuk endpoint/service atau akses privat yang diperlukan, tetapi bukan item navigasi utama owner.
- automate-bot.seiton.biz.id tetap host teknis webhook/health, bukan dashboard manusia.

Alias/redirect baru hanya dilakukan setelah fungsi dan akses canonical panel benar-benar lulus UAT. Jangan mematikan fallback panel lama sebelum itu.

### Struktur sidebar yang disarankan

| Grup | Menu | Isi |
|---|---|---|
| Ringkasan | Beranda | KPI operasional, antrean tindakan, kesehatan service, aktivitas terbaru |
| Operasional | Pesanan | Semua pesanan, filter status/tanggal/metode, detail, histori |
| Operasional | Pembayaran | Bukti pembayaran, pemeriksaan nominal, approve/reject, status receipt |
| Operasional | Produk & Stok | Katalog Telegram, foto, harga, stok, status aktif, arsip |
| Operasional | Metode Pembayaran | QRIS/transfer/COD, rekening bank, instruksi, enable/disable |
| Operasional | Pickup & Bantuan | Pickup verification, human handoff, pesan yang perlu ditindaklanjuti |
| Bisnis | Harga Layanan | Harga website, add-on, availability, deskripsi, fitur |
| Bisnis | Website | Domain, deployment status, halaman publik, sitemap, link demo |
| Email & OTP | Email Automation | Alias email, masa aktif, pesan masuk, status ingestion |
| Email & OTP | Portal OTP | Provision mailbox, daftar mailbox, rotate/revoke akses |
| Analitik | Laporan | Ringkasan penjualan, tren, produk, ekspor CSV |
| Sistem | Integrasi & Health | Worker status, Telegram/webhook, D1 readiness, Email Routing state, API dependency |
| Sistem | Aktivitas | Audit gabungan dari panel dan order bot |
| Sistem | Keamanan | Sesi owner aktif, pencabutan sesi, waktu kedaluwarsa |

Jangan menampilkan menu yang backend-nya belum siap sebagai tombol aktif. Menu dalam persiapan tidak boleh menyesatkan owner.

## 4. Beranda: desain untuk satu operator

Beranda harus menjawab:
1. Apa yang perlu saya tangani sekarang?
2. Apakah ada masalah di sistem?
3. Bagaimana kondisi order dan pembayaran?
4. Apakah ada risiko yang dapat mengganggu pelanggan?

### Urutan konten

**A. Status sistem**
- Website utama dan demo.
- Telegram bot dan webhook.
- Transaction store D1.
- Email Routing / Mail Automation.
- OTP Portal.
- Pricing API.

Setiap integrasi memiliki status Sehat, Perlu perhatian, Tidak tersedia, atau Belum diverifikasi, disertai timestamp pemeriksaan dan tindakan relevan. Jangan menyimpulkan service sehat hanya karena satu endpoint lain merespons.

**B. Perlu tindakan**
Daftar tugas berurutan berdasarkan urgensi, misalnya:
- Bukti pembayaran menunggu pemeriksaan.
- Order perlu diproses atau pickup.
- Stok produk menipis/habis.
- Handoff pelanggan menunggu respons.
- Email ingestion gagal atau alias mendekati kedaluwarsa.
- Webhook Telegram memiliki error.

Setiap item membuka detail pada panel yang sama dan memberikan next action yang jelas. Data email/OTP sensitif tidak ditampilkan pada dashboard umum.

**C. KPI**
- Order hari ini.
- Order menunggu pembayaran.
- Pembayaran menunggu verifikasi.
- Omzet terbayar.
- Order perlu diproses.
- Produk aktif/stok kritis.

KPI harus membedakan nilai order, klaim pembayaran, terverifikasi, dan omzet terbayar. Jangan mencampur nominal pending dengan revenue.

**D. Aktivitas terbaru**
- Produk diubah.
- Pembayaran disetujui/ditolak.
- Order status berubah.
- Metode pembayaran diubah.
- Mailbox diprovision/dirotasi/dicabut.
- Perubahan harga website.
- Login/logout atau pencabutan sesi.

Audit hanya menyimpan metadata yang diperlukan; jangan simpan OTP, isi pesan pelanggan, token, password, private key, atau bukti pembayaran mentah dalam ringkasan audit.

## 5. User flow utama

### Flow A — Pembukaan hari
1. Owner membuka admin.seiton.biz.id.
2. Login sekali.
3. Beranda memeriksa service secara paralel dan menampilkan timestamp setiap pemeriksaan.
4. Bagian Perlu tindakan berada di urutan pertama.
5. Owner membuka item pertama, menyelesaikan tindakan, lalu kembali ke antrean tanpa kehilangan filter/konteks.

### Flow B — Verifikasi pembayaran
1. Klik Pembayaran perlu diverifikasi.
2. Lihat order, customer, jumlah yang diharapkan, metode, waktu, dan bukti.
3. Sistem menandai hasil OCR sebagai bantuan pemeriksaan, bukan keputusan final.
4. Owner memeriksa transaksi aktual di akun merchant.
5. Owner memilih Setujui atau Tolak.
6. Konfirmasi menampilkan dampak tindakan.
7. Backend menjalankan transisi idempotent.
8. Receipt hanya diterbitkan satu kali.
9. Panel menampilkan hasil, status pengiriman receipt, dan audit entry.

Tidak boleh ada tombol approve yang dapat dijalankan berulang kali tanpa memeriksa status transaksi. Bila backend mengembalikan ALREADY_APPROVED, UI menampilkan status sebelumnya tanpa mengirim receipt kedua.

### Flow C — Perbarui produk
1. Buka Produk & Stok.
2. Cari SKU atau nama.
3. Tambah/edit melalui form bertahap dengan preview foto.
4. Validasi harga, stok, URL gambar, status aktif, dan SKU.
5. Ringkasan perubahan ditampilkan sebelum simpan.
6. Simpan ke D1 melalui Order Worker.
7. UI menampilkan konfirmasi sumber katalog Telegram telah diperbarui.

Arsipkan produk, jangan menghapus order historis atau item lama.

### Flow D — Perbarui harga website
1. Buka Harga Layanan.
2. Edit harga, ketersediaan, deskripsi, dan add-on.
3. Lihat preview ringkas sebelum publikasi.
4. Simpan ke Site Admin D1.
5. API pricing menjadi sumber data website.
6. UI menunjukkan waktu update dan link untuk melihat halaman harga.

Website Astro tetap static-first. Panel tidak boleh berpura-pura sebagai CMS untuk halaman yang saat ini hanya diubah melalui GitHub/source deployment.

### Flow E — Email dan OTP
1. Buka Email Automation atau Portal OTP dalam panel yang sama.
2. Buat/list/rotate/revoke alias atau mailbox yang diotorisasi.
3. Pilih masa retensi/masa aktif dari opsi yang disetujui backend.
4. Daftar pesan hanya muncul setelah alias/mailbox dipilih.
5. Isi pesan dibuka melalui tindakan eksplisit, tidak otomatis pada dashboard.
6. Akses privat hanya diberikan kepada pemilik/pihak yang diotorisasi.
7. Revoke harus menjelaskan dampaknya sebelum dijalankan.

Email Automation dan OTP Portal adalah dua service berbeda; UI boleh menyatukan keduanya pada satu grup tetapi jangan menyamakan skema atau lifecycle datanya.

### Flow F — Laporan
1. Pilih rentang tanggal dan timezone Asia/Jakarta.
2. Bedakan paid, pending, rejected, cancelled, dan completed.
3. Pilih ringkasan transaksi, produk, metode pembayaran, atau laporan lengkap.
4. Tampilkan pratinjau sebelum ekspor.
5. Ekspor menggunakan endpoint resmi yang tersedia.
6. Catat event export, bukan isi sensitif file.

## 6. Peta integrasi API yang sudah tersedia

### 6.1 Owner Worker (seiton-site-admin)

Sudah tersedia:
- GET /api/session
- POST /api/login
- POST /api/logout
- GET /api/admin/pricing
- PUT /api/admin/pricing
- GET /api/admin/audit
- GET /api/admin/sessions
- POST /api/admin/sessions/revoke
- GET /api/admin/bot/data
- GET /api/admin/bot/diagnostics
- POST /api/admin/bot/products
- GET /api/admin/otp/mailboxes
- POST /api/admin/otp/mailboxes
- POST /api/admin/otp/mailboxes/rotate
- POST /api/admin/otp/mailboxes/revoke

Owner session memvalidasi token ke Order Worker. Mutasi owner harus tetap memeriksa same-origin dan sesi aktif.

### 6.2 Order Worker (seiton-order-bot)

Endpoint internal yang sudah dipakai Admin Workspace:
- GET /api/admin/data
- GET /api/admin/bot/diagnostics
- GET /api/admin/activity-audit
- GET /api/admin/export?type=...
- GET /api/admin/proof?order_id=...
- GET|POST /api/admin/payment-methods
- POST /api/admin/payment
- POST /api/admin/products
- POST /api/admin/order-status
- POST /api/admin/session/revoke

Sebagian route sudah diproxy oleh Owner Worker (bot/data, bot/diagnostics, bot/products) tetapi belum semua tersedia melalui satu API facade.

### 6.3 OTP Portal

Owner Worker saat ini telah meneruskan endpoint internal melalui OTP_BACKEND untuk:
- Daftar mailbox.
- Provision/create mailbox.
- Rotate akses.
- Revoke akses.

UI /otp yang terpisah perlu dipindahkan menjadi komponen/tab pada Control Center, bukan dipertahankan sebagai halaman aplikasi kedua.

### 6.4 Mail Automation

Worker mail saat ini menyediakan:
- Sesi owner sendiri melalui /api/session, /api/setup, /api/login, /api/logout.
- Alias list/create/revoke melalui /api/aliases.
- Pesan list/delete melalui /api/messages.
- Machine API dengan MAIL_VM_API_TOKEN untuk create alias, list messages, detail message, dan revoke alias.

Integrasi ke Owner Control Center membutuhkan Service Binding MAIL_BACKEND dan pola machine/service authentication server-side. Machine API saat ini belum mempunyai endpoint list alias yang cocok untuk tampilan semua alias yang dibuat token machine; perlu endpoint tambahan yang membatasi hasil pada alias milik token tersebut.

Jangan mengirim MAIL_VM_API_TOKEN ke browser. Jangan menyimpan nilai token di Git. Jangan menyatukan sesi owner Mail dengan sesi owner panel melalui cookie palsu atau menonaktifkan auth lama.

## 7. API facade yang direkomendasikan

Tambahkan API namespace khusus pada Owner Worker, misalnya:
- GET /api/control/overview
- GET /api/control/orders
- GET /api/control/payment-methods
- POST /api/control/payment
- POST /api/control/order-status
- GET /api/control/proof
- GET /api/control/reports
- GET /api/control/catalog
- POST /api/control/catalog
- GET /api/control/email/aliases
- POST /api/control/email/aliases
- GET /api/control/email/messages
- GET /api/control/otp/mailboxes
- POST /api/control/otp/mailboxes
- GET /api/control/health
- GET /api/control/activity

Nama di atas adalah usulan kontrak UI, bukan klaim bahwa route tersebut sudah tersedia.

Aturan BFF:
1. Semua endpoint memerlukan owner session yang valid.
2. Setiap mutasi wajib memeriksa same-origin/CSRF.
3. Gunakan exact allowlist method + path; jangan membuat open proxy.
4. Gunakan Service Bindings; jangan membuat browser memanggil hostname internal lintas Worker secara langsung.
5. Kirim token antarservice hanya dari server-side Worker binding.
6. Batasi ukuran payload, tipe konten, query, dan pagination.
7. Sanitasi error upstream; jangan memantulkan secret/token/body sensitif ke UI.
8. Teruskan status upstream yang relevan, Retry-After, dan content-type yang aman.
9. Gunakan audit trail existing pada service yang memiliki mutasi.
10. Jangan menjalankan query D1 milik service lain secara langsung.

### Auth dan session
- Satu login dilakukan di admin.seiton.biz.id.
- Owner session yang ada dipertahankan.
- Service backend masih memverifikasi token internal sesuai kontrak service.
- Tidak perlu mengirim token atau password ke JavaScript.
- Logout harus mengakhiri sesi owner dan propagasi pencabutan sesi backend.
- Jika satu backend unavailable, area terkait tampil degraded dengan Retry; area lain tetap bisa dipakai.

## 8. UI design system dan interaksi

### Arah visual

Gunakan identitas Seiton:
- Ink: #1F2937
- Ink soft: #354253
- Orange: #FF6B35
- Orange deep: #B94A22
- Text accent: #A94420
- Bone: #F7F5EF
- Surface: #FFFFFF
- Sage: #E7EDE4
- Border: #DFE1DC
- Muted: #5E6874

### Layout desktop
- Sidebar kiri konsisten dengan grup navigasi yang dapat diciutkan.
- Topbar berisi judul konteks, pencarian global, status service, bantuan, dan menu sesi.
- Area konten lebar dan tidak terlalu padat.
- Detail order/email menggunakan drawer kanan atau detail page, bukan modal bertumpuk.
- Form perubahan menggunakan wizard/stepper untuk tugas kompleks.
- Action bar kontekstual hanya muncul ketika ada perubahan yang belum disimpan.

### Layout mobile
- Sidebar menjadi drawer.
- Navigasi utama tetap mudah disentuh.
- Tabel menjadi list/card yang dapat dipindai.
- Tombol aksi penting tidak berdesakan.
- Form satu kolom dan memiliki sticky submit bila sesuai.
- Tidak boleh ada horizontal overflow pada lebar 390 px.

### Pola interaksi wajib
- Loading skeleton untuk fetch.
- Error message menyatakan apa yang gagal dan cara retry.
- Empty state menjelaskan apa yang belum tersedia dan tindakan berikutnya.
- Filter/search mempertahankan state saat kembali dari detail.
- Form memiliki validasi inline dan ringkasan sebelum mutasi.
- Tindakan destruktif memerlukan konfirmasi.
- Simpan manual untuk perubahan penting; jangan auto-save harga, status pembayaran, metode pembayaran, atau akses mailbox.
- Timestamp ditampilkan dalam Asia/Jakarta.
- Status tidak mengandalkan warna saja; selalu sertakan teks.

## 9. AI assistance di panel

AI dapat menjadi asisten operasional, tetapi tidak mengambil alih otoritas transaksi.

Fase mendatang:
- Ringkasan apa yang perlu ditangani.
- Penjelasan mengapa order tertahan.
- Deteksi anomali nominal/pembayaran/duplikasi sebagai peringatan.
- Ringkasan penjualan dan tren.
- Rekomendasi restock atau perbaikan katalog.
- Draft balasan pelanggan dan draft perubahan harga/produk.

Batas wajib:
- Default read-only.
- AI tidak menyetujui pembayaran.
- AI tidak mengubah harga, metode pembayaran, stok, QRIS feature flags, atau sesi mailbox tanpa konfirmasi owner.
- AI tidak mengakses/menampilkan OTP atau inbox yang tidak dimiliki/diotorisasi.
- Setiap tindakan AI harus menjadi proposal yang bisa ditinjau, diedit, disetujui, atau dibatalkan owner.
- Tidak ada agent background yang menjalankan mutasi tanpa persetujuan dan audit.

## 10. Tahapan implementasi

### P0 — Foundation dan shell terpadu
- Buat UI shell baru pada admin.seiton.biz.id.
- Sidebar, topbar, responsive layout, dan design tokens.
- Satu login owner.
- Dashboard dengan status service dan ringkasan data.
- Route /otp dialihkan ke tab Email & OTP setelah UI pengganti siap.
- Tidak mengubah schema transaksi atau QRIS.

### P1 — Operasional order dan katalog
- Proxy endpoint order yang belum terhubung.
- Manajemen pesanan dan detail order.
- Bukti pembayaran, approve/reject, status order, idempotensi receipt.
- Metode pembayaran dan rekening.
- Produk, foto, stok, arsip, pencarian.
- Pickup dan handoff.

### P2 — Harga, laporan, audit, OTP
- Harga layanan dan add-on.
- Laporan penjualan dan ekspor.
- Audit gabungan.
- Sesi owner.
- OTP mailbox management dalam tab yang sama.

### P3 — Mail Automation dan monitoring menyeluruh
- Service Binding MAIL_BACKEND.
- Machine auth server-side.
- Endpoint list alias scoped ke machine token.
- Alias/email inbox list/detail/retention/revoke.
- Health status email routing dan ingest.
- Integrasi deployment website/GA4 hanya setelah credential dan read scope siap.

### P4 — AI Operating Assistant
- Summary dan rekomendasi read-only.
- Draft actions dengan persetujuan owner.
- Tidak ada autonomous payment, price, secret, DNS, atau account mutation.

## 11. Pengendalian risiko dan acceptance criteria

### Fungsional
- [ ] Owner login satu kali dan dapat membuka semua modul tanpa login kedua.
- [ ] Seluruh panel utama memakai hostname admin.seiton.biz.id.
- [ ] Navigasi tidak membuka umkm, mail, atau /otp sebagai aplikasi terpisah.
- [ ] Pesanan, pembayaran, metode, katalog, harga, laporan, OTP dan audit berfungsi melalui API facade.
- [ ] Satu service gagal tidak mematikan seluruh panel.
- [ ] Pencarian global mengarahkan ke jenis resource yang benar.
- [ ] Filter tetap terjaga setelah kembali dari detail.

### Keamanan
- [ ] Semua endpoint internal menolak request tanpa owner session.
- [ ] Mutasi menolak origin yang tidak sah.
- [ ] Token service tidak pernah muncul di HTML/JavaScript/browser response.
- [ ] Email alias list dibatasi ke alias milik token/service.
- [ ] Detail email hanya terbuka setelah dipilih secara eksplisit.
- [ ] OTP dan isi pesan tidak masuk ke audit log.
- [ ] Order payment approval idempotent.
- [ ] Receipt tidak diterbitkan dua kali.
- [ ] Stok tetap dilindungi D1/OrderCoordinator.
- [ ] QRIS production flags tidak berubah selama UI redesign.
- [ ] Tidak ada migration production yang dijalankan hanya untuk redesign panel.

### UX dan kualitas
- [ ] Beranda menempatkan antrean tindakan sebelum metrik sekunder.
- [ ] 390 px, 768 px, 1024 px, dan 1440 px tanpa overflow/layout clipping.
- [ ] Navigasi dan form dapat dipakai dengan keyboard.
- [ ] Loading, empty, error, degraded, dan success states tersedia.
- [ ] Kontras teks dan fokus terlihat.
- [ ] Status memiliki teks, bukan hanya warna.
- [ ] Tindakan sensitif selalu menampilkan konsekuensi sebelum submit.

### Release
- [ ] Unit/contract tests untuk Owner Worker dan Order Worker lulus.
- [ ] Inline/module JS parse check lulus.
- [ ] API proxy tests mencakup 401, 403, 404, 429, 5xx dan body invalid.
- [ ] Preview/UAT mencakup seluruh flow.
- [ ] Rollback ke panel lama tersedia sampai UAT disetujui.
- [ ] Production Worker deploy hanya setelah persetujuan eksplisit.

## 12. Hal yang tidak boleh dianggap sudah tersedia

- Owner panel saat ini sudah memiliki dashboard bot/Telegram, edit katalog produk, daftar order terbaru, harga website, audit, dan sesi.
- Order Workspace saat ini memiliki layar lebih lengkap untuk pesanan, pembayaran, metode pembayaran, katalog, dan laporan.
- OTP page sekarang sudah memiliki API integration dari Owner Worker, tetapi masih berupa halaman terpisah.
- Mail Automation memiliki login dan API tersendiri. Owner Control Center belum memiliki service binding atau SSO/API facade lengkap untuknya.
- Website publik tidak mempunyai CMS penuh. Perubahan konten halaman masih melalui source GitHub dan deployment Pages; pricing dari API dapat diedit di panel.
- Integrasi GA4 Data API dan kontrol Pages deployment belum tersedia pada Owner Control Center.

Jangan menandai item selesai hanya karena nama menu atau placeholder sudah muncul. Acceptance test harus membuktikan data dibaca dari backend yang benar dan mutasi benar-benar tersimpan.

## 13. Sumber implementasi

- site-admin/worker.js — panel owner, sesi, pricing, audit, dan proxy awal.
- site-admin/wrangler.jsonc — service bindings Order dan OTP saat ini.
- worker.js — Admin Workspace, orders, payments, product CRUD, payment methods, proof, report.
- site-admin/migrations/0001_owner_admin_sessions_audit.sql — owner sessions/audit.
- docs/TRANSACTION_CORE.md — source of truth D1.
- docs/INTERNAL-QRIS-ENGINE.md — QRIS release gates.
- docs/messaging-core.md — customer handoff dan outbox.
- otp-portal/README.md — OTP runtime.
- Worker runtime seiton-mail-automation — Email Automation (source snapshot dibaca langsung dari Cloudflare; belum berada lengkap di repo).

Dokumen ini adalah baseline desain. Perubahan code harus dikerjakan pada feature branch dan diuji sebelum production deployment.