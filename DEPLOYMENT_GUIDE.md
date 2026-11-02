# Seiton.id — Deployment Guide

> **Copyright (c) 2026 Seiton.id. All rights reserved.**  
> Official website: https://seiton.biz.id  
> Source files: `worker.js`, `setupDashboard.gs`, `DEPLOYMENT_GUIDE.md`

Panduan ini menyiapkan bot pemesanan Telegram + WhatsApp yang berjalan di Cloudflare Workers, menyimpan transaksi ke Google Sheets, dan membangun dashboard analitik langsung di spreadsheet. Tidak ada frontend web yang disertakan.

## 1. Arsitektur dan batasan penting

```text
Telegram ──Webhook──┐
                   ├── Cloudflare Worker ── Google Sheets API
WhatsApp ─Webhook──┘          │
                              └── KV (opsional: cache token & dedupe singkat)

Google Apps Script ─────────────── Dashboard / QUERY / SUMIFS / SPARKLINE
```

- Worker memakai ES Modules dan Web Crypto untuk membuat Google Service Account JWT.
- Google Sheets menjadi penyimpanan eksternal untuk katalog dan transaksi.
- Bot menerima format `beli SKU jumlah METODE`, contoh `beli SEI-001 2 QRIS`.
- Status awal order adalah `MENUNGGU_PEMBAYARAN`. Omset laporan dihitung dari status `DIBAYAR`, `SELESAI`, `PAID`, atau `COMPLETED`.
- Perubahan status pembayaran harus dilakukan admin pada kolom `status` sheet `Pesanan`, atau melalui integrasi payment gateway yang telah diverifikasi.
- WhatsApp Cloud API membutuhkan akses Graph API yang aktif. Gateway pihak ketiga dapat digunakan hanya jika payload dan endpoint-nya disesuaikan.
- Tidak ada klaim SLA latensi di bawah 15 ms: respons bergantung pada Google OAuth/Sheets dan jaringan eksternal. Jalur webhook merespons cepat, sedangkan proses transaksi berjalan via `ctx.waitUntil`.
- Kuota gratis Cloudflare, Google Sheets API, Telegram, dan WhatsApp dapat berubah. 100.000 request/hari tidak dijamin gratis atau otomatis aman tanpa pengujian kuota, rate limit, dan kapasitas provider.
- Google Sheets bukan database transaksional. Untuk flash sale/konkurensi tinggi, gunakan Cloudflare Queues + database transaksional (mis. D1) sebagai sumber kebenaran, lalu ekspor/rekap ke Sheets.

## 2. Prerequisites

- Akun Cloudflare dengan akses Workers.
- Node.js LTS dan npm.
- Akun Google dengan Google Sheets dan Apps Script.
- Telegram bot dari BotFather.
- Meta Developer App dengan WhatsApp Cloud API, atau gateway kompatibel.
- GitHub repository (opsional untuk deployment berkelanjutan).

## 3. Menyiapkan Google Sheets

### 3.1 Buat spreadsheet

Buat spreadsheet baru, misalnya `Seiton.id - Order Database`. Salin Spreadsheet ID dari URL:

`https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`

### 3.2 Buat Service Account

1. Buka Google Cloud Console: https://console.cloud.google.com/
2. Buat project atau pilih project yang digunakan.
3. Aktifkan **Google Sheets API**.
4. Buka **IAM & Admin → Service Accounts → Create Service Account**.
5. Buat key bertipe JSON dan simpan aman di luar repository.
6. Salin alamat `client_email` service account.
7. Bagikan spreadsheet kepada `client_email` tersebut dengan role **Editor**.
8. Jangan pernah commit file JSON key ke GitHub atau menaruh private key di Apps Script.

Worker membutuhkan JSON key lengkap sebagai secret `GOOGLE_SERVICE_ACCOUNT_KEY`.

### 3.3 Buat tab dan header

Buat dua tab dengan nama persis:

**Pesanan** — baris pertama berisi 13 kolom:

| Kolom | Header |
|---|---|
| A | order_id |
| B | created_at |
| C | channel |
| D | customer_id |
| E | customer_name |
| F | product |
| G | quantity |
| H | unit_price |
| I | subtotal |
| J | shipping |
| K | total |
| L | payment_method |
| M | status |

**Katalog_Produk** — baris pertama:

| Kolom | Header | Contoh |
|---|---|---|
| A | sku | SEI-001 |
| B | nama_produk | Kaos Seiton |
| C | harga | 125000 |
| D | stok | 20 |
| E | aktif | TRUE |

Masukkan satu produk per baris mulai baris 2. `sku` harus unik. Harga dan stok harus berupa angka; `aktif` bernilai TRUE/FALSE. Kosongkan stok jika tidak ingin validasi stok. Saat ini stok hanya divalidasi, belum dikurangi otomatis agar tidak menimbulkan race condition pada Google Sheets.

## 4. Menyiapkan Dashboard Google Sheets

1. Buka spreadsheet.
2. Pilih **Extensions → Apps Script**.
3. Hapus kode awal dan tempel seluruh isi `setupDashboard.gs`.
4. Simpan project dengan nama `Seiton Dashboard`.
5. Pilih fungsi `setupDashboard` lalu klik **Run**.
6. Tinjau dan berikan izin akses yang diminta Google.
7. Kembali ke spreadsheet dan buka tab `Dashboard`.

Generator membuat Executive KPI Cards, tren 14 hari, formula `SPARKLINE`, tabel Top 5 produk, distribusi metode pembayaran, status transaksi, conditional formatting, dan footer `Powered by Seiton.id`.

Formula menggunakan pemisah argumen dan nama fungsi Google Sheets. Jika locale spreadsheet menyebabkan formula tidak dikenali, ubah **File → Settings → Locale** menjadi Indonesia atau United States sesuai pemisah formula yang diterima spreadsheet Anda, lalu jalankan `setupDashboard()` lagi.

Dashboard menghitung omset berdasarkan status pembayaran final. Order baru berstatus `MENUNGGU_PEMBAYARAN`, sehingga tidak masuk omset sampai status diubah menjadi `DIBAYAR` atau status final yang didukung.

Opsional: jalankan `installDashboardRefreshTrigger()` satu kali untuk memasang trigger refresh timestamp setiap 15 menit. Formula Sheets sendiri akan dihitung ulang oleh Google Sheets.

## 5. Menyiapkan Cloudflare Worker

### 5.1 Struktur project

```text
seiton-order-bot/
├── worker.js
├── wrangler.toml
└── DEPLOYMENT_GUIDE.md
```

Simpan `worker.js` dari paket ini ke direktori project.

### 5.2 Konfigurasi Wrangler

Buat `wrangler.toml`:

```toml
name = "seiton-order-bot"
main = "worker.js"
compatibility_date = "2026-11-02"

[observability]
enabled = true

[[kv_namespaces]]
binding = "TOKEN_KV"
id = "GANTI_DENGAN_KV_NAMESPACE_ID"

[[kv_namespaces]]
binding = "ORDERS_KV"
id = "GANTI_DENGAN_KV_NAMESPACE_ID"
```

Buat namespace KV jika ingin cache token Google dan deduplikasi singkat:

```bash
npx wrangler kv namespace create TOKEN_KV
npx wrangler kv namespace create ORDERS_KV
```

Salin ID yang dikembalikan ke `wrangler.toml`. KV bersifat eventual consistency; deduplikasi di contoh ini hanya perlindungan retry sederhana, bukan jaminan exactly-once atau lock transaksi. Untuk lingkungan uji tanpa KV, hapus blok `[[kv_namespaces]]`; kode tetap berjalan tanpa cache/dedupe.

### 5.3 Instal Wrangler dan login

```bash
npm install --save-dev wrangler
npx wrangler login
npx wrangler whoami
```

### 5.4 Environment variables dan secrets

Gunakan `wrangler secret put` untuk seluruh token/private key. Jangan menaruh nilai rahasia di `wrangler.toml`.

| Nama | Jenis | Keterangan |
|---|---|---|
| `TELEGRAM_TOKEN` | Secret | Token bot dari BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret, disarankan | Secret token header webhook Telegram |
| `ADMIN_CHAT_ID` | Variable/Secret | Telegram chat ID admin; beberapa ID dipisahkan koma. Untuk admin WhatsApp, masukkan nomor format internasional tanpa `+` pada daftar yang sama |
| `GOOGLE_SHEETS_ID` | Variable | ID spreadsheet |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Secret | Seluruh JSON key service account satu baris |
| `LINK_QRIS_IMAGE` | Variable | URL gambar QRIS (HTTPS) |
| `TARGET_OMSET_HARIAN` | Variable | Target omset harian dalam Rupiah, angka tanpa pemisah |
| `DEFAULT_SHIPPING` | Variable opsional | Ongkir flat per order, angka Rupiah |
| `WHATSAPP_VERIFY_TOKEN` | Secret | Token verifikasi webhook buatan sendiri |
| `WHATSAPP_ACCESS_TOKEN` | Secret | Meta WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Variable | Phone Number ID dari Meta |
| `WHATSAPP_APP_SECRET` | Secret wajib untuk POST WhatsApp | App Secret Meta; digunakan memvalidasi X-Hub-Signature-256 |

Set secret satu per satu:

```bash
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_CHAT_ID
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_APP_SECRET
```

Atur variable non-rahasia melalui Cloudflare Dashboard → Workers & Pages → Worker → Settings → Variables, atau bagian `[vars]` Wrangler:

```toml
[vars]
GOOGLE_SHEETS_ID = "GANTI_SPREADSHEET_ID"
LINK_QRIS_IMAGE = "https://domain-anda.example/qris.png"
TARGET_OMSET_HARIAN = "1000000"
DEFAULT_SHIPPING = "12000"
WHATSAPP_PHONE_NUMBER_ID = "GANTI_PHONE_NUMBER_ID"
```

Untuk keamanan, gunakan secret untuk `ADMIN_CHAT_ID` bila Anda tidak ingin ID admin tampil di repository.

## 6. Deploy ke Cloudflare

### 6.1 Deploy dari CLI

```bash
npx wrangler deploy
```

Simpan URL Worker yang muncul, misalnya:

`https://seiton-order-bot.<subdomain>.workers.dev`

Health check:

```bash
curl https://seiton-order-bot.<subdomain>.workers.dev/health
```

Harus mengembalikan JSON `{"ok":true,...}`.

### 6.2 Deploy dari GitHub

1. Push `worker.js`, `wrangler.toml`, dan dokumen ke repository.
2. Cloudflare Dashboard → **Workers & Pages → Create → Connect to Git**.
3. Pilih repository dan branch produksi.
4. Build command dapat dikosongkan untuk Worker JavaScript murni; deploy command gunakan `npx wrangler deploy`.
5. Pastikan secrets dan KV bindings diatur pada environment produksi Cloudflare, bukan hanya lokal.
6. Aktifkan deployment otomatis setelah commit jika pipeline sudah tervalidasi.

## 7. Pendaftaran webhook Telegram

1. Buat bot melalui https://t.me/BotFather dan simpan token.
2. Pastikan Worker sudah live.
3. Daftarkan webhook. Ganti URL dan token sesuai konfigurasi:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://seiton-order-bot.<subdomain>.workers.dev/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

4. Periksa status:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/getWebhookInfo"
```

Telegram mengirim `X-Telegram-Bot-Api-Secret-Token`, yang diverifikasi Worker bila `TELEGRAM_WEBHOOK_SECRET` diisi.

## 8. Pendaftaran webhook WhatsApp Cloud API

1. Buat aplikasi di https://developers.facebook.com/ dan tambahkan produk WhatsApp.
2. Siapkan WhatsApp Business Account, nomor, Phone Number ID, dan access token.
3. Pada konfigurasi Webhooks, gunakan callback URL:

   `https://seiton-order-bot.<subdomain>.workers.dev/whatsapp`

4. Isi Verify Token dengan nilai yang sama persis dengan `WHATSAPP_VERIFY_TOKEN`.
5. Pilih object `whatsapp_business_account`, lalu subscribe field `messages`.
6. Simpan konfigurasi dan lakukan verifikasi callback.
7. Pastikan token WhatsApp mempunyai izin dan masa berlaku yang sesuai. Token sementara dari panel pengujian tidak cocok untuk produksi permanen.

**Keamanan webhook:** GET memvalidasi challenge dan POST memverifikasi `X-Hub-Signature-256` dengan HMAC-SHA256 memakai `WHATSAPP_APP_SECRET`. POST WhatsApp akan ditolak jika secret belum dikonfigurasi atau signature tidak valid. Gunakan App Secret dari aplikasi Meta yang benar.

## 9. Format interaksi bot

Format order:

```text
beli SKU jumlah METODE
```

Contoh:

```text
beli SEI-001 2 QRIS
beli SEI-002 1 TRANSFER
beli SEI-003 3 COD
```

Metode yang diterima: `QRIS`, `TRANSFER`, `COD`.

Perintah admin:

```text
/laporan
```

Bot membatasi laporan ke ID pada `ADMIN_CHAT_ID`. Untuk Telegram gunakan numeric chat ID. Untuk WhatsApp gunakan nomor internasional tanpa tanda `+` yang sama dengan `messages[].from`.

Laporan menampilkan omset terbayar, jumlah order terbayar, omset dan order hari ini, produk terlaris, ringkasan metode pembayaran, serta progress bar target harian. Status order yang belum dibayar tidak dihitung sebagai omset.

## 10. Testing flow

### 10.1 Persiapan

- [ ] Spreadsheet ID dan service account benar.
- [ ] Spreadsheet sudah dibagikan sebagai Editor kepada service account.
- [ ] Tab `Pesanan` dan `Katalog_Produk` mempunyai header persis.
- [ ] Katalog berisi SKU aktif dengan harga numerik.
- [ ] Secrets Cloudflare sudah diset.
- [ ] `/health` mengembalikan status OK.
- [ ] Webhook Telegram/WhatsApp sudah terdaftar.

### 10.2 Simulasi pembelian

Kirim ke bot:

```text
beli SEI-001 2 QRIS
```

Periksa:
- [ ] Bot mengirim ID order dan rincian harga.
- [ ] Baris baru masuk ke tab `Pesanan`.
- [ ] Channel tercatat `telegram` atau `whatsapp`.
- [ ] Status awal `MENUNGGU_PEMBAYARAN`.
- [ ] Total sama dengan (harga × jumlah) + ongkir.

Uji juga SKU yang tidak ada, SKU nonaktif, stok kurang, jumlah 0, dan metode pembayaran tidak dikenal. Input invalid harus ditolak.

### 10.3 Simulasi laporan admin

1. Ubah salah satu status transaksi pada kolom M menjadi `DIBAYAR`.
2. Kirim `/laporan` dari akun admin.
3. Pastikan transaksi tersebut masuk ke total omset dan rekap hari ini bila tanggalnya hari ini.
4. Uji dari akun non-admin; bot harus menolak akses laporan.

### 10.4 Uji dashboard

- [ ] Jalankan `setupDashboard()` di Apps Script.
- [ ] Pastikan KPI, sparkline, Top 5, payment mix, dan status transaksi tampil.
- [ ] Tambahkan transaksi uji dengan status `DIBAYAR`.
- [ ] Pastikan rumus dashboard memperbarui angka.
- [ ] Hapus transaksi uji sebelum penggunaan nyata.

## 11. Operasional, keamanan, dan scale

1. **Webhook signature:** lengkapi verifikasi signature WhatsApp sebelum menerima order produksi.
2. **Idempotensi:** contoh menggunakan KV untuk dedupe retry 30 detik berdasarkan kombinasi pelanggan/SKU/jumlah/metode. Dua pembelian identik dalam rentang ini dapat dianggap duplikat; sesuaikan strategi dengan UX. Untuk jaminan kuat, gunakan order nonce/checkout ID unik dan penyimpanan transaksional.
3. **Stok:** kode membaca stok, tetapi tidak mengurangi stok. Google Sheets tidak mendukung transaksi atomik untuk reservasi stok bersamaan.
4. **Status pembayaran:** jangan mengubah status menjadi `DIBAYAR` hanya karena pelanggan mengirim bukti chat. Verifikasi callback payment gateway bertanda tangan.
5. **Rate limiting:** aktifkan Cloudflare WAF/rate limiting dan batasi abuse pada endpoint webhook. Jangan memblokir IP Telegram/Meta tanpa allowlist resmi yang dipelihara.
6. **Logging:** pantau Worker Logs. Jangan log access token, private key, isi pesan sensitif, atau data pelanggan berlebihan.
7. **Backup:** aktifkan version history dan ekspor backup terjadwal spreadsheet.
8. **Kuota:** pantau Cloudflare Workers requests, KV reads/writes, Google Sheets API quotas, dan batas messaging provider.
9. **Skala tinggi:** pindahkan write path ke Queue + D1/DB transaksional, lalu sinkronkan agregat ke Sheets secara batch. Google Sheets sebaiknya menjadi reporting layer, bukan satu-satunya ledger untuk lonjakan traffic.
10. **Latensi:** tidak ada cara menjamin sub-15 ms end-to-end saat request memerlukan Google OAuth/Sheets. Worker mengakui webhook secepat mungkin dan memproses pekerjaan sesudah respons.

## 12. Troubleshooting

| Gejala | Periksa |
|---|---|
| Google OAuth 400 | JSON key valid, private key utuh, service account aktif |
| Google Sheets 403 | Sheets API aktif dan spreadsheet dibagikan ke service account |
| Google Sheets 404 | Spreadsheet ID dan nama tab benar |
| Produk tidak ditemukan | SKU katalog sama persis, kolom A terisi |
| Telegram webhook 401 | Secret header Telegram sama dengan `TELEGRAM_WEBHOOK_SECRET` |
| WhatsApp verify gagal | Verify Token harus identik dan method GET harus diteruskan |
| Laporan kosong | Status transaksi harus `DIBAYAR`/`SELESAI`/`PAID`/`COMPLETED` |
| Formula error | Periksa locale spreadsheet dan pemisah formula |

## 13. Pre-production checklist

- [ ] Hak akses spreadsheet hanya untuk pemilik/admin dan service account.
- [ ] Service account JSON tidak berada di Git.
- [ ] Semua secret disimpan di Cloudflare Secrets.
- [ ] Validasi signature WhatsApp POST sudah diterapkan.
- [ ] Callback pembayaran sudah diverifikasi secara kriptografis jika digunakan.
- [ ] Rate limiting, logging, dan alert sudah dikonfigurasi.
- [ ] Stok dan idempotensi sudah ditangani dengan penyimpanan transaksional jika diperlukan.
- [ ] Backup dan prosedur pemulihan sudah diuji.
- [ ] Pesanan uji sudah dihapus/ditandai dengan jelas.
- [ ] Kuota aktual provider sudah diperiksa sebelum kampanye traffic besar.

---

**Powered by Seiton.id**  
https://seiton.biz.id