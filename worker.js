import {
  bootstrapTransactions, createOrderTransactional, transactionReadiness,
  findOrderTransactional, findOrderByLegacyRow, listOrdersTransactional,
  listProductsTransactional, findProductTransactional, saveProductTransactional,
  deleteProductTransactional, setLegacyRowTransactional, updateProofTransactional,
  requestVerificationTransactional, approvePaymentTransactional, rejectPaymentTransactional,
  setOrderStatusTransactional, markPickedUpTransactional, listDashboardDataTransactional,
  orderToSheetRow
} from "./transaction-layer.js";
/**
 * ============================================================================
 * SEITON.ID - HIGH-PERFORMANCE BOT & INTERACTIVE DASHBOARD ENGINE
 * Stack: Cloudflare Workers + Google Sheets API + Telegram Webhook
 * Official Web : https://seiton.biz.id
 * Copyright (c) 2026 Seiton.id. All rights reserved.
 * ============================================================================
 *
 * LICENSE NOTICE
 * This source is proprietary to Seiton.id. All rights reserved.
 * No redistribution, resale, sublicensing, public reposting, or removal of
 * attribution without prior written permission from Seiton.id.
 *
 * Runtime: Cloudflare Workers ES Modules. No third-party runtime dependency.
 * Data contract:
 *   Pesanan: order_id, created_at, channel, customer_id, customer_name,
 *            product, quantity, unit_price, subtotal, shipping, total,
 *            payment_method, status
 *   Katalog_Produk: sku, nama_produk, harga, stok, aktif
 *
 * Important: Google Sheets is an external API, not a transactional database.
 * For production concurrency/idempotency, bind ORDERS_KV (Cloudflare KV) and
 * enable it in wrangler. A KV put is not a distributed lock; very high-volume
 * checkout should move order creation to a Queue + durable transactional store.
 */

const ADMIN_DASHBOARD_HTML = "<!doctype html>\n<html lang=\"id\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"robots\" content=\"noindex,nofollow\"><meta name=\"referrer\" content=\"no-referrer\">\n<title>Seiton.id · Admin Workspace</title>\n<script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.min.js\" crossorigin=\"anonymous\"></script>\n<style>\n:root{color-scheme:light;--bg:#f4f6fa;--surface:#fff;--ink:#172033;--muted:#69758a;--line:#e7ebf1;--nav:#101a2b;--nav2:#1a2940;--accent:#e87935;--accent2:#f59b57;--green:#16845b;--greenbg:#e8f6ef;--amber:#a86409;--amberbg:#fff5df;--red:#b83242;--redbg:#fff0f1;--blue:#2864b4;--bluebg:#edf4ff;--shadow:0 12px 32px rgba(25,38,60,.07)}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}.hidden{display:none!important}\n.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 15%,#263c5c 0,transparent 35%),linear-gradient(145deg,#101a2b,#1a2c46)}\n.login-card{width:min(420px,100%);background:#fff;border-radius:22px;padding:32px;box-shadow:0 24px 90px #0005}.brand-mark{display:flex;align-items:center;gap:12px;font-weight:800;font-size:19px}.brand-symbol{width:42px;height:42px;border-radius:13px;background:var(--accent);display:grid;place-items:center;color:#fff;font-size:20px}.login-card h1{font-size:24px;margin:28px 0 8px}.login-card p{color:var(--muted);line-height:1.6;margin:0 0 22px}.field{display:grid;gap:7px;margin-bottom:15px}.field label{font-size:12px;font-weight:700;color:#49566c}.field input,.field select,.field textarea,.toolbar input,.toolbar select{width:100%;border:1px solid #dce2eb;background:#fff;padding:11px 12px;border-radius:10px;color:var(--ink);outline:none}.field input:focus,.field select:focus,.field textarea:focus,.toolbar input:focus,.toolbar select:focus{border-color:#8faed7;box-shadow:0 0 0 3px #2864b41a}.btn{border:0;border-radius:10px;padding:10px 14px;font-weight:700;background:#edf1f6;color:#31405a}.btn:hover{filter:brightness(.97)}.btn-primary{background:var(--accent);color:#fff}.btn-dark{background:#1a2940;color:#fff}.btn-soft{background:var(--bluebg);color:var(--blue)}.btn-danger{background:var(--redbg);color:var(--red)}.btn-small{padding:7px 10px;font-size:12px}.btn-block{width:100%;padding:12px}.login-error{min-height:20px;color:var(--red);font-size:12px;margin-top:10px}\n.app{min-height:100vh;display:grid;grid-template-columns:250px minmax(0,1fr)}.sidebar{background:var(--nav);color:#e9eff8;padding:22px 16px;display:flex;flex-direction:column;min-height:100vh;position:sticky;top:0;height:100vh}.side-brand{display:flex;align-items:center;gap:11px;padding:5px 10px 25px;border-bottom:1px solid #ffffff19}.side-brand .brand-symbol{width:38px;height:38px}.side-brand strong{display:block;font-size:16px}.side-brand small{display:block;color:#9eacc0;font-size:10px;letter-spacing:.13em;margin-top:3px}.nav-label{padding:24px 10px 9px;color:#8797ae;font-size:10px;letter-spacing:.14em;font-weight:800}.side-nav{display:grid;gap:5px}.side-nav button{border:0;background:transparent;color:#b9c5d5;text-align:left;padding:11px 12px;border-radius:10px;display:flex;align-items:center;gap:12px;font-weight:600}.side-nav button:hover{background:#ffffff0d;color:#fff}.side-nav button.active{background:#253751;color:#fff;box-shadow:inset 3px 0 var(--accent)}.nav-icon{width:20px;text-align:center;font-size:16px}.side-bottom{margin-top:auto;border-top:1px solid #ffffff19;padding:16px 8px 0;color:#9eacc0;font-size:11px;line-height:1.6}.side-bottom a{color:#fff;text-decoration:none}\n.main{min-width:0}.topbar{height:76px;background:#ffffffeb;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 30px;position:sticky;top:0;z-index:10;backdrop-filter:blur(12px)}.topbar-left{display:flex;align-items:center;gap:12px}.menu-toggle{display:none}.eyebrow{font-size:10px;letter-spacing:.13em;color:var(--muted);font-weight:800}.topbar h1{font-size:20px;margin:2px 0 0}.top-actions{display:flex;align-items:center;gap:13px}.live-dot{display:inline-flex;align-items:center;gap:7px;color:var(--green);font-size:11px;font-weight:800}.live-dot:before{content:\"\";width:7px;height:7px;border-radius:50%;background:#20a36e;box-shadow:0 0 0 4px #20a36e20}.avatar{width:34px;height:34px;border-radius:50%;background:#fbe7d9;color:#a34b19;display:grid;place-items:center;font-weight:800}\n.content{padding:28px 30px 40px;max-width:1600px;margin:0 auto}.welcome{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px}.welcome h2{font-size:24px;letter-spacing:-.04em;margin:0 0 5px}.welcome p{margin:0;color:var(--muted)}.welcome-actions{display:flex;gap:8px;flex-wrap:wrap}\n.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}.metric{background:var(--surface);border:1px solid var(--line);border-radius:15px;padding:17px 18px;box-shadow:var(--shadow);min-width:0}.metric-top{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:12px;font-weight:700}.metric-icon{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:#fff1e7;color:#ba5e22;font-size:16px}.metric-value{font-size:26px;font-weight:800;letter-spacing:-.04em;margin:13px 0 4px}.metric-note{font-size:11px;color:var(--muted)}\n.grid{display:grid;gap:16px}.grid-main{grid-template-columns:minmax(0,1.65fr) minmax(280px,1fr);margin-bottom:18px}.grid-equal{grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:18px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:15px;padding:18px;box-shadow:var(--shadow);min-width:0}.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.panel-head h3{margin:0;font-size:14px}.panel-sub{font-size:11px;color:var(--muted);margin-top:4px}.chart-box{height:270px;position:relative}.status-list{display:grid;gap:12px}.status-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}.status-row .label{font-size:12px;color:var(--muted)}.status-row strong{font-size:12px}.status-track{grid-column:1/-1;height:7px;border-radius:20px;background:#eff2f6;overflow:hidden}.status-fill{height:100%;border-radius:20px;background:var(--accent)}\n.toolbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:0 0 14px}.toolbar input{max-width:320px}.toolbar select{width:auto;min-width:150px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:12px 12px;border-bottom:1px solid #edf0f4;vertical-align:middle;font-size:12px}th{background:#f8fafc;color:#758197;font-size:10px;letter-spacing:.06em;text-transform:uppercase;position:sticky;top:0}tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfcfe}.right{text-align:right}.muted{color:var(--muted)}.mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace}.status{display:inline-flex;padding:5px 8px;border-radius:99px;font-size:10px;font-weight:800;white-space:nowrap;background:#eef2f6;color:#586477}.status.paid{background:var(--greenbg);color:var(--green)}.status.pending{background:var(--amberbg);color:var(--amber)}.status.cancelled{background:var(--redbg);color:var(--red)}.status.info{background:var(--bluebg);color:var(--blue)}\n.product-cell{display:flex;align-items:center;gap:10px;min-width:190px}.product-cell img{width:38px;height:38px;border-radius:9px;object-fit:cover;background:#f2f4f7}.product-cell strong{display:block;font-size:12px}.product-cell small{color:var(--muted);font-size:10px}.pay-card{border:1px solid var(--line);border-radius:13px;padding:14px;display:grid;gap:10px;margin-bottom:10px}.pay-top{display:flex;justify-content:space-between;gap:12px}.pay-title{font-weight:800}.pay-meta{font-size:11px;color:var(--muted);line-height:1.65}.pay-actions{display:flex;gap:7px;flex-wrap:wrap}.empty{padding:32px 14px;text-align:center;color:var(--muted);font-size:12px}.empty strong{display:block;color:var(--ink);font-size:14px;margin-bottom:5px}\n.report-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}.report-card{border:1px solid var(--line);border-radius:13px;padding:17px}.report-card .report-icon{font-size:22px}.report-card h4{margin:12px 0 5px}.report-card p{margin:0 0 14px;color:var(--muted);font-size:11px;line-height:1.5}\n.modal-backdrop{position:fixed;inset:0;background:#101a2b88;display:grid;place-items:center;padding:20px;z-index:40}.modal{background:white;border-radius:17px;padding:22px;width:min(580px,100%);max-height:92vh;overflow:auto;box-shadow:0 24px 90px #0004}.modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.modal-head h3{margin:0}.modal-close{border:0;background:#f1f3f6;border-radius:8px;width:32px;height:32px;font-size:18px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.span-2{grid-column:span 2}.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}.proof-preview{max-width:100%;max-height:65vh;object-fit:contain;border-radius:10px;background:#f6f8fb}.toast{position:fixed;bottom:22px;right:22px;background:#17263c;color:#fff;padding:12px 16px;border-radius:11px;box-shadow:var(--shadow);z-index:60;font-size:12px;max-width:min(420px,calc(100vw - 44px))}.toast.error{background:#8f2635}\n.footer-note{font-size:10px;color:var(--muted);margin-top:18px}\n@media(max-width:1100px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.report-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-main{grid-template-columns:1fr}.chart-box{height:240px}}\n@media(max-width:760px){.app{grid-template-columns:1fr}.sidebar{position:fixed;left:-270px;top:0;width:250px;z-index:30;transition:left .2s}.sidebar.open{left:0}.menu-toggle{display:inline-grid;border:0;background:#f1f3f6;border-radius:9px;width:36px;height:36px;place-items:center}.topbar{padding:0 15px;height:66px}.content{padding:20px 14px 32px}.topbar h1{font-size:17px}.top-actions .live-dot{display:none}.welcome{align-items:flex-start;flex-direction:column}.welcome h2{font-size:21px}.metrics{gap:9px}.metric{padding:13px}.metric-value{font-size:21px}.grid-equal{grid-template-columns:1fr}.report-grid{grid-template-columns:1fr 1fr}.toolbar input{max-width:100%;flex:1 1 100%}.form-grid{grid-template-columns:1fr}.span-2{grid-column:auto}}\n@media(max-width:420px){.report-grid{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.metric-value{font-size:18px}.top-actions .btn{padding:8px 9px;font-size:11px}}\n</style>\n</head>\n<body>\n<section id=\"loginView\" class=\"login-wrap\">\n <form id=\"loginForm\" class=\"login-card\">\n  <div class=\"brand-mark\"><span class=\"brand-symbol\">S</span><span>Seiton.id<br><small style=\"color:#8b95a7;font-size:10px;letter-spacing:.12em\">ADMIN WORKSPACE</small></span></div>\n  <h1>Masuk ke panel admin</h1><p>Kelola pesanan, verifikasi pembayaran, katalog produk, dan laporan bisnis Seiton.id.</p>\n  <div class=\"field\"><label for=\"adminPassword\">Password admin</label><input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" placeholder=\"Masukkan password admin\" required></div>\n  <button id=\"loginButton\" class=\"btn btn-primary btn-block\" type=\"submit\">Masuk ke Dashboard</button>\n  <div id=\"loginError\" class=\"login-error\" role=\"alert\"></div>\n  <p style=\"font-size:10px;margin:18px 0 0\">Akses terbatas untuk pengelola Seiton.id · <a href=\"https://seiton.biz.id\" style=\"color:#a34b19\">Kembali ke situs utama</a></p>\n </form>\n</section>\n<div id=\"appView\" class=\"app hidden\">\n <aside id=\"sidebar\" class=\"sidebar\">\n  <div class=\"side-brand\"><span class=\"brand-symbol\">S</span><div><strong>Seiton.id</strong><small>ADMIN WORKSPACE</small></div></div>\n  <div class=\"nav-label\">WORKSPACE</div>\n  <nav class=\"side-nav\">\n   <button data-page=\"overview\" class=\"active\"><span class=\"nav-icon\">▦</span> Ringkasan</button>\n   <button data-page=\"orders\"><span class=\"nav-icon\">▤</span> Pesanan</button>\n   <button data-page=\"payments\"><span class=\"nav-icon\">◉</span> Verifikasi Pembayaran <span id=\"pendingBadge\" class=\"status pending\" style=\"margin-left:auto\">0</span></button>\n   <button data-page=\"products\"><span class=\"nav-icon\">▣</span> Produk & Katalog</button>\n   <button data-page=\"reports\"><span class=\"nav-icon\">▥</span> Laporan</button>\n  </nav>\n  <div class=\"nav-label\">SITUS</div>\n  <nav class=\"side-nav\"><button id=\"openSite\"><span class=\"nav-icon\">↗</span> Website Seiton.id</button></nav>\n  <div class=\"side-bottom\">Data tersimpan di Google Sheets.<br>Sinkronisasi otomatis tiap 30 detik.<br><a href=\"https://seiton.biz.id\">seiton.biz.id ↗</a></div>\n </aside>\n <main class=\"main\">\n  <header class=\"topbar\">\n   <div class=\"topbar-left\"><button id=\"menuToggle\" class=\"menu-toggle\" aria-label=\"Buka menu\">☰</button><div><div class=\"eyebrow\">SEITON.ID / ADMIN</div><h1 id=\"pageTitle\">Ringkasan</h1></div></div>\n   <div class=\"top-actions\"><span class=\"live-dot\">LIVE DATA</span><span id=\"lastUpdated\" class=\"muted\" style=\"font-size:11px\">Menghubungkan…</span><span class=\"avatar\">A</span><button id=\"logoutButton\" class=\"btn btn-small\">Keluar</button></div>\n  </header>\n  <section class=\"content\">\n   <div id=\"page-overview\" class=\"page\">\n    <div class=\"welcome\"><div><h2>Selamat datang kembali 👋</h2><p>Berikut gambaran operasional toko saat ini.</p></div><div class=\"welcome-actions\"><select id=\"period\" class=\"btn\"><option value=\"7\">7 hari terakhir</option><option value=\"30\" selected>30 hari terakhir</option><option value=\"90\">90 hari terakhir</option><option value=\"365\">12 bulan</option><option value=\"all\">Semua data</option></select><button class=\"btn btn-dark\" id=\"refreshButton\">↻ Perbarui</button></div></div>\n    <div class=\"metrics\">\n     <article class=\"metric\"><div class=\"metric-top\">Omzet terverifikasi <span class=\"metric-icon\">↗</span></div><div id=\"metricRevenue\" class=\"metric-value\">—</div><div class=\"metric-note\">Pembayaran yang telah disetujui</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Total pesanan <span class=\"metric-icon\">▤</span></div><div id=\"metricOrders\" class=\"metric-value\">—</div><div class=\"metric-note\">Sesuai periode yang dipilih</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Menunggu verifikasi <span class=\"metric-icon\">◷</span></div><div id=\"metricVerification\" class=\"metric-value\">—</div><div class=\"metric-note\">Butuh pemeriksaan admin</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Produk aktif <span class=\"metric-icon\">▣</span></div><div id=\"metricProducts\" class=\"metric-value\">—</div><div class=\"metric-note\" id=\"metricStock\">—</div></article>\n    </div>\n    <div class=\"grid grid-main\">\n     <article class=\"panel\"><div class=\"panel-head\"><div><h3>Tren penerimaan</h3><div class=\"panel-sub\">Nilai transaksi yang sudah diverifikasi per hari</div></div><span class=\"status paid\">TERKONFIRMASI</span></div><div class=\"chart-box\"><canvas id=\"revenueChart\"></canvas></div></article>\n     <article class=\"panel\"><div class=\"panel-head\"><div><h3>Status pesanan</h3><div class=\"panel-sub\">Distribusi pesanan pada periode terpilih</div></div></div><div class=\"chart-box\"><canvas id=\"statusChart\"></canvas></div></article>\n    </div>\n    <div class=\"grid grid-equal\">\n     <article class=\"panel\"><div class=\"panel-head\"><div><h3>Produk terlaris</h3><div class=\"panel-sub\">Berdasarkan unit dari pesanan terbayar</div></div></div><div class=\"chart-box\"><canvas id=\"productChart\"></canvas></div></article>\n     <article class=\"panel\"><div class=\"panel-head\"><div><h3>Pesanan terbaru</h3><button class=\"btn btn-small btn-soft\" data-go=\"orders\">Lihat semua ↗</button></div></div><div id=\"recentOrders\"></div></article>\n    </div>\n   </div>\n   <div id=\"page-orders\" class=\"page hidden\">\n    <div class=\"welcome\"><div><h2>Manajemen pesanan</h2><p>Telusuri transaksi dan perbarui status operasional.</p></div><button class=\"btn btn-soft\" data-export=\"orders\">⬇ Ekspor pesanan</button></div>\n    <div class=\"panel\"><div class=\"toolbar\"><input id=\"orderSearch\" placeholder=\"Cari ID, nama pelanggan, atau produk…\"><select id=\"orderStatus\"><option value=\"\">Semua status</option><option>MENUNGGU_PEMBAYARAN</option><option>MENUNGGU_VERIFIKASI</option><option>DIBAYAR</option><option>DIPROSES</option><option>DIKIRIM</option><option>SELESAI</option><option>DIBATALKAN</option></select></div><div id=\"ordersTable\"></div></div>\n   </div>\n   <div id=\"page-payments\" class=\"page hidden\">\n    <div class=\"welcome\"><div><h2>Verifikasi pembayaran</h2><p>Periksa bukti transfer/QRIS sebelum menerbitkan resi pengambilan.</p></div><button class=\"btn btn-soft\" id=\"refreshPayments\">↻ Muat ulang</button></div>\n    <div class=\"metrics\" style=\"grid-template-columns:repeat(3,minmax(0,1fr))\">\n     <article class=\"metric\"><div class=\"metric-top\">Menunggu pemeriksaan</div><div id=\"payPending\" class=\"metric-value\">—</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Bukti terlampir</div><div id=\"payProof\" class=\"metric-value\">—</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Belum ada bukti</div><div id=\"payNoProof\" class=\"metric-value\">—</div></article>\n    </div>\n    <div id=\"paymentQueue\" class=\"panel\"></div>\n   </div>\n   <div id=\"page-products\" class=\"page hidden\">\n    <div class=\"welcome\"><div><h2>Produk & katalog</h2><p>Atur informasi, stok, harga, deskripsi, serta foto produk.</p></div><button id=\"addProductButton\" class=\"btn btn-primary\">＋ Tambah produk</button></div>\n    <div class=\"panel\"><div class=\"toolbar\"><input id=\"productSearch\" placeholder=\"Cari SKU atau nama produk…\"><select id=\"productFilter\"><option value=\"\">Semua produk</option><option value=\"active\">Aktif</option><option value=\"inactive\">Nonaktif</option><option value=\"low\">Stok rendah (≤ 5)</option></select></div><div id=\"productsTable\"></div></div>\n   </div>\n   <div id=\"page-reports\" class=\"page hidden\">\n    <div class=\"welcome\"><div><h2>Laporan bisnis</h2><p>Unduh file terbaru yang dibuat langsung dari Google Sheets.</p></div></div>\n    <div class=\"report-grid\">\n     <article class=\"report-card\"><div class=\"report-icon\">📋</div><h4>Data Pesanan</h4><p>Rincian order, pelanggan, produk, nilai transaksi, dan status.</p><button class=\"btn btn-soft btn-block\" data-export=\"orders\">Unduh CSV</button></article>\n     <article class=\"report-card\"><div class=\"report-icon\">💰</div><h4>Buku Keuangan</h4><p>Tagihan, pembayaran terverifikasi, dan saldo belum tertagih.</p><button class=\"btn btn-soft btn-block\" data-export=\"finance\">Unduh CSV</button></article>\n     <article class=\"report-card\"><div class=\"report-icon\">📅</div><h4>Ringkasan Harian</h4><p>Jumlah pesanan, transaksi dibayar, dan penerimaan per hari.</p><button class=\"btn btn-soft btn-block\" data-export=\"daily\">Unduh CSV</button></article>\n     <article class=\"report-card\"><div class=\"report-icon\">📦</div><h4>Stok & Katalog</h4><p>Harga jual, stok, nilai stok, status aktif, dan foto.</p><button class=\"btn btn-soft btn-block\" data-export=\"inventory\">Unduh CSV</button></article>\n    </div>\n    <div class=\"panel\" style=\"margin-top:15px\"><div class=\"panel-head\"><div><h3>Paket laporan lengkap</h3><div class=\"panel-sub\">Keempat laporan dikirim satu per satu sebagai file CSV.</div></div><button class=\"btn btn-primary\" data-export=\"all\">⬇ Unduh semua laporan</button></div><p class=\"footer-note\">Laba bersih tidak ditampilkan karena harga pokok/modal produk belum tercatat.</p></div>\n   </div>\n   <p class=\"footer-note\">Seiton.id Admin Workspace · Data diperbarui otomatis setiap 30 detik · Sumber data: Google Sheets</p>\n  </section>\n </main>\n</div>\n<div id=\"modalBackdrop\" class=\"modal-backdrop hidden\"><div id=\"modal\" class=\"modal\" role=\"dialog\" aria-modal=\"true\"></div></div>\n<div id=\"toast\" class=\"toast hidden\" role=\"status\"></div>\n<script>\n(function(){\n const $=id=>document.getElementById(id);\n const money=n=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(n)||0);\n const num=n=>new Intl.NumberFormat('id-ID').format(Number(n)||0);\n const esc=s=>String(s==null?'':s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});\n const paid=['DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED'];\n const cancelled=['DIBATALKAN','CANCELLED','CANCELED'];\n const names={overview:'Ringkasan',orders:'Pesanan',payments:'Verifikasi Pembayaran',products:'Produk & Katalog',reports:'Laporan'};\n let token=sessionStorage.getItem('seitonAdminAccess')||'';\n const hash=new URLSearchParams((location.hash||'').replace(/^#/,''));\n const deep=hash.get('access');\n if(deep){token=deep;sessionStorage.setItem('seitonAdminAccess',token);history.replaceState({},'',location.pathname+location.search);}\n let data=null,charts={},toastTimer=null,refreshInFlight=false;\n async function api(path,options){\n  options=options||{};const headers=Object.assign({},options.headers||{});\n  if(token)headers.Authorization='Bearer '+token;\n  if(options.body && !(options.body instanceof FormData))headers['Content-Type']='application/json';\n  const res=await fetch(path,Object.assign({},options,{headers:headers,cache:'no-store'}));\n  if(res.status===401){logout(false);throw new Error('Sesi berakhir. Silakan login kembali.');}\n  const ct=res.headers.get('content-type')||'';\n  const body=ct.includes('application/json')?await res.json():res;\n  if(!res.ok)throw new Error(body.error||'Permintaan gagal ('+res.status+').');\n  return body;\n }\n function toast(message,error){$('toast').textContent=message;$('toast').classList.toggle('error',!!error);$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),3600);}\n function showLogin(){ $('loginView').classList.remove('hidden');$('appView').classList.add('hidden'); }\n function showApp(){ $('loginView').classList.add('hidden');$('appView').classList.remove('hidden'); }\n async function login(event){\n  event.preventDefault();const btn=$('loginButton');btn.disabled=true;btn.textContent='Memeriksa…';$('loginError').textContent='';\n  try{const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('adminPassword').value})});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Login gagal.');token=j.token;sessionStorage.setItem('seitonAdminAccess',token);$('adminPassword').value='';showApp();await refresh();}\n  catch(e){$('loginError').textContent=e.message;}\n  finally{btn.disabled=false;btn.textContent='Masuk ke Dashboard';}\n }\n function logout(show){token='';sessionStorage.removeItem('seitonAdminAccess');Object.values(charts).forEach(c=>c.destroy());charts={};showLogin();if(show)toast('Anda telah keluar.');}\n function setPage(page){\n  if(!names[page])return;\n  document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden'));\n  $('page-'+page).classList.remove('hidden');\n  document.querySelectorAll('.side-nav button[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));\n  $('pageTitle').textContent=names[page];$('sidebar').classList.remove('open');\n  renderCurrent();\n }\n function periodOrders(){\n  const list=data.orders||[],p=$('period').value;\n  if(p==='all')return list;\n  const cutoff=Date.now()-Number(p)*86400000;\n  return list.filter(o=>{const d=new Date(o.created_at).getTime();return Number.isFinite(d)&&d>=cutoff;});\n }\n function fmtDate(s){const d=new Date(s);return Number.isNaN(d.getTime())?'-':d.toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});}\n function statusClass(s){s=String(s||'').toUpperCase();return paid.includes(s)?'paid':cancelled.includes(s)?'cancelled':s==='MENUNGGU_VERIFIKASI'?'info':'pending';}\n function badge(s){return '<span class=\"status '+statusClass(s)+'\">'+esc(s||'TANPA STATUS')+'</span>';}\n function killChart(id){if(charts[id]){charts[id].destroy();delete charts[id];}}\n function renderOverview(){\n  if(!data)return;const orders=periodOrders(),products=data.products||[],confirmed=orders.filter(o=>paid.includes(o.status));\n  const pending=orders.filter(o=>o.payment_confirmation_status==='MENUNGGU_VERIFIKASI');\n  const revenue=confirmed.reduce((a,o)=>a+o.total,0),active=products.filter(p=>p.active);\n  $('metricRevenue').textContent=money(revenue);$('metricOrders').textContent=num(orders.length);$('metricVerification').textContent=num(pending.length);$('metricProducts').textContent=num(active.length);$('metricStock').textContent=num(active.reduce((a,p)=>a+Math.max(0,p.stock||0),0))+' unit stok aktif';\n  $('pendingBadge').textContent=num((data.orders||[]).filter(o=>o.payment_confirmation_status==='MENUNGGU_VERIFIKASI').length);\n  if(typeof Chart!==\"function\"){\n   const recent=[...(data.orders||[])].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,6);\n   $('recentOrders').innerHTML=recent.length?tableOrders(recent,false):'<div class=\"empty\"><strong>Belum ada pesanan</strong>Pesanan baru akan muncul di sini.</div>';\n   return;\n  }\n  const dayKey=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'Tidak diketahui':new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);};\n  const daily={};confirmed.forEach(o=>{const k=dayKey(o.created_at);daily[k]=(daily[k]||0)+o.total;});\n  const labels=Object.keys(daily).sort();killChart('revenueChart');\n  charts.revenueChart=new Chart($('revenueChart'),{type:'line',data:{labels:labels,datasets:[{label:'Penerimaan',data:labels.map(k=>daily[k]),borderColor:'#e87935',backgroundColor:'#e8793520',fill:true,tension:.35,pointRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>money(c.raw)}}},scales:{x:{grid:{display:false},ticks:{color:'#778298',maxTicksLimit:8}},y:{grid:{color:'#edf0f4'},ticks:{color:'#778298',callback:v=>new Intl.NumberFormat('id-ID',{notation:'compact'}).format(v)}}}}});\n  const map={};orders.forEach(o=>{const s=o.status||'TANPA STATUS';map[s]=(map[s]||0)+1;});killChart('statusChart');\n  charts.statusChart=new Chart($('statusChart'),{type:'doughnut',data:{labels:Object.keys(map),datasets:[{data:Object.values(map),backgroundColor:['#16845b','#e87935','#4d83c6','#d2a03e','#8995a7','#c45a66','#7e67b2'],borderWidth:3,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,cutout:'66%',plugins:{legend:{position:'bottom',labels:{usePointStyle:true,boxWidth:7,color:'#66748a',font:{size:10}}}}}});\n  const top={};confirmed.forEach(o=>{const n=String(o.product||'').split(' - ').slice(1).join(' - ')||o.product;top[n]=(top[n]||0)+o.quantity;});const best=Object.entries(top).sort((a,b)=>b[1]-a[1]).slice(0,6);killChart('productChart');\n  charts.productChart=new Chart($('productChart'),{type:'bar',data:{labels:best.map(x=>x[0]),datasets:[{label:'Unit terjual',data:best.map(x=>x[1]),backgroundColor:'#83b59b',borderRadius:6}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:'#edf0f4'},ticks:{color:'#778298'}},y:{grid:{display:false},ticks:{color:'#56647a'}}}}});\n  const recent=[...(data.orders||[])].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,6);\n  $('recentOrders').innerHTML=recent.length?tableOrders(recent,false):'<div class=\"empty\"><strong>Belum ada pesanan</strong>Pesanan baru akan muncul di sini.</div>';\n }\n function tableOrders(rows,actions){\n  if(!rows.length)return '<div class=\"empty\"><strong>Tidak ada hasil</strong>Coba ubah pencarian atau filter.</div>';\n  return '<div class=\"table-wrap\"><table><thead><tr><th>Pesanan</th><th>Pelanggan</th><th>Total</th><th>Status</th>'+(actions?'<th>Aksi</th>':'')+'</tr></thead><tbody>'+rows.map(o=>'<tr><td><strong class=\"mono\">'+esc(o.order_id)+'</strong><div class=\"muted\" style=\"font-size:10px;margin-top:4px\">'+esc(fmtDate(o.created_at))+'</div></td><td>'+esc(o.customer_name)+'<div class=\"muted\" style=\"font-size:10px;margin-top:4px\">'+esc(o.product)+'</div></td><td class=\"mono\">'+money(o.total)+'</td><td>'+badge(o.status)+'</td>'+(actions?'<td><button class=\"btn btn-small btn-soft\" data-order-status=\"'+esc(o.order_id)+'\">Ubah status</button></td>':'')+'</tr>').join('')+'</tbody></table></div>';\n }\n function renderOrders(){\n  if(!data)return;const q=($('orderSearch').value||'').toLowerCase(),status=$('orderStatus').value;\n  const rows=[...(data.orders||[])].filter(o=>(!status||o.status===status)&&[o.order_id,o.customer_name,o.product,o.customer_id].join(' ').toLowerCase().includes(q)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));\n  $('ordersTable').innerHTML=tableOrders(rows,true);\n }\n function renderPayments(){\n  if(!data)return;const rows=(data.orders||[]).filter(o=>o.payment_confirmation_status==='MENUNGGU_VERIFIKASI').sort((a,b)=>new Date(b.payment_requested_at||b.created_at)-new Date(a.payment_requested_at||a.created_at));\n  $('payPending').textContent=num(rows.length);$('payProof').textContent=num(rows.filter(o=>o.payment_proof_file_id).length);$('payNoProof').textContent=num(rows.filter(o=>!o.payment_proof_file_id).length);\n  $('paymentQueue').innerHTML=rows.length?rows.map(o=>'<article class=\"pay-card\"><div class=\"pay-top\"><div><div class=\"pay-title\">'+esc(o.customer_name)+' · '+esc(o.order_id)+'</div><div class=\"pay-meta\">'+esc(o.product)+' · '+num(o.quantity)+' pcs<br>'+esc(o.payment_method)+' · Diminta '+esc(fmtDate(o.payment_requested_at||o.created_at))+'</div></div><div style=\"text-align:right\"><strong>'+money(o.total)+'</strong><div style=\"margin-top:7px\">'+(o.payment_proof_file_id?'<span class=\"status info\">BUKTI TERLAMPIR</span>':'<span class=\"status pending\">TANPA BUKTI</span>')+'</div></div></div><div class=\"pay-actions\">'+(o.payment_proof_file_id?'<button class=\"btn btn-small btn-soft\" data-proof=\"'+esc(o.order_id)+'\">Lihat bukti</button>':'')+'<button class=\"btn btn-small btn-primary\" data-pay-approve=\"'+esc(o.order_id)+'\">Setujui pembayaran</button><button class=\"btn btn-small btn-danger\" data-pay-reject=\"'+esc(o.order_id)+'\">Tolak / minta ulang</button></div></article>').join(''):'<div class=\"empty\"><strong>Semua pembayaran sudah ditangani</strong>Belum ada permintaan verifikasi yang menunggu.</div>';\n }\n function renderProducts(){\n  if(!data)return;const q=($('productSearch').value||'').toLowerCase(),f=$('productFilter').value;\n  const rows=(data.products||[]).filter(p=>[p.sku,p.name,p.description].join(' ').toLowerCase().includes(q))\n   .filter(p=>!f||(f==='active'&&p.active)||(f==='inactive'&&!p.active)||(f==='low'&&p.active&&p.stock_valid&&p.stock!=null&&p.stock<=5));\n  $('productsTable').innerHTML=rows.length?'<div class=\"table-wrap\"><table><thead><tr><th>Produk</th><th>Harga</th><th>Stok</th><th>Status</th><th>Aksi</th></tr></thead><tbody>'+rows.map(p=>'<tr><td><div class=\"product-cell\">'+(p.photo_url?'<img src=\"'+esc(p.photo_url)+'\" alt=\"\">':'<div class=\"metric-icon\">▣</div>')+'<div><strong>'+esc(p.name)+'</strong><small>'+esc(p.sku)+'</small></div></div></td><td class=\"mono\">'+(p.price_valid===false?'<span class=\"status cancelled\">Harga invalid</span>':money(p.price))+'</td><td>'+(p.stock_valid===false?'<span class=\"status cancelled\">Stok invalid</span>':(p.stock==null?'Tidak dibatasi':num(p.stock)))+'</td><td>'+(p.active?'<span class=\"status paid\">AKTIF</span>':'<span class=\"status cancelled\">NONAKTIF / PERLU PERBAIKAN</span>')+'</td><td><button class=\"btn btn-small btn-soft\" data-product-edit=\"'+esc(p.sku)+'\">Atur</button> <button class=\"btn btn-small btn-danger\" data-product-delete=\"'+esc(p.sku)+'\">Hapus</button></td></tr>').join('')+'</tbody></table></div>':'<div class=\"empty\"><strong>Produk tidak ditemukan</strong>Tambahkan produk baru atau ubah filter.</div>';\n }\n function renderCurrent(){\n  const page=document.querySelector('.page:not(.hidden)')?.id.replace('page-','');\n  if(page==='overview')renderOverview();if(page==='orders')renderOrders();if(page==='payments')renderPayments();if(page==='products')renderProducts();\n }\n async function refresh(){\n  if(refreshInFlight || !token)return;\n  refreshInFlight=true;\n  try{const r=await api('/api/admin/data');if(!r.ok)throw new Error(r.error||'Tidak dapat memuat data');data=r;$('lastUpdated').textContent='Diperbarui '+new Date(r.generated_at).toLocaleTimeString('id-ID');renderCurrent();$('pendingBadge').textContent=num((data.orders||[]).filter(o=>o.payment_confirmation_status==='MENUNGGU_VERIFIKASI').length);}\n  catch(e){toast(e.message,true);}\n  finally{refreshInFlight=false;}\n }\n async function exportReport(type){\n  try{const r=await fetch('/api/admin/export?type='+encodeURIComponent(type),{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(r.status===401){logout(false);throw new Error('Sesi login berakhir.');}if(!r.ok){const j=await r.json();throw new Error(j.error||'Export gagal.');}const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Seiton_'+type+'.csv';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('File laporan berhasil disiapkan.');}\n  catch(e){toast(e.message,true);}\n }\n function openModal(title,body){\n  $('modal').innerHTML='<div class=\"modal-head\"><h3>'+title+'</h3><button class=\"modal-close\" id=\"modalClose\">×</button></div>'+body;\n  $('modalBackdrop').classList.remove('hidden');$('modalClose').onclick=closeModal;\n }\n function closeModal(){$('modalBackdrop').classList.add('hidden');$('modal').innerHTML='';}\n function productForm(p){\n  p=p||{};const active=p.active!==false;\n  openModal(p.sku?'Atur Produk':'Tambah Produk','<form id=\"productForm\"><input type=\"hidden\" name=\"original_sku\" value=\"'+esc(p.sku||'')+'\"><div class=\"form-grid\">'+\n   '<div class=\"field\"><label>SKU</label><input name=\"sku\" required maxlength=\"40\" value=\"'+esc(p.sku||'')+'\" '+(p.sku?'readonly':'')+'></div>'+\n   '<div class=\"field\"><label>Nama Produk</label><input name=\"name\" required maxlength=\"100\" value=\"'+esc(p.name||'')+'\"></div>'+\n   '<div class=\"field\"><label>Harga (Rupiah)</label><input name=\"price\" type=\"number\" min=\"0\" required value=\"'+esc(p.price??'')+'\"></div>'+\n   '<div class=\"field\"><label>Stok</label><input name=\"stock\" type=\"number\" min=\"0\" value=\"'+esc(p.stock??0)+'\" required></div>'+\n   '<div class=\"field\"><label>Status</label><select name=\"active\"><option value=\"true\" '+(active?'selected':'')+'>Aktif</option><option value=\"false\" '+(!active?'selected':'')+'>Nonaktif</option></select></div>'+\n   '<div class=\"field\"><label>URL Foto HTTPS</label><input name=\"photo_url\" type=\"url\" placeholder=\"https://…\" value=\"'+esc(p.photo_url||'')+'\"></div>'+\n   '<div class=\"field span-2\"><label>Deskripsi</label><textarea name=\"description\" rows=\"3\" maxlength=\"500\">'+esc(p.description||'')+'</textarea></div></div>'+\n   '<div class=\"form-actions\"><button type=\"button\" id=\"cancelProduct\" class=\"btn\">Batal</button><button class=\"btn btn-primary\" type=\"submit\">Simpan produk</button></div></form>');\n  $('cancelProduct').onclick=closeModal;\n  $('productForm').onsubmit=async e=>{e.preventDefault();const form=new FormData(e.target),obj=Object.fromEntries(form.entries());obj.price=Number(obj.price);obj.stock=Number(obj.stock);obj.active=obj.active==='true';try{await api('/api/admin/products',{method:'POST',body:JSON.stringify({action:'save',product:obj})});closeModal();toast('Produk berhasil disimpan.');await refresh();}catch(err){toast(err.message,true);}};\n }\n async function deleteProduct(sku){\n  if(!confirm('Hapus produk '+sku+' secara permanen? Riwayat pesanan tidak ikut terhapus.'))return;\n  try{await api('/api/admin/products',{method:'POST',body:JSON.stringify({action:'delete',sku:sku})});toast('Produk berhasil dihapus.');await refresh();}catch(e){toast(e.message,true);}\n }\n async function changeStatus(orderId){\n  const order=(data.orders||[]).find(o=>o.order_id===orderId);if(!order)return;\n  const options=['MENUNGGU_PEMBAYARAN','MENUNGGU_VERIFIKASI','DIBAYAR','DIPROSES','DIKIRIM','SELESAI','DIBATALKAN'];\n  openModal('Perbarui status pesanan','<div class=\"field\"><label>'+esc(order.order_id)+' · '+esc(order.customer_name)+'</label><select id=\"newStatus\">'+options.map(s=>'<option '+(s===order.status?'selected':'')+'>'+s+'</option>').join('')+'</select></div><div class=\"form-actions\"><button id=\"cancelStatus\" class=\"btn\">Batal</button><button id=\"saveStatus\" class=\"btn btn-primary\">Simpan status</button></div>');\n  $('cancelStatus').onclick=closeModal;$('saveStatus').onclick=async()=>{try{await api('/api/admin/order-status',{method:'POST',body:JSON.stringify({order_id:orderId,status:$('newStatus').value})});closeModal();toast('Status pesanan diperbarui.');await refresh();}catch(e){toast(e.message,true);}};\n }\n async function paymentAction(orderId,action){\n  const verb=action==='approve'?'menyetujui':'menolak';\n  if(!confirm('Yakin '+verb+' pembayaran pesanan '+orderId+'? Pastikan cocok dengan mutasi rekening/QRIS.'))return;\n  try{const r=await api('/api/admin/payment',{method:'POST',body:JSON.stringify({order_id:orderId,action:action})});toast(action==='approve'?(r.receipt_sent===false?'Pembayaran disetujui; pengiriman resi gagal. Pelanggan dapat meminta resi ulang.':'Pembayaran disetujui dan resi dikirim ke pelanggan.'):'Permintaan pembayaran ditolak.');await refresh();}\n  catch(e){toast(e.message,true);}\n }\n async function showProof(orderId){\n  try{const r=await fetch('/api/admin/proof?order_id='+encodeURIComponent(orderId),{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(r.status===401){logout(false);throw new Error('Sesi login berakhir.');}if(!r.ok)throw new Error('Gagal mengambil file bukti ('+r.status+').');const blob=await r.blob(),url=URL.createObjectURL(blob),type=blob.type||'';\n   if(type.startsWith('image/'))openModal('Bukti pembayaran · '+orderId,'<img class=\"proof-preview\" src=\"'+url+'\" alt=\"Bukti pembayaran\">');\n   else openModal('Bukti pembayaran · '+orderId,'<p>File bukti berhasil diambil.</p><a class=\"btn btn-primary\" href=\"'+url+'\" target=\"_blank\" rel=\"noopener\">Buka / unduh dokumen</a>');\n  }catch(e){toast(e.message,true);}\n }\n document.addEventListener('click',e=>{\n  const page=e.target.closest('[data-page]');if(page){setPage(page.dataset.page);return;}\n  const go=e.target.closest('[data-go]');if(go){setPage(go.dataset.go);return;}\n  const ex=e.target.closest('[data-export]');if(ex){exportReport(ex.dataset.export);return;}\n  const edit=e.target.closest('[data-product-edit]');if(edit){const p=(data.products||[]).find(x=>x.sku===edit.dataset.productEdit);if(p)productForm(p);return;}\n  const del=e.target.closest('[data-product-delete]');if(del){deleteProduct(del.dataset.productDelete);return;}\n  const approve=e.target.closest('[data-pay-approve]');if(approve){paymentAction(approve.dataset.payApprove,'approve');return;}\n  const reject=e.target.closest('[data-pay-reject]');if(reject){paymentAction(reject.dataset.payReject,'reject');return;}\n  const proof=e.target.closest('[data-proof]');if(proof){showProof(proof.dataset.proof);return;}\n  const status=e.target.closest('[data-order-status]');if(status){changeStatus(status.dataset.orderStatus);return;}\n });\n $('loginForm').addEventListener('submit',login);$('logoutButton').addEventListener('click',()=>logout(true));\n $('openSite').addEventListener('click',()=>location.href='https://seiton.biz.id');\n $('menuToggle').addEventListener('click',()=>$('sidebar').classList.toggle('open'));\n $('refreshButton').addEventListener('click',refresh);$('refreshPayments').addEventListener('click',refresh);\n $('period').addEventListener('change',renderOverview);$('orderSearch').addEventListener('input',renderOrders);$('orderStatus').addEventListener('change',renderOrders);$('productSearch').addEventListener('input',renderProducts);$('productFilter').addEventListener('change',renderProducts);\n $('addProductButton').addEventListener('click',()=>productForm(null));\n $('modalBackdrop').addEventListener('click',e=>{if(e.target===$('modalBackdrop'))closeModal();});\n if(token){showApp();refresh();}else showLogin();\n setInterval(()=>{if(token)refresh();},30000);\n})();\n</script>\n</body></html>";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TELEGRAM_API = "https://api.telegram.org";
const TZ = "Asia/Jakarta";
const HEADERS = [
  "order_id", "created_at", "channel", "customer_id", "customer_name",
  "product", "quantity", "unit_price", "subtotal", "shipping", "total",
  "payment_method", "status"
];


async function readCatalogRows(env, range = "Katalog_Produk!A2:G") {
  const state = await transactionReadiness(env);
  if (state.ready) {
    const products = await listProductsTransactional(env, true);
    return products.map(p => [
      p.sku, p.name, p.price, p.stock == null ? "" : p.stock,
      p.active ? "TRUE" : "FALSE", p.photo_url || "", p.description || ""
    ]);
  }
  return readSheet(env, range);
}
async function resolveOrderReference(env, reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) return null;
  const state = await transactionReadiness(env);
  if (state.ready) {
    const order = /^\d+$/.test(ref)
      ? await findOrderByLegacyRow(env, Number(ref))
      : await findOrderTransactional(env, ref);
    return order ? {
      order,
      rowNumber: order.legacy_sheet_row == null ? null : Number(order.legacy_sheet_row),
      row: orderToSheetRow(order)
    } : null;
  }
  if (/^\d+$/.test(ref)) {
    const rowNumber = Number(ref);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) return null;
    const rows = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
    return rows[0]?.[0] ? { rowNumber, row: rows[0], order: null } : null;
  }
  const rows = await readSheet(env, "Pesanan!A2:T");
  const index = rows.findIndex(r => String(r[0] || "").trim() === ref);
  return index < 0 ? null : { rowNumber: index + 2, row: rows[index], order: null };
}
async function mirrorTransactionalOrder(env, order) {
  if (!order) return null;
  const row = orderToSheetRow(order);
  let rowNumber = order.legacy_sheet_row == null ? null : Number(order.legacy_sheet_row);
  try {
    if (rowNumber && rowNumber >= 2) {
      await updateSheetRange(env, "Pesanan!A" + rowNumber + ":T" + rowNumber, [row]);
      return rowNumber;
    }
    const result = await appendSheetRows(env, "Pesanan!A:T", [row]);
    const updatedRange = String(result?.updates?.updatedRange || "");
    const match = updatedRange.match(/!A(\d+):/);
    if (match) {
      rowNumber = Number(match[1]);
      await setLegacyRowTransactional(env, order.order_id, rowNumber);
    }
    return rowNumber;
  } catch (error) {
    console.warn(JSON.stringify({level:"warn",event:"order_sheet_mirror",order_id:order.order_id,message:error.message}));
    return null;
  }
}
async function mirrorTransactionalProduct(env, product) {
  try {
    const rows = await readSheet(env, "Katalog_Produk!A2:G");
    const index = rows.findIndex(r => String(r[0] || "").trim().toUpperCase() === String(product.sku).toUpperCase());
    const values = [[product.sku,product.name,product.price,product.stock == null ? "" : product.stock,
      Boolean(product.active),product.photo_url || "",product.description || ""]];
    if (index >= 0) await updateSheetRange(env,"Katalog_Produk!A"+(index+2)+":G"+(index+2),values);
    else await appendSheetRows(env,"Katalog_Produk!A:G",values);
  } catch(error) {
    console.warn(JSON.stringify({level:"warn",event:"catalog_sheet_mirror",sku:product.sku,message:error.message}));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/pickup") {
      return handlePickupVerificationPage(request, env);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
      return new Response(ADMIN_DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self' https://cdn.jsdelivr.net; img-src 'self' https: blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/login") return handleAdminLogin(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/payment") return handleAdminPaymentAction(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/products") return handleAdminProductMutation(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/order-status") return handleAdminOrderStatus(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/proof") return handleAdminPaymentProof(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/data") {
      return handleAdminDashboardData(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/admin/export") {
      return handleAdminDashboardExport(request, env);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "seiton-order-bot", time: new Date().toISOString() });
    }
    if (request.method === "POST" && url.pathname === "/telegram") {
      return handleTelegram(request, env, ctx);
    }
    return json({ ok: false, error: "Not found" }, 404);
  }
};

async function handleTelegram(request, env, ctx) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: "Webhook security is not configured" }, 503);
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!constantTimeEqual(supplied, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  let update;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }
  if (update.callback_query) {
    ctx.waitUntil(handleTelegramCallback(env, update.callback_query).catch(async error => {
      console.error(JSON.stringify({ level: "error", event: "telegram_callback", message: error.message }));
      const callbackChatId = String(update.callback_query.message?.chat?.id || update.callback_query.from?.id || "");
      try {
        await updateTelegramMessage(env, update.callback_query.message, {
          text: "⚠️ Aksi gagal: " + String(error.message || "Kesalahan tidak diketahui").slice(0, 700),
          replyMarkup: null
        });
      } catch {
        try { await sendTelegram(env, callbackChatId, "⚠️ Aksi gagal: " + String(error.message || "Kesalahan tidak diketahui").slice(0, 700)); } catch {}
      }
    }));
    return json({ ok: true });
  }
  const message = update.message || update.edited_message;
  if (!message || !message.chat || !message.from) return json({ ok: true });

  const text = String(message.text || message.caption || "").trim();
  const chatId = String(message.chat.id);
  const customerId = String(message.from.id);
  const customerName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  const work = (async () => {
    if (message.reply_to_message?.text?.startsWith("🧾 BUKTI PEMBAYARAN SEITON")) {
      await handlePaymentProofUpload(env, message, chatId, customerId);
      return;
    }
    if (isAdmin(chatId, env) && message.reply_to_message?.text?.startsWith("📝 FORM PRODUK SEITON")) {
      try { await handleAdminProductForm(env, chatId, text, message.reply_to_message.text); }
      catch (error) { await sendTelegram(env, chatId, "⚠️ " + error.message + "\\nSilakan kirim ulang dengan format yang benar."); }
      return;
    }
    if (text.startsWith("/laporan")) {
      if (!isAdmin(chatId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const report = await buildAdminReport(env);
      await sendTelegram(env, chatId, report);
      return;
    }
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const admin = isAdmin(chatId, env);
      await sendTelegram(env, chatId, admin ? adminMenuText() : customerMenuText(), admin ? adminMenuKeyboard() : customerMenuKeyboard());
      return;
    }
    const orderInput = parseOrderText(text);
    if (!orderInput) {
      await sendTelegram(env, chatId,
        "🛍️ *Selamat datang di Seiton.id!*\n\n" +
        "Format pesanan:\n`beli SKU jumlah metode_pembayaran`\n" +
        "Contoh: `beli SEI-001 2 QRIS`\n\n" +
        "Ketik /help untuk bantuan.");
      return;
    }
    const result = await createOrder(env, {
      ...orderInput, channel: "telegram", customerId, customerName,
      idempotencyKey: String(update.update_id ?? (chatId + ":" + message.message_id))
    });
    await sendTelegram(env, chatId, orderConfirmation(result, env), orderConfirmationKeyboard(result));
  })();
  ctx.waitUntil(work.catch(async error => {
    console.error(JSON.stringify({ level: "error", event: "telegram_processing", message: error.message }));
    try {
      await sendTelegram(env, chatId, "⚠️ Pesanan belum dapat diproses. Silakan coba kembali atau hubungi admin.");
    } catch (sendError) {
      console.error(JSON.stringify({level:"error",event:"telegram_fallback_notice",message:sendError.message}));
    }
  }));
  return json({ ok: true });
}


function customerMenuText() {
  return "🛍️ SELAMAT DATANG DI SEITON.ID\nPilih menu di bawah ini. Anda tidak perlu mengetik format pesanan.";
}
function adminMenuText() {
  return "🛠️ PANEL ADMIN SEITON.ID\nPilih tindakan yang ingin dilakukan.";
}
function customerMenuKeyboard() {
  return { inline_keyboard: [
    [{ text: "🛍️ Belanja Produk", callback_data: "nav:catalog" }],
    [{ text: "📦 Pesanan Saya", callback_data: "nav:orders" }],
    [{ text: "💬 Bantuan", callback_data: "nav:help" }]
  ] };
}
function adminMenuKeyboard() {
  return { inline_keyboard: [
    [{ text: "📊 Laporan Penjualan", callback_data: "adm:report" }],
    [{ text: "📈 Dashboard Interaktif", callback_data: "adm:dashboard" }],
    [{ text: "📥 Unduh Laporan", callback_data: "adm:exports" }],
    [{ text: "💳 Konfirmasi Pembayaran", callback_data: "adm:paymentchecks" }],
    [{ text: "📦 Validasi Pengambilan", callback_data: "adm:pickup" }],
    [{ text: "📋 Pesanan Terbaru", callback_data: "adm:recent" }],
    [{ text: "🔄 Perbarui Status Pesanan", callback_data: "adm:statuslist" }],
    [{ text: "📦 Lihat Katalog", callback_data: "adm:catalog" }],
    [{ text: "➕ Tambah Produk", callback_data: "adm:addproduct" }],
    [{ text: "🛍️ Tampilan Pelanggan", callback_data: "nav:home" }]
  ] };
}
function adminCatalogKeyboard() {
  return { inline_keyboard: [
    [{ text: "➕ Tambah Produk", callback_data: "adm:addproduct" }],
    [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
  ] };
}
async function ensureCatalogHeaders(env) {
  const headers = await readSheet(env, "Katalog_Produk!A1:G1");
  if (!headers[0]?.[5] || !headers[0]?.[6]) {
    const token = await getGoogleAccessToken(env);
    const range = encodeURIComponent("Katalog_Produk!F1:G1");
    const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "/values/" + range + "?valueInputOption=RAW", {
      method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [["foto_url", "deskripsi"]] })
    });
    if (!response.ok) throw new Error("Tidak dapat menyiapkan kolom foto dan deskripsi katalog.");
  }
}
async function promptAdminProduct(env, chatId, mode, sku = "") {
  const intro = mode === "ADD" ? "📝 FORM PRODUK SEITON — ADD" : "📝 FORM PRODUK SEITON — EDIT — " + sku;
  let current = "";
  if (mode === "EDIT") {
    const rows = await readCatalogRows(env);
    const product = rows.find(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
    if (!product) throw new Error("Produk tidak ditemukan.");
    current = "DATA SAAT INI:\n" + [product[0] || "", product[1] || "", product[2] ?? 0, product[3] ?? 0, product[4] ?? "TRUE", product[5] || "", product[6] || ""].join(" | ") + "\n\n";
  }
  const guide = [
    intro,
    current + "Kirim satu pesan dengan 7 kolom dipisahkan tanda |",
    "SKU | Nama Produk | Harga | Stok | Aktif(TRUE/FALSE) | URL_FOTO(https://...) | Deskripsi",
    mode === "ADD" ? "Contoh: SEI-002 | Kaos Seiton | 99000 | 20 | TRUE | https://contoh.com/foto.jpg | Kaos cotton combed" :
      "Salin data saat ini lalu ubah bagian yang diperlukan. SKU harus tetap sama. URL foto boleh dikosongkan untuk menghapus foto.",
    "Gunakan angka 0 untuk stok habis. Deskripsi maksimal 500 karakter dan tanpa tanda |."
  ].join("\n");
  await sendTelegram(env, chatId, guide, { force_reply: true, input_field_placeholder: "SKU | Nama | Harga | Stok | TRUE/FALSE | URL foto | Deskripsi" });
}
async function handleAdminProductForm(env, chatId, input, prompt) {
  const parts = String(input || "").split("|").map(v => v.trim());
  if (parts.length !== 7) throw new Error("Format produk harus berisi tepat 7 kolom dipisahkan tanda |");
  const [sku, name, price, stock, activeText, photoUrl, description] = parts;
  if (!["TRUE","FALSE","YA","TIDAK","1","0","AKTIF","NONAKTIF"].includes(activeText.toUpperCase())) throw new Error("Status aktif harus TRUE atau FALSE.");
  if (photoUrl && (!/^https:\/\//i.test(photoUrl) || photoUrl.length > 1000)) throw new Error("URL foto harus berupa tautan HTTPS.");
  const result = await saveCatalogProduct(env, {
    sku, name, price, stock,
    active: !["FALSE","TIDAK","0","NONAKTIF"].includes(activeText.toUpperCase()),
    photo_url: photoUrl, description
  }, prompt.includes(" — EDIT — ") ? prompt.split(" — EDIT — ").pop().trim() : "");
  await sendTelegram(env, chatId, "✅ Produk " + sku + (result === "updated" ? " berhasil diperbarui." : " berhasil ditambahkan."), adminMenuKeyboard());
}

async function saveCatalogProduct(env, product, originalSku = "") {
  const sku = String(product.sku || "").trim();
  const name = String(product.name || "").trim();
  const priceText = product.price == null ? "" : String(product.price).trim();
  const stockText = product.stock == null ? "" : String(product.stock).trim();
  const price = Number(priceText), stock = Number(stockText);
  const photo = String(product.photo_url || "").trim();
  const description = String(product.description || "").trim();

  if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new Error("SKU hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung (maksimal 40 karakter).");
  if (!name || name.length > 100) throw new Error("Nama produk wajib diisi (maksimal 100 karakter).");
  if (priceText === "" || !Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(stock) || stock < 0) {
    throw new Error("Harga harus valid dan stok harus bilangan bulat nol atau lebih.");
  }
  if (typeof product.active !== "boolean") throw new Error("Status aktif harus boolean.");
  if (photo && (!/^https:\/\//i.test(photo) || photo.length > 1000)) throw new Error("URL foto harus berupa tautan HTTPS.");
  if (description.length > 500) throw new Error("Deskripsi maksimal 500 karakter.");

  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1 terlebih dahulu.");
  if (state.ready) {
    const result = await saveProductTransactional(env,{sku,name,price,stock,active:product.active,photo_url:photo,description},originalSku);
    const stored = await findProductTransactional(env,sku);
    await mirrorTransactionalProduct(env,stored);
    return result;
  }

  const rows = await readCatalogRows(env);
  const matches = rows.map((r, i) => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase() ? i : -1).filter(i => i >= 0);
  if (matches.length > 1) throw new Error("SKU duplikat ditemukan. Perbaiki katalog sebelum menyimpan.");
  const index = matches[0] ?? -1;
  const editing = Boolean(originalSku);
  if (editing && sku.toUpperCase() !== originalSku.toUpperCase()) throw new Error("SKU tidak boleh diubah saat mengedit produk.");
  if (editing && index < 0) throw new Error("Produk yang akan diedit tidak ditemukan.");
  if (!editing && index >= 0) throw new Error("SKU sudah digunakan. Gunakan SKU lain atau pilih Atur Produk.");

  const values = [[sku, name, price, stock, product.active, photo, description]];
  if (editing) {
    await updateSheetRange(env, "Katalog_Produk!A" + (index + 2) + ":G" + (index + 2), values);
    return "updated";
  }
  await appendSheetRows(env, "Katalog_Produk!A:G", values);
  return "created";
}

async function deleteCatalogProduct(env, sku) {
  const normalizedSku = String(sku || "").trim().toUpperCase();
  if (!normalizedSku) throw new Error("SKU produk tidak valid.");
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1 terlebih dahulu.");
  if (state.ready) {
    const result = await deleteProductTransactional(env,normalizedSku);
    const stored = await findProductTransactional(env,normalizedSku);
    await mirrorTransactionalProduct(env,stored);
    return result;
  }
  const rows = await readCatalogRows(env);
  const index = rows.findIndex(r => String(r[0] || "").trim().toUpperCase() === normalizedSku);
  if (index < 0) throw new Error("Produk tidak ditemukan. Muat ulang katalog admin lalu coba kembali.");
  const token = await getGoogleAccessToken(env);
  const meta = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "?fields=sheets.properties", {
    headers: { Authorization: "Bearer " + token }
  });
  if (!meta.ok) throw new Error("Tidak dapat membaca metadata spreadsheet (" + meta.status + "): " + (await meta.text()).slice(0,400));
  const metadata = await meta.json();
  const sheet = (metadata.sheets || []).find(x => x.properties?.title === "Katalog_Produk");
  if (!sheet || sheet.properties?.sheetId == null) throw new Error("Tab Katalog_Produk tidak ditemukan atau sheetId tidak tersedia.");
  const rowIndex = index + 1;
  const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + ":batchUpdate", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1
    } } }] })
  });
  if (!response.ok) throw new Error("Gagal menghapus produk (" + response.status + "): " + (await response.text()).slice(0,400));
  return { sku: normalizedSku, row: index + 2 };
}
async function sendTelegramPhoto(env, chatId, photo, caption, replyMarkup = null) {
  const payload = { chat_id: chatId, photo, caption: String(caption).slice(0,1024), disable_notification: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendPhoto", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram sendPhoto gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}

async function telegramApiRequest(env, method, payload) {
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok || result.ok === false) {
    const description = String(result.description || "Telegram API error");
    if (description.toLowerCase().includes("message is not modified")) return result;
    throw new Error(method + " gagal (" + response.status + "): " + description.slice(0, 300));
  }
  return result;
}

async function deleteTelegramMessage(env, message) {
  if (!message?.chat?.id || !message?.message_id) return false;
  try {
    await telegramApiRequest(env, "deleteMessage", {
      chat_id: message.chat.id, message_id: message.message_id
    });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "telegram_delete_before_replace", message: error.message }));
    return false;
  }
}

// Keeps a single interactive screen in the chat. Text/photo type changes replace
// the old message because Telegram cannot convert a text message into a photo message.
async function updateTelegramMessage(env, message, options) {
  const text = String(options.text || "");
  const photo = options.photo || null;
  const replyMarkup = options.replyMarkup ?? null;
  if (!message?.chat?.id || !message?.message_id) {
    if (photo) return sendTelegramPhoto(env, message?.chat?.id, photo, text, replyMarkup);
    return sendTelegram(env, message?.chat?.id, text, replyMarkup);
  }
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  const markup = replyMarkup || { inline_keyboard: [] };

  // Photo -> photo: replace the media and keep the same Telegram message.
  if (hasPhoto && photo) {
    return telegramApiRequest(env, "editMessageMedia", {
      chat_id: chatId,
      message_id: messageId,
      media: { type: "photo", media: photo, caption: text.slice(0, 1024) },
      reply_markup: markup
    });
  }

  // Photo -> text screen: edit the caption in-place whenever possible.
  // This missing case caused each checkout step to create another message.
  if (hasPhoto && !photo && !options.clearMedia && text.length <= 1024) {
    return telegramApiRequest(env, "editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: text,
      reply_markup: markup
    });
  }

  // Text -> text: edit the existing message instead of sending another one.
  if (!hasPhoto && !photo) {
    if (text.length <= 4096) {
      return telegramApiRequest(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        reply_markup: markup
      });
    }
    await deleteTelegramMessage(env, message);
    return sendTelegram(env, chatId, text.slice(0, 4096), replyMarkup);
  }

  // Telegram cannot convert a text message into a photo or remove photo media.
  // Delete the old UI message before sending the replacement.
  await deleteTelegramMessage(env, message);
  if (photo) return sendTelegramPhoto(env, chatId, photo, text, replyMarkup);
  return sendTelegram(env, chatId, text.slice(0, 4096), replyMarkup);
}

async function answerTelegramCallback(env, callbackId, message = "") {
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/answerCallbackQuery", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: message, show_alert: false })
  });
  if (!response.ok) throw new Error("Telegram answerCallbackQuery gagal (" + response.status + ")");
}
async function handleTelegramCallback(env, query) {
  const message = query.message || null;
  const chatId = String(message?.chat?.id || query.from?.id || "");
  const userId = String(query.from?.id || "");
  const data = String(query.data || "");
  const admin = isAdmin(chatId, env);
  await answerTelegramCallback(env, query.id);

  if (data === "nav:home" || data === "adm:home") {
    const showAdmin = data === "adm:home" && admin;
    await updateTelegramMessage(env, message, {
      text: showAdmin ? adminMenuText() : customerMenuText(),
      replyMarkup: showAdmin ? adminMenuKeyboard() : customerMenuKeyboard(),
      clearMedia: true
    });
    return;
  }

  if (data === "nav:catalog" || data.startsWith("cat:page:")) {
    const page = data.startsWith("cat:page:") ? Number(data.slice("cat:page:".length)) : 0;
    await showCustomerCatalogPage(env, message, page);
    return;
  }

  if (data.startsWith("buy:")) {
    const sku = data.slice(4);
    const rows = await readSheet(env, "Katalog_Produk!A2:G");
    const p = rows.find(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
    if (!p || ["FALSE","0","NONAKTIF","NO"].includes(String(p[4] ?? "TRUE").toUpperCase())) throw new Error("Produk tidak tersedia");
    const stock = p[3] === "" || p[3] == null ? null : Number(p[3]);
    const buttons = [1,2,3,5].filter(q => stock === null || (Number.isFinite(stock) && stock >= q))
      .map(q => ({ text: q + " pcs", callback_data: "qty:" + sku + ":" + q }));
    const productText = "Produk: " + (p[1] || sku) + "\nHarga: " + rupiah(p[2]) + "\nStok: " + (stock === null ? "Tidak dibatasi" : stock) + (p[6] ? "\n" + p[6] : "") + "\n\nPilih jumlah:";
    const productKeyboard = { inline_keyboard: [
      buttons,
      [{ text: "⬅️ Kembali ke katalog", callback_data: "nav:catalog" }]
    ] };
    await updateTelegramMessage(env, message, {
      text: productText,
      photo: p[5] && /^https:\/\//i.test(String(p[5])) ? String(p[5]) : null,
      clearMedia: !(p[5] && /^https:\/\//i.test(String(p[5]))),
      replyMarkup: productKeyboard
    });
    return;
  }

  if (data.startsWith("qty:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new Error("Jumlah tidak valid");
    await updateTelegramMessage(env, message, {
      text: "Jumlah dipilih: " + qty + "\nPilih metode pembayaran:",
      replyMarkup: { inline_keyboard: [
        [{ text: "QRIS", callback_data: "pay:" + sku + ":" + qty + ":QRIS" }],
        [{ text: "Transfer Bank", callback_data: "pay:" + sku + ":" + qty + ":TRANSFER" }],
        [{ text: "COD", callback_data: "pay:" + sku + ":" + qty + ":COD" }],
        [{ text: "⬅️ Kembali", callback_data: "buy:" + sku }]
      ] }
    });
    return;
  }

  if (data.startsWith("pay:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]); const method = parts[3];
    if (!["QRIS","TRANSFER","COD"].includes(method)) throw new Error("Metode pembayaran tidak valid");
    const rows = await readCatalogRows(env, "Katalog_Produk!A2:E");
    const p = rows.find(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
    if (!p) throw new Error("Produk tidak ditemukan");
    await updateTelegramMessage(env, message, {
      text: "Konfirmasi pesanan\n\nProduk: " + (p[1] || sku) + "\nJumlah: " + qty + "\nHarga satuan: " + rupiah(p[2]) + "\nTotal: " + rupiah(Number(p[2]) * qty) + "\nPembayaran: " + method + "\n\nLanjutkan membuat pesanan?",
      replyMarkup: { inline_keyboard: [
        [{ text: "✅ Ya, buat pesanan", callback_data: "ok:" + sku + ":" + qty + ":" + method }],
        [{ text: "⬅️ Ubah jumlah", callback_data: "buy:" + sku }],
        [{ text: "🏠 Batal", callback_data: "nav:home" }]
      ] }
    });
    return;
  }

  if (data.startsWith("ok:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]); const method = parts[3];
    const result = await createOrder(env, { sku: sku.toUpperCase(), quantity: qty, paymentMethod: method,
      channel: "telegram", customerId: userId, customerName: [query.from.first_name, query.from.last_name].filter(Boolean).join(" "),
      idempotencyKey: String(query.id || "") });
    await updateTelegramMessage(env, message, {
      text: orderConfirmation(result, env),
      replyMarkup: orderConfirmationKeyboard(result)
    });
    return;
  }

  if (data === "nav:orders") {
    await ensurePaymentWorkflowHeaders(env);
    const rows = await readSheet(env, "Pesanan!A2:T");
    const mine = rows.filter(r => String(r[3] || "") === userId).slice(-5).reverse();
    const lines = mine.map(r => String(r[0]) + " | " + String(r[5]) + " | " + String(r[6]) + " pcs | " + rupiah(r[10]) + " | " + String(r[12]) +
      (String(r[13] || "") === "MENUNGGU_VERIFIKASI" ? " · MENUNGGU VERIFIKASI" : String(r[13] || "") === "DISETUJUI" ? " · PEMBAYARAN TERVERIFIKASI" : ""));
    const buttons = [];
    for (const r of mine) {
      const orderId = String(r[0] || "");
      if (String(r[13] || "") === "DISETUJUI" && r[18]) {
        buttons.push([{ text: "🎟️ Lihat Resi " + orderId.slice(-8), callback_data: "ticket:" + orderId }]);
      } else if (String(r[13] || "") === "MENUNGGU_VERIFIKASI") {
        buttons.push([{ text: "📎 Kirim / Perbarui Bukti " + orderId.slice(-8), callback_data: "pc:req:" + orderId }]);
      } else if (String(r[12] || "") === "MENUNGGU_PEMBAYARAN" && String(r[11] || "").toUpperCase() !== "COD") {
        buttons.push([{ text: "💳 Konfirmasi Bayar " + orderId.slice(-8), callback_data: "pc:req:" + orderId }]);
      }
    }
    buttons.push(...customerMenuKeyboard().inline_keyboard);
    await updateTelegramMessage(env, message, {
      text: mine.length ? "Lima pesanan terakhir:\n\n" + lines.join("\n") : "Belum ada pesanan atas akun Telegram ini.",
      replyMarkup: { inline_keyboard: buttons },
      clearMedia: true
    });
    return;
  }

  if (data === "nav:help") {
    await updateTelegramMessage(env, message, {
      text: "Bantuan Seiton.id\nPilih Belanja Produk untuk membuat pesanan melalui tombol. Untuk bantuan admin, silakan hubungi admin toko.",
      replyMarkup: customerMenuKeyboard(),
      clearMedia: true
    });
    return;
  }

  if (data.startsWith("adm:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: customerMenuKeyboard() });
      return;
    }
    const action = data.slice(4);
    if (action === "report") {
      await updateTelegramMessage(env, message, { text: await buildAdminReport(env), replyMarkup: adminMenuKeyboard(), clearMedia: true });
      return;
    }
    if (action === "paymentchecks" || action.startsWith("paymentchecks:")) {
      const page = action.startsWith("paymentchecks:") ? Number(action.slice("paymentchecks:".length)) : 0;
      await showPaymentRequestsPage(env, message, page);
      return;
    }
    if (action === "pickup") {
      await showPickupQueuePage(env, message, 0);
      return;
    }
    if (action === "dashboard") {
      const accessToken = await createDashboardAccessToken(env, chatId);
      const link = "https://admin.seiton.biz.id/#access=" + encodeURIComponent(accessToken);
      await updateTelegramMessage(env, message, {
        text: "📈 Dashboard admin siap dibuka. Tautan akses berlaku selama 4 jam. Jangan teruskan tautan ini kepada orang lain.",
        clearMedia: true,
        replyMarkup: { inline_keyboard: [
          [{ text: "Buka Dashboard Interaktif", url: link }],
          [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
        ] }
      });
      return;
    }
    if (action === "exports") {
      await updateTelegramMessage(env, message, {
        text: "📥 Pilih jenis laporan yang ingin diunduh. Semua file berformat CSV dan bisa dibuka di Excel atau Google Sheets.",
        clearMedia: true,
        replyMarkup: { inline_keyboard: [
          [{ text: "📋 Data Pesanan", callback_data: "exp:orders" }],
          [{ text: "💰 Buku Kas / Keuangan", callback_data: "exp:finance" }],
          [{ text: "📅 Ringkasan Harian", callback_data: "exp:daily" }],
          [{ text: "📦 Stok & Katalog Produk", callback_data: "exp:inventory" }],
          [{ text: "🗂️ Paket Lengkap (4 file)", callback_data: "exp:all" }],
          [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
        ] }
      });
      return;
    }
    if (action === "addproduct") {
      await deleteTelegramMessage(env, message);
      await ensureCatalogHeaders(env);
      await promptAdminProduct(env, chatId, "ADD");
      return;
    }
    if (action === "catalog" || action.startsWith("catalog:")) {
      await ensureCatalogHeaders(env);
      const page = action.startsWith("catalog:") ? Number(action.slice("catalog:".length)) : 0;
      await showAdminCatalogPage(env, message, page);
      return;
    }
    if (action === "recent" || action === "statuslist") {
      const rows = await readSheet(env, "Pesanan!A2:M");
      const recent = rows.map((r,i) => ({ r, row:i+2 })).filter(x => x.r[0]).slice(-10).reverse();
      if (!recent.length) {
        await updateTelegramMessage(env, message, { text: "Belum ada pesanan.", replyMarkup: adminMenuKeyboard() });
        return;
      }
      const buttons = recent.map(x => [{ text: String(x.r[0]).slice(0,22) + " · " + String(x.r[12] || "BARU").slice(0,18),
        callback_data: (action === "statuslist" ? "st:" : "detail:") + x.row }]);
      buttons.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
      const summary = recent.map(x => String(x.r[0]) + " | " + String(x.r[5]) + " | " + rupiah(x.r[10]) + " | " + String(x.r[12])).join("\n");
      await updateTelegramMessage(env, message, {
        text: action === "statuslist" ? "Pilih pesanan yang statusnya ingin diperbarui:" : "10 pesanan terbaru:\n\n" + summary,
        replyMarkup: { inline_keyboard: buttons }
      });
      return;
    }
  }

  if (data.startsWith("prod:edit:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    await deleteTelegramMessage(env, message);
    await promptAdminProduct(env, chatId, "EDIT", data.slice("prod:edit:".length));
    return;
  }

  if (data.startsWith("prod:delete:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const sku = data.slice("prod:delete:".length);
    await updateTelegramMessage(env, message, {
      text: "Yakin ingin menghapus produk " + sku + "? Baris katalog akan dihapus permanen. Riwayat pesanan tidak ikut terhapus.",
      replyMarkup: { inline_keyboard: [
        [{ text: "🗑️ Ya, hapus permanen", callback_data: "prod:delok:" + sku }],
        [{ text: "Batal", callback_data: "adm:catalog" }]
      ] }
    });
    return;
  }

  if (data.startsWith("prod:delok:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    await deleteCatalogProduct(env, data.slice("prod:delok:".length));
    await updateTelegramMessage(env, message, { text: "✅ Produk berhasil dihapus dari katalog.", replyMarkup: adminMenuKeyboard() });
    return;
  }

  if (data.startsWith("exp:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const kind = data.slice(4);
    const allowed = ["orders", "finance", "daily", "inventory", "all"];
    if (!allowed.includes(kind)) throw new Error("Jenis laporan tidak dikenal");
    await updateTelegramMessage(env, message, { text: "⏳ Sedang menyiapkan file laporan dari Google Sheets…", replyMarkup: null });
    const reports = await buildReportExports(env);
    const types = kind === "all" ? ["orders", "finance", "daily", "inventory"] : [kind];
    for (const type of types) {
      await sendTelegramDocument(env, chatId, reports[type].csv, reports[type].filename, reports[type].caption);
    }
    await updateTelegramMessage(env, message, { text: "✅ Laporan selesai dikirim.", replyMarkup: adminMenuKeyboard() });
    return;
  }

  if (data.startsWith("pc:req:")) {
    await requestPaymentVerification(env, message, chatId, userId, data.slice("pc:req:".length));
    return;
  }

  if (data.startsWith("ticket:")) {
    const orderId = data.slice("ticket:".length);
    await ensurePaymentWorkflowHeaders(env);
    const found = await findOrderById(env, orderId);
    if (!found || String(found.row[3] || "") !== userId) throw new Error("Resi tidak ditemukan untuk akun Telegram ini.");
    if (String(found.row[13] || "") !== "DISETUJUI" || !found.row[18] || !PAID_ORDER_STATUSES.includes(String(found.row[12] || "").toUpperCase())) throw new Error("Pembayaran belum disetujui admin atau pesanan sudah dibatalkan.");
    await sendPickupReceipt(env, userId, found.row, orderId, String(found.row[18]));
    await updateTelegramMessage(env, message, { text: "🎟️ Resi pengambilan dikirim kembali.", replyMarkup: customerMenuKeyboard(), clearMedia: true });
    return;
  }

  if (data.startsWith("paylist:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    await showPaymentRequestsPage(env, message, Number(data.slice("paylist:".length)));
    return;
  }
  if (data.startsWith("picklist:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    await showPickupQueuePage(env, message, Number(data.slice("picklist:".length)));
    return;
  }
  if (data.startsWith("payview:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    await showPaymentRequestDetail(env, message, Number(data.slice("payview:".length)));
    return;
  }
  if (data.startsWith("payapprove:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const rowNumber = Number(data.slice("payapprove:".length));
    const approved = await approvePaymentAndIssueTicket(env, rowNumber);
    let receiptSent = true;
    try { await sendPickupReceipt(env, String(approved.row[3]), approved.row, String(approved.row[0]), approved.receiptCode); }
    catch(error) {
      receiptSent = false;
      console.error(JSON.stringify({level:"error",event:"telegram_receipt_delivery",order_id:approved.row[0],message:error.message}));
    }
    await updateTelegramMessage(env, message, {
      text: "✅ Pembayaran " + approved.row[0] + " berhasil disetujui. " + (receiptSent ? "Resi dan QR pengambilan sudah dikirim." : "Resi tersimpan, tetapi QR gagal dikirim. Pelanggan dapat meminta resi ulang lewat Pesanan Saya."),
      replyMarkup: { inline_keyboard: [
        [{ text: "📦 Lihat Antrean Pengambilan", callback_data: "adm:pickup" }],
        [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
      ] },
      clearMedia: true
    });
    return;
  }
  if (data.startsWith("payreject:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const rowNumber = Number(data.slice("payreject:".length));
    const rejected = await rejectPaymentRequest(env, rowNumber);
    await sendTelegram(env, String(rejected[3]), "⚠️ Permintaan verifikasi pembayaran untuk " + rejected[0] + " belum dapat disetujui. Periksa kembali nominal/bukti pembayaran dan ajukan ulang setelah benar.", {
      inline_keyboard: [[{ text: "🔁 Ajukan Verifikasi Ulang", callback_data: "pc:req:" + rejected[0] }]]
    });
    await updateTelegramMessage(env, message, {
      text: "❌ Permintaan pembayaran " + rejected[0] + " ditolak. Pelanggan sudah diberi tahu agar dapat mengajukan ulang.",
      replyMarkup: adminMenuKeyboard(),
      clearMedia: true
    });
    return;
  }
  if (data.startsWith("pickupview:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    await showPickupOrderDetail(env, message, Number(data.slice("pickupview:".length)));
    return;
  }
  if (data.startsWith("pickupdone:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const rowNumber = Number(data.slice("pickupdone:".length));
    const order = await markOrderPickedUp(env, rowNumber);
    try { await sendTelegram(env, String(order[3]), "✅ Pengambilan pesanan " + order[0] + " telah dicatat. Terima kasih sudah berbelanja di Seiton.id!"); } catch {}
    await updateTelegramMessage(env, message, {
      text: "✅ Pesanan " + order[0] + " berhasil ditandai SUDAH DIAMBIL.",
      replyMarkup: { inline_keyboard: [
        [{ text: "📦 Antrean Pengambilan", callback_data: "adm:pickup" }],
        [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
      ] },
      clearMedia: true
    });
    return;
  }

  if (data.startsWith("detail:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const rowNum = Number(data.split(":")[1]);
    const rows = await readSheet(env, "Pesanan!A" + rowNum + ":M" + rowNum); const r = rows[0];
    if (!r) throw new Error("Pesanan tidak ditemukan");
    await updateTelegramMessage(env, message, {
      text: "Detail Pesanan\nID: " + r[0] + "\nPelanggan: " + r[4] + " (" + r[3] + ")\nProduk: " + r[5] + "\nJumlah: " + r[6] + "\nTotal: " + rupiah(r[10]) + "\nPembayaran: " + r[11] + "\nStatus: " + r[12],
      replyMarkup: { inline_keyboard: [
        [{ text: "🔄 Perbarui Status", callback_data: "st:" + rowNum }],
        [{ text: "⬅️ Pesanan Terbaru", callback_data: "adm:recent" }]
      ] }
    });
    return;
  }

  if (data.startsWith("st:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const rowNum = Number(data.split(":")[1]);
    await updateTelegramMessage(env, message, {
      text: "Pilih status baru:",
      replyMarkup: { inline_keyboard: [
        [{ text: "Menunggu Pembayaran", callback_data: "su:" + rowNum + ":MENUNGGU_PEMBAYARAN" }],
        [{ text: "Dibayar", callback_data: "su:" + rowNum + ":DIBAYAR" }],
        [{ text: "Diproses", callback_data: "su:" + rowNum + ":DIPROSES" }],
        [{ text: "Dikirim", callback_data: "su:" + rowNum + ":DIKIRIM" }],
        [{ text: "Selesai", callback_data: "su:" + rowNum + ":SELESAI" }],
        [{ text: "Dibatalkan", callback_data: "su:" + rowNum + ":DIBATALKAN" }],
        [{ text: "⬅️ Kembali", callback_data: "detail:" + rowNum }]
      ] }
    });
    return;
  }

  if (data.startsWith("su:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const parts = data.split(":"); const rowNum = Number(parts[1]); const status = parts[2];
    const allowed = ["MENUNGGU_PEMBAYARAN","MENUNGGU_VERIFIKASI","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"];
    if (!Number.isInteger(rowNum) || rowNum < 2 || !allowed.includes(status)) throw new Error("Pembaruan status tidak valid");
    await setOrderStatus(env, rowNum, status);
    await updateTelegramMessage(env, message, {
      text: "✅ Status pesanan berhasil diperbarui menjadi " + status + ".",
      replyMarkup: adminMenuKeyboard()
    });
    return;
  }
  await updateTelegramMessage(env, message, {
    text: admin ? adminMenuText() : customerMenuText(),
    replyMarkup: admin ? adminMenuKeyboard() : customerMenuKeyboard()
  });
}

async function showCustomerCatalogPage(env, message, page = 0) {
  const rows = await readSheet(env, "Katalog_Produk!A2:G");
  const products = rows.filter(r => r[0] && parseCatalogProduct(r).active);
  if (!products.length) {
    await updateTelegramMessage(env, message, { text: "Katalog belum memiliki produk aktif.", replyMarkup: customerMenuKeyboard() });
    return;
  }
  const pageCount = products.length;
  const current = Math.max(0, Math.min(pageCount - 1, Number.isInteger(page) ? page : 0));
  const p = products[current];
  const sku = String(p[0]).trim();
  const parsedProduct = parseCatalogProduct(p);
  const stock = !parsedProduct.stockValid ? "DATA STOK TIDAK VALID" : parsedProduct.stock === null ? "Tidak dibatasi" : parsedProduct.stock;
  const caption = [
    "🛍️ Katalog Produk (" + (current + 1) + "/" + pageCount + ")",
    String(p[1] || sku),
    "SKU: " + sku,
    "Harga: " + rupiah(p[2]),
    "Stok: " + stock,
    p[6] ? String(p[6]) : ""
  ].filter(Boolean).join("\n");
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "cat:page:" + (current - 1) });
  if (current < pageCount - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "cat:page:" + (current + 1) });
  const keyboard = { inline_keyboard: [
    ...(parsedProduct.priceValid && parsedProduct.stockValid && parsedProduct.active ? [[{ text: "🛒 Pilih Produk Ini", callback_data: "buy:" + sku }]] : []),
    ...(nav.length ? [nav] : []),
    [{ text: "🏠 Menu Utama", callback_data: "nav:home" }]
  ] };
  await updateTelegramMessage(env, message, {
    text: caption,
    photo: p[5] && /^https:\/\//i.test(String(p[5])) ? String(p[5]) : null,
    clearMedia: !(p[5] && /^https:\/\//i.test(String(p[5]))),
    replyMarkup: keyboard
  });
}

async function showAdminCatalogPage(env, message, page = 0) {
  const rows = await readSheet(env, "Katalog_Produk!A2:G");
  const products = rows.filter(r => r[0]);
  if (!products.length) {
    await updateTelegramMessage(env, message, { text: "Katalog masih kosong.", replyMarkup: adminCatalogKeyboard() });
    return;
  }
  const pageCount = products.length;
  const current = Math.max(0, Math.min(pageCount - 1, Number.isInteger(page) ? page : 0));
  const p = products[current];
  const sku = String(p[0]).trim();
  const caption = [
    "📦 Katalog Admin (" + (current + 1) + "/" + pageCount + ")",
    String(p[1] || sku) + " (" + sku + ")",
    "Harga: " + rupiah(p[2]),
    "Stok: " + (p[3] === "" ? "Tidak dibatasi" : p[3]),
    "Status: " + (p[4] ?? "TRUE"),
    p[6] ? String(p[6]) : ""
  ].filter(Boolean).join("\n");
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "adm:catalog:" + (current - 1) });
  if (current < pageCount - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "adm:catalog:" + (current + 1) });
  const keyboard = { inline_keyboard: [
    [{ text: "✏️ Atur Produk", callback_data: "prod:edit:" + sku }, { text: "🗑️ Hapus", callback_data: "prod:delete:" + sku }],
    ...(nav.length ? [nav] : []),
    [{ text: "➕ Tambah Produk", callback_data: "adm:addproduct" }],
    [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
  ] };
  await updateTelegramMessage(env, message, {
    text: caption,
    photo: p[5] && /^https:\/\//i.test(String(p[5])) ? String(p[5]) : null,
    clearMedia: !(p[5] && /^https:\/\//i.test(String(p[5]))),
    replyMarkup: keyboard
  });
}

const PAID_ORDER_STATUSES = ["DIBAYAR", "DIPROSES", "DIKIRIM", "SELESAI", "PAID", "COMPLETED"];
const CANCELLED_ORDER_STATUSES = ["DIBATALKAN", "CANCELLED", "CANCELED"];
function orderRowsToObjects(rows) {
  return rows.filter(r => r[0]).map(r => ({
    order_id: String(r[0] || ""),
    created_at: String(r[1] || ""),
    channel: String(r[2] || ""),
    customer_id: String(r[3] || ""),
    customer_name: String(r[4] || ""),
    product: String(r[5] || ""),
    quantity: Number(r[6] || 0),
    unit_price: Number(r[7] || 0),
    subtotal: Number(r[8] || 0),
    shipping: Number(r[9] || 0),
    total: Number(r[10] || 0),
    payment_method: String(r[11] || ""),
    status: String(r[12] || "").trim().toUpperCase(),
    payment_confirmation_status: String(r[13] || "").trim().toUpperCase(),
    payment_proof_file_id: String(r[14] || ""),
    payment_proof_type: String(r[15] || ""),
    payment_requested_at: String(r[16] || ""),
    payment_confirmed_at: String(r[17] || ""),
    receipt_code: String(r[18] || ""),
    pickup_status: String(r[19] || "")
  }));
}
function productRowsToObjects(rows) {
  return rows.filter(r => r[0]).map(r => {
    const p = parseCatalogProduct(r);
    return {
      sku: p.sku, name: p.name, price: p.price, price_valid: p.priceValid,
      stock: p.stock, stock_valid: p.stockValid,
      active: p.active && p.priceValid && p.stockValid,
      photo_url: p.photoUrl, description: p.description
    };
  });
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Tidak diketahui";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
async function loadAdminDashboardData(env) {
  const state = await transactionReadiness(env);
  if (state.ready) return listDashboardDataTransactional(env);
  await ensurePaymentWorkflowHeaders(env);
  const [orderRows, productRows] = await Promise.all([
    readSheet(env, "Pesanan!A2:T"),
    readCatalogRows(env)
  ]);
  return {
    generated_at: new Date().toISOString(),
    orders: orderRowsToObjects(orderRows),
    products: productRowsToObjects(productRows)
  };
}
async function createDashboardAccessToken(env, chatId) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET belum dikonfigurasi.");
  const payload = base64url(JSON.stringify({
    sub: String(chatId),
    exp: Math.floor(Date.now() / 1000) + 14400,
    v: 1
  }));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode("SEITON_ADMIN_DASHBOARD_V1." + payload)
  );
  return payload + "." + base64urlBytes(new Uint8Array(signature));
}
async function verifyDashboardAccess(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ") || !env.TELEGRAM_WEBHOOK_SECRET) return false;
  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const expected = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode("SEITON_ADMIN_DASHBOARD_V1." + parts[0])
  );
  if (!constantTimeEqual(base64urlBytes(new Uint8Array(expected)), parts[1])) return false;
  try {
    const encodedPayload = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(encodedPayload + "=".repeat((4 - encodedPayload.length % 4) % 4));
    const payload = JSON.parse(decoded);
    const validTime = Number(payload.exp) > Math.floor(Date.now() / 1000);
    return validTime && (
      (payload.v === 1 && isAdmin(payload.sub, env)) ||
      (payload.v === 2 && payload.scope === "admin-dashboard" && payload.sub === "web-admin")
    );
  } catch {
    return false;
  }
}
async function createWebAdminSessionToken(env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET belum dikonfigurasi.");
  const payload = base64url(JSON.stringify({
    sub: "web-admin",
    scope: "admin-dashboard",
    exp: Math.floor(Date.now() / 1000) + 8 * 3600,
    v: 2
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("SEITON_ADMIN_DASHBOARD_V1." + payload));
  return payload + "." + base64urlBytes(new Uint8Array(sig));
}
async function handleAdminLogin(request, env) {
  if (request.method !== "POST" || !env.ADMIN_WEB_PASSWORD) return json({ ok:false, error:"Login dashboard belum dikonfigurasi." }, 503);
  let body; try { body = await request.json(); } catch { return json({ok:false,error:"Format login tidak valid."},400); }
  if (!constantTimeEqual(String(body.password || ""), String(env.ADMIN_WEB_PASSWORD))) {
    return json({ ok:false, error:"Password admin tidak sesuai." }, 401);
  }
  return json({ ok:true, token:await createWebAdminSessionToken(env), expires_in:28800 });
}
async function handleAdminPaymentAction(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Data aksi tidak valid."},400); }
  const found=await findOrderById(env,body.order_id);
  if (!found) return json({ok:false,error:"Pesanan tidak ditemukan."},404);
  try {
    if (body.action==="approve") {
      const method=String(found.row[11]||"").toUpperCase();
      if (!["QRIS","TRANSFER","TRANSFER_BANK"].includes(method)) throw new Error("Hanya pembayaran QRIS/transfer yang dapat diverifikasi melalui menu ini.");
      const approved=await approvePaymentAndIssueTicket(env,found.rowNumber);
      let receiptSent = true;
      try { await sendPickupReceipt(env,String(approved.row[3]),approved.row,String(approved.row[0]),approved.receiptCode); }
      catch(error) {
        receiptSent = false;
        console.error(JSON.stringify({level:"error",event:"dashboard_receipt_delivery",order_id:approved.row[0],message:error.message}));
      }
      return json({ok:true,status:"DIBAYAR",receipt_code:approved.receiptCode,receipt_sent:receiptSent});
    }
    if (body.action==="reject") {
      const rejected=await rejectPaymentRequest(env,found.rowNumber);
      try { await sendTelegram(env,String(rejected[3]),"⚠️ Permintaan verifikasi pembayaran untuk "+rejected[0]+" belum dapat disetujui. Periksa kembali bukti dan nominal pembayaran, lalu ajukan ulang dari menu Pesanan Saya.",{inline_keyboard:[[{text:"🔁 Ajukan Verifikasi Ulang",callback_data:"pc:req:"+rejected[0]}]]}); } catch (error) { console.warn(JSON.stringify({level:"warn",event:"dashboard_payment_rejection_notice",message:error.message})); }
      return json({ok:true,status:"DITOLAK"});
    }
    return json({ok:false,error:"Aksi pembayaran tidak dikenal."},400);
  } catch(error) { return json({ok:false,error:error.message},400); }
}
async function handleAdminProductMutation(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Data produk tidak valid."},400); }
  try {
    await ensureCatalogHeaders(env);
    if (body.action === "delete") {
      const result = await deleteCatalogProduct(env, body.sku);
      return json({ok:true,deleted:result.sku});
    }
    if (body.action !== "save" || !body.product) return json({ok:false,error:"Aksi produk tidak dikenal."},400);
    const p = body.product;
    const active = p.active === true || String(p.active).toLowerCase() === "true";
    const result = await saveCatalogProduct(env, { ...p, active }, String(p.original_sku || ""));
    return json({ok:true,sku:String(p.sku).trim(),action:result});
  } catch(error) { return json({ok:false,error:error.message},400); }
}

async function setOrderStatus(env, rowNumber, status) {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,rowNumber);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const updated = await setOrderStatusTransactional(env,found.order.order_id,status,"admin");
    await mirrorTransactionalOrder(env,updated);
    return orderToSheetRow(updated);
  }
  await ensurePaymentWorkflowHeaders(env);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error("Nomor baris pesanan tidak valid.");
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const row = values[0];
  if (!row || !row[0]) throw new Error("Pesanan tidak ditemukan.");
  const current = String(row[12] || "").trim().toUpperCase();
  const method = String(row[11] || "").trim().toUpperCase();
  if (status === "DIBATALKAN" && PAID_ORDER_STATUSES.includes(current)) {
    throw new Error("Pesanan yang sudah dibayar tidak dapat dibatalkan dari panel ini. Refund perlu dicatat terpisah.");
  }
  if (["DIBAYAR", "DIPROSES", "DIKIRIM", "SELESAI"].includes(status) &&
      ["QRIS", "TRANSFER", "TRANSFER_BANK"].includes(method) &&
      String(row[13] || "").trim().toUpperCase() !== "DISETUJUI") {
    throw new Error("Pembayaran QRIS/transfer harus disetujui melalui menu Verifikasi Pembayaran agar resi diterbitkan.");
  }
  await updateSheetRange(env, "Pesanan!M" + rowNumber + ":M" + rowNumber, [[status]]);
  return row;
}

async function handleAdminOrderStatus(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Data status tidak valid."},400); }
  const found=await findOrderById(env,body.order_id);
  if(!found)return json({ok:false,error:"Pesanan tidak ditemukan."},404);
  const status=String(body.status||"").trim().toUpperCase();
  const allowed=["MENUNGGU_PEMBAYARAN","MENUNGGU_VERIFIKASI","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"];
  if(!allowed.includes(status))return json({ok:false,error:"Status pesanan tidak dikenal."},400);
  try { await setOrderStatus(env,found.rowNumber,status); return json({ok:true,status}); }
  catch(error){return json({ok:false,error:error.message},400);}
}
async function handleAdminPaymentProof(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  const orderId=new URL(request.url).searchParams.get("order_id")||"";
  const found=await findOrderById(env,orderId);
  if(!found||!found.row[14])return json({ok:false,error:"File bukti pembayaran tidak ditemukan."},404);
  const fileId=String(found.row[14]);
  const get=await fetch(TELEGRAM_API+"/bot"+env.TELEGRAM_TOKEN+"/getFile?file_id="+encodeURIComponent(fileId));
  const meta=await get.json().catch(()=>({}));
  if(!get.ok||!meta.ok||!meta.result?.file_path)return json({ok:false,error:"Telegram tidak dapat membuka file bukti pembayaran."},502);
  const file=await fetch("https://api.telegram.org/file/bot"+env.TELEGRAM_TOKEN+"/"+meta.result.file_path);
  if(!file.ok)return json({ok:false,error:"Gagal mengunduh bukti pembayaran dari Telegram."},502);
  const type=String(found.row[15]||"")==="PHOTO"?"image/jpeg":(file.headers.get("content-type")||"application/octet-stream");
  return new Response(file.body,{headers:{"Content-Type":type,"Content-Disposition":"inline; filename=\"payment-proof\"","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}

async function handleAdminDashboardData(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ ok: false, error: "Akses dashboard tidak valid atau sudah kedaluwarsa. Buka kembali dari bot Telegram admin." }, 401);
  try {
    const data = await loadAdminDashboardData(env);
    return json({ ok: true, ...data });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "dashboard_data", message: error.message }));
    return json({ ok: false, error: "Gagal membaca data Google Sheets: " + error.message }, 502);
  }
}
function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function csvText(rows) {
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}
function buildReportExportsFromData(data) {
  const orders = data.orders;
  const products = data.products;
  const dateStamp = localDateKey(new Date().toISOString()).replace(/-/g, "");
  const orderCsv = csvText([
    ["ID Pesanan", "Waktu", "Channel", "Customer ID", "Nama Pelanggan", "Produk", "Jumlah", "Harga Satuan", "Subtotal", "Ongkir", "Total", "Metode Pembayaran", "Status"],
    ...orders.map(o => [o.order_id, o.created_at, o.channel, o.customer_id, o.customer_name, o.product, o.quantity, o.unit_price, o.subtotal, o.shipping, o.total, o.payment_method, o.status])
  ]);
  const financeCsv = csvText([
    ["ID Pesanan", "Tanggal", "Nama Pelanggan", "Produk", "Jumlah", "Subtotal", "Ongkir", "Total Tagihan", "Penerimaan Terkonfirmasi", "Belum Tertagih", "Metode Pembayaran", "Status"],
    ...orders.map(o => {
      const paid = PAID_ORDER_STATUSES.includes(o.status);
      const cancelled = CANCELLED_ORDER_STATUSES.includes(o.status);
      return [o.order_id, localDateKey(o.created_at), o.customer_name, o.product, o.quantity, o.subtotal, o.shipping, o.total, paid ? o.total : 0, !paid && !cancelled ? o.total : 0, o.payment_method, o.status];
    })
  ]);
  const daily = new Map();
  for (const o of orders) {
    const day = localDateKey(o.created_at);
    const d = daily.get(day) || { orders: 0, paid: 0, pending: 0, cancelled: 0, gross: 0, received: 0, outstanding: 0 };
    d.orders++;
    if (PAID_ORDER_STATUSES.includes(o.status)) { d.paid++; d.received += o.total; d.gross += o.total; }
    else if (CANCELLED_ORDER_STATUSES.includes(o.status)) d.cancelled++;
    else { d.pending++; d.outstanding += o.total; d.gross += o.total; }
    daily.set(day, d);
  }
  const dailyCsv = csvText([
    ["Tanggal", "Jumlah Pesanan", "Pesanan Terbayar", "Menunggu Pembayaran", "Dibatalkan", "Nilai Pesanan Non-Batal", "Penerimaan Terkonfirmasi", "Belum Tertagih"],
    ...[...daily.entries()].sort((a,b) => a[0].localeCompare(b[0])).map(([day,d]) => [day,d.orders,d.paid,d.pending,d.cancelled,d.gross,d.received,d.outstanding])
  ]);
  const inventoryCsv = csvText([
    ["SKU", "Nama Produk", "Harga Jual", "Stok", "Nilai Stok pada Harga Jual", "Aktif", "Foto URL", "Deskripsi"],
    ...products.map(p => [p.sku,p.name,p.price,p.stock == null ? "Tidak dibatasi" : p.stock,p.stock == null ? "" : p.price * p.stock,p.active ? "TRUE" : "FALSE",p.photo_url,p.description])
  ]);
  return {
    orders: { csv: orderCsv, filename: "Seiton_Pesanan_" + dateStamp + ".csv", caption: "📋 Rincian seluruh pesanan" },
    finance: { csv: financeCsv, filename: "Seiton_Keuangan_" + dateStamp + ".csv", caption: "💰 Buku transaksi dan penerimaan terkonfirmasi" },
    daily: { csv: dailyCsv, filename: "Seiton_Ringkasan_Harian_" + dateStamp + ".csv", caption: "📅 Ringkasan order dan penerimaan per hari" },
    inventory: { csv: inventoryCsv, filename: "Seiton_Stok_Produk_" + dateStamp + ".csv", caption: "📦 Katalog dan estimasi nilai stok berdasarkan harga jual" }
  };
}
async function buildReportExports(env) {
  const data = await loadAdminDashboardData(env);
  return buildReportExportsFromData(data);
}
async function handleAdminDashboardExport(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ ok: false, error: "Akses dashboard tidak valid atau sudah kedaluwarsa." }, 401);
  const type = new URL(request.url).searchParams.get("type") || "";
  if (!["orders", "finance", "daily", "inventory"].includes(type)) return json({ ok: false, error: "Jenis export tidak valid." }, 400);
  try {
    const report = (await buildReportExports(env))[type];
    return new Response(report.csv, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + report.filename + '"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    } });
  } catch (error) {
    return json({ ok: false, error: "Gagal membuat laporan: " + error.message }, 502);
  }
}
async function sendTelegramDocument(env, chatId, csv, filename, caption = "") {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  form.set("document", new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendDocument", { method: "POST", body: form });
  if (!response.ok) throw new Error("Telegram sendDocument gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}


const PAYMENT_WORKFLOW_HEADERS = [
  "payment_confirmation_status", "payment_proof_file_id", "payment_proof_type",
  "payment_requested_at", "payment_confirmed_at", "receipt_code", "pickup_status"
];
async function ensurePaymentWorkflowHeaders(env) {
  const current = await readSheet(env, "Pesanan!N1:T1");
  const values = current[0] || [];
  if (PAYMENT_WORKFLOW_HEADERS.every((name,i) => String(values[i] || "") === name)) return;
  if (values.some(v => String(v || "").trim())) {
    throw new Error("Kolom N:T pada tab Pesanan sudah terisi dengan struktur berbeda. Perlu pemeriksaan sebelum mengubah header.");
  }
  const token = await getGoogleAccessToken(env);
  const range = encodeURIComponent("Pesanan!N1:T1");
  const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "/values/" + range + "?valueInputOption=RAW", {
    method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [PAYMENT_WORKFLOW_HEADERS] })
  });
  if (!response.ok) throw new Error("Gagal menyiapkan kolom verifikasi pembayaran: " + (await response.text()).slice(0,300));
}
async function updateSheetRange(env, range, values) {
  const token = await getGoogleAccessToken(env);
  const encoded = encodeURIComponent(range);
  const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "/values/" + encoded + "?valueInputOption=RAW", {
    method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ values })
  });
  if (!response.ok) throw new Error("Google Sheets update gagal (" + response.status + "): " + (await response.text()).slice(0,350));
  return response.json();
}
async function findOrderById(env, orderId) {
  const state = await transactionReadiness(env);
  if (state.ready) {
    const order = await findOrderTransactional(env,String(orderId || "").trim());
    return order ? {
      rowNumber: order.legacy_sheet_row == null ? null : Number(order.legacy_sheet_row),
      row: orderToSheetRow(order), order
    } : null;
  }
  const rows = await readSheet(env, "Pesanan!A2:T");
  const index = rows.findIndex(r => String(r[0] || "").trim() === String(orderId || "").trim());
  return index < 0 ? null : { rowNumber: index + 2, row: rows[index], order: null };
}
function orderConfirmationKeyboard(order) {
  const buttons = [];
  if (String(order.paymentMethod || "").toUpperCase() !== "COD") {
    buttons.push([{ text: "💳 Saya Sudah Bayar — Minta Verifikasi", callback_data: "pc:req:" + order.orderId }]);
  }
  buttons.push([{ text: "📦 Pesanan Saya", callback_data: "nav:orders" }]);
  return { inline_keyboard: buttons };
}
function paymentProofPrompt(orderId) {
  return [
    "🧾 BUKTI PEMBAYARAN SEITON",
    "ORDER_ID=" + orderId,
    "",
    "Balas pesan ini dengan foto atau dokumen bukti transfer/QRIS.",
    "Admin akan mencocokkan pembayaran sebelum menerbitkan resi pengambilan."
  ].join("\n");
}
async function requestPaymentVerification(env, message, chatId, userId, orderId) {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Admin perlu menjalankan /migrasi_d1.");
  if (!state.ready) await ensurePaymentWorkflowHeaders(env);
  const found = await findOrderById(env, orderId);
  if (!found) throw new Error("Pesanan tidak ditemukan.");
  let r = found.row;
  if (String(r[3] || "") !== String(userId)) throw new Error("Pesanan ini bukan milik akun Telegram Anda.");
  const method = String(r[11] || "").trim().toUpperCase();
  if (method === "COD") throw new Error("Pesanan COD dibayar saat pengambilan dan tidak memakai verifikasi pembayaran online.");
  if (!["QRIS","TRANSFER","TRANSFER_BANK"].includes(method)) throw new Error("Metode pembayaran tidak didukung untuk verifikasi online.");
  if (PAID_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase()) && String(r[18] || "")) {
    await sendPickupReceipt(env, String(r[3]), r, orderId, String(r[18]));
    await updateTelegramMessage(env, message, { text: "✅ Pembayaran pesanan ini sudah diverifikasi. Resi pengambilan telah dikirim kembali.", replyMarkup: customerMenuKeyboard(), clearMedia: true });
    return;
  }
  if (CANCELLED_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase())) throw new Error("Pesanan ini sudah dibatalkan.");
  if (!["MENUNGGU_PEMBAYARAN", "DITOLAK"].includes(String(r[12] || "").toUpperCase()) &&
      String(r[13] || "").toUpperCase() !== "MENUNGGU_VERIFIKASI") {
    throw new Error("Status pesanan tidak mengizinkan permintaan verifikasi pembayaran.");
  }
  if (state.ready) {
    const updated = await requestVerificationTransactional(env,orderId,userId);
    r = orderToSheetRow(updated);
    await mirrorTransactionalOrder(env,updated);
  } else if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") {
    const requestedAt = new Date().toISOString();
    await updateSheetRange(env, "Pesanan!N" + found.rowNumber + ":T" + found.rowNumber,
      [["MENUNGGU_VERIFIKASI", "", "", requestedAt, "", "", ""]]);
  }
  if (String(r[13] || "") === "MENUNGGU_VERIFIKASI") {
    await updateTelegramMessage(env, message, {
      text: "⏳ Permintaan verifikasi untuk " + orderId + " sudah tercatat. Kirim foto atau dokumen bukti pembayaran dengan membalas pesan instruksi bot.",
      replyMarkup: customerMenuKeyboard(), clearMedia: true
    });
    await sendTelegram(env, chatId, paymentProofPrompt(orderId), { force_reply: true, input_field_placeholder: "Lampirkan foto/dokumen bukti pembayaran" });
    const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
    for (const adminId of admins) {
      try {
        await sendTelegram(env, adminId,
          "🔔 Permintaan verifikasi pembayaran baru\nPesanan: " + orderId + "\nPelanggan: " + String(r[4] || "-") + "\nTotal: " + rupiah(r[10]),
          { inline_keyboard: [[{ text: "Periksa Permintaan", callback_data: "payview:" + (found.rowNumber || orderId) }]] });
      } catch (error) {
        console.warn(JSON.stringify({ level: "warn", event: "payment_admin_notify", message: error.message }));
      }
    }
    return;
  }
  await updateTelegramMessage(env, message, {
    text: "✅ Permintaan verifikasi pembayaran untuk " + orderId + " telah dikirim ke admin.\n\nSilakan lampirkan bukti transfer/QRIS dengan membalas pesan instruksi bot. Resi pengambilan akan dikirim setelah admin menyetujui pembayaran.",
    replyMarkup: customerMenuKeyboard(), clearMedia: true
  });
  await sendTelegram(env, chatId, paymentProofPrompt(orderId), { force_reply: true, input_field_placeholder: "Lampirkan foto/dokumen bukti pembayaran" });
}
async function handlePaymentProofUpload(env, message, chatId, userId) {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap.");
  if (!state.ready) await ensurePaymentWorkflowHeaders(env);
  const prompt = String(message.reply_to_message?.text || "");
  const match = prompt.match(/ORDER_ID=([A-Za-z0-9_-]{1,60})/);
  if (!match) throw new Error("Instruksi bukti pembayaran tidak valid. Ajukan verifikasi ulang dari menu Pesanan Saya.");
  const orderId = match[1];
  const found = await findOrderById(env, orderId);
  if (!found) throw new Error("Pesanan tidak ditemukan.");
  const r = found.row;
  if (String(r[3] || "") !== String(userId)) throw new Error("Pesanan ini bukan milik akun Telegram Anda.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan pembayaran tidak sedang menunggu verifikasi.");
  let fileId = "", fileType = "";
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    if (Number(photo.file_size || 0) > 10 * 1024 * 1024) throw new Error("Ukuran bukti pembayaran maksimal 10 MB.");
    fileId = String(photo.file_id || "");
    fileType = "PHOTO";
  } else if (message.document?.file_id) {
    const mime = String(message.document.mime_type || "").toLowerCase();
    const allowedMime = ["application/pdf","image/jpeg","image/png","image/webp"];
    if (mime && !allowedMime.includes(mime)) throw new Error("Bukti dokumen harus berupa PDF, JPG, PNG, atau WebP.");
    if (Number(message.document.file_size || 0) > 10 * 1024 * 1024) throw new Error("Ukuran bukti pembayaran maksimal 10 MB.");
    fileId = String(message.document.file_id);
    fileType = "DOCUMENT";
  } else {
    await sendTelegram(env, chatId, "Mohon kirim bukti sebagai foto atau dokumen dengan membalas pesan instruksi sebelumnya.");
    return;
  }
  if (state.ready) {
    const updated = await updateProofTransactional(env,orderId,userId,fileId,fileType);
    await mirrorTransactionalOrder(env,updated);
  } else {
    await updateSheetRange(env, "Pesanan!O" + found.rowNumber + ":P" + found.rowNumber, [[fileId, fileType]]);
  }
  await sendTelegram(env, chatId, "✅ Bukti pembayaran untuk " + orderId + " berhasil diterima. Admin akan memeriksanya.");
  const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  for (const adminId of admins) {
    try {
      await sendTelegram(env, adminId,
        "📎 Bukti pembayaran diunggah\nPesanan: " + orderId + "\nPelanggan: " + String(r[4] || "-"),
        { inline_keyboard: [[{ text: "Lihat Bukti & Verifikasi", callback_data: "payview:" + (found.rowNumber || orderId) }]] });
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "payment_proof_notify", message: error.message }));
    }
  }
}
async function showPaymentRequestsPage(env, message, page = 0) {
  await ensurePaymentWorkflowHeaders(env);
  const rows = await readSheet(env, "Pesanan!A2:T");
  const pending = rows.map((r,i) => ({ r, rowNumber:i+2 }))
    .filter(x => String(x.r[13] || "") === "MENUNGGU_VERIFIKASI")
    .reverse();
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(pending.length / pageSize));
  const current = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
  const subset = pending.slice(current * pageSize, current * pageSize + pageSize);
  const lines = subset.map(x => String(x.r[0]) + " · " + String(x.r[4] || "Pelanggan") + " · " + rupiah(x.r[10]) + " · " + (x.r[14] ? "Bukti tersedia" : "Belum ada bukti"));
  const keyboard = subset.map(x => [{ text: String(x.r[0]) + (x.r[14] ? " 📎" : " ⏳"), callback_data: "payview:" + x.rowNumber }]);
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "paylist:" + (current - 1) });
  if (current < pages - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "paylist:" + (current + 1) });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
  await updateTelegramMessage(env, message, {
    text: pending.length ? "💳 PERMINTAAN VERIFIKASI PEMBAYARAN\nHalaman " + (current + 1) + "/" + pages + "\n\n" + lines.join("\n") : "✅ Tidak ada permintaan verifikasi pembayaran yang menunggu.",
    replyMarkup: { inline_keyboard: keyboard },
    clearMedia: true
  });
}
async function showPaymentRequestDetail(env, message, rowNumber) {
  await ensurePaymentWorkflowHeaders(env);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan ini sudah diproses atau tidak lagi menunggu verifikasi.");
  const text = [
    "🔎 VERIFIKASI PEMBAYARAN",
    "Pesanan: " + r[0],
    "Pelanggan: " + (r[4] || "-") + " (" + (r[3] || "-") + ")",
    "Produk: " + (r[5] || "-"),
    "Jumlah: " + (r[6] || 0),
    "Total: " + rupiah(r[10]),
    "Metode: " + (r[11] || "-"),
    "Bukti: " + (r[14] ? (r[15] === "PHOTO" ? "Foto tersedia" : "Dokumen tersedia") : "Tidak diunggah — admin wajib cocokkan mutasi secara manual")
  ].join("\n");
  const keyboard = { inline_keyboard: [
    [{ text: "✅ Setujui Pembayaran", callback_data: "payapprove:" + rowNumber }],
    [{ text: "❌ Tolak / Minta Ulang", callback_data: "payreject:" + rowNumber }],
    [{ text: "⬅️ Daftar Verifikasi", callback_data: "adm:paymentchecks" }]
  ] };
  if (r[14] && r[15] === "PHOTO") {
    await updateTelegramMessage(env, message, { text, photo: String(r[14]), replyMarkup: keyboard });
  } else {
    await updateTelegramMessage(env, message, { text, replyMarkup: keyboard, clearMedia: true });
    if (r[14] && r[15] === "DOCUMENT") await sendTelegramDocumentById(env, message.chat.id, String(r[14]), "Bukti pembayaran " + r[0]);
  }
}
async function approvePaymentAndIssueTicket(env, reference) {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const approved = await approvePaymentTransactional(env,found.order.order_id,"telegram-admin");
    await mirrorTransactionalOrder(env,approved);
    const row = orderToSheetRow(approved);
    const ticketUrl = await createPickupTicketUrl(env,String(approved.order_id),String(approved.receipt_code));
    return {row,receiptCode:approved.receipt_code,ticketUrl,rowNumber:approved.legacy_sheet_row};
  }
  await ensurePaymentWorkflowHeaders(env);
  const rowNumber = Number(reference);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan pembayaran sudah diproses.");
  if (String(r[11] || "").toUpperCase() === "COD") throw new Error("Pesanan COD tidak menggunakan verifikasi pembayaran online.");
  if (CANCELLED_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase())) throw new Error("Pesanan sudah dibatalkan.");
  const now = new Date().toISOString();
  const receiptCode = "SEI-" + localDateKey(now).replace(/-/g,"") + "-" + crypto.randomUUID().slice(0,6).toUpperCase();
  await updateSheetRange(env, "Pesanan!M" + rowNumber + ":T" + rowNumber, [[
    "DIBAYAR", "DISETUJUI", r[14] || "", r[15] || "", r[16] || now, now, receiptCode, "BELUM_DIAMBIL"
  ]]);
  const ticketUrl = await createPickupTicketUrl(env, String(r[0]), receiptCode);
  return { row:r, receiptCode, ticketUrl };
}
async function rejectPaymentRequest(env, reference) {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const rejected = await rejectPaymentTransactional(env,found.order.order_id,"telegram-admin");
    await mirrorTransactionalOrder(env,rejected);
    return orderToSheetRow(rejected);
  }
  await ensurePaymentWorkflowHeaders(env);
  const rowNumber = Number(reference);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan pembayaran sudah diproses.");
  await updateSheetRange(env, "Pesanan!N" + rowNumber + ":N" + rowNumber, [["DITOLAK"]]);
  return r;
}
async function createPickupTicketToken(env, orderId, receiptCode) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    order: orderId, code: receiptCode, v: 2,
    iat: now, exp: now + 30 * 24 * 60 * 60
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("SEITON_PICKUP_TICKET_V2." + payload));
  return payload + "." + base64urlBytes(new Uint8Array(sig));
}

async function verifyPickupTicketToken(env, token) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  try {
    const encoded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    const payload = JSON.parse(decoded);
    if (!payload || !payload.order || !payload.code || ![1, 2].includes(payload.v)) return null;
    if (payload.v === 2 && (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Math.floor(Date.now() / 1000))) return null;
    const prefix = payload.v === 2 ? "SEITON_PICKUP_TICKET_V2." : "SEITON_PICKUP_TICKET_V1.";
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prefix + parts[0]));
    if (!constantTimeEqual(base64urlBytes(new Uint8Array(sig)), parts[1])) return null;
    return payload;
  } catch {
    return null;
  }
}

async function createPickupTicketUrl(env, orderId, receiptCode) {
  const token = await createPickupTicketToken(env, orderId, receiptCode);
  return "https://automate-bot.seiton.biz.id/pickup?ticket=" + encodeURIComponent(token);
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
async function handlePickupVerificationPage(request, env) {
  const ticket = await verifyPickupTicketToken(env, new URL(request.url).searchParams.get("ticket"));
  let state = "INVALID", details = null;
  if (ticket) {
    const found = await findOrderById(env, ticket.order);
    if (found && String(found.row[18] || "") === ticket.code && String(found.row[13] || "") === "DISETUJUI" && PAID_ORDER_STATUSES.includes(String(found.row[12] || "").toUpperCase())) {
      details = found.row;
      state = String(found.row[19] || "") === "DIAMBIL" ? "USED" : "VALID";
    }
  }
  const isValid = state === "VALID";
  const title = state === "VALID" ? "PEMBAYARAN TERVERIFIKASI" : state === "USED" ? "PESANAN SUDAH DIAMBIL" : "TIKET TIDAK VALID";
  const color = state === "VALID" ? "#087f5b" : state === "USED" ? "#9a6700" : "#b42318";
  const body = details ? [
    "<div class='row'><span>ID Pesanan</span><b>" + escapeHtml(details[0]) + "</b></div>",
    "<div class='row'><span>Produk</span><b>" + escapeHtml(details[5]) + "</b></div>",
    "<div class='row'><span>Jumlah</span><b>" + escapeHtml(details[6]) + "</b></div>",
    "<div class='row'><span>Total</span><b>" + escapeHtml(rupiah(details[10])) + "</b></div>",
    "<div class='row'><span>Kode Resi</span><b>" + escapeHtml(details[18]) + "</b></div>",
    "<div class='row'><span>Status Pengambilan</span><b>" + (state === "USED" ? "SUDAH DIAMBIL" : "BELUM DIAMBIL") + "</b></div>"
  ].join("") : "<p>Kode tiket tidak ditemukan atau pembayaran belum disetujui.</p>";
  const html = "<!doctype html><html lang='id'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Verifikasi Resi Seiton.id</title><style>body{margin:0;background:#f2f5f8;font:16px system-ui;color:#1b2735;display:grid;min-height:100vh;place-items:center}.ticket{background:white;border:1px solid #dce3ea;border-radius:18px;padding:28px;max-width:460px;width:calc(100% - 40px);box-shadow:0 12px 40px #10203018}.brand{font-size:13px;color:#64748b;font-weight:700;letter-spacing:.1em}.state{font-weight:800;color:" + color + ";font-size:21px;margin:18px 0}.row{display:flex;justify-content:space-between;gap:18px;border-top:1px dashed #d9e0e8;padding:12px 0}.row span{color:#64748b}.row b{text-align:right;max-width:60%;overflow-wrap:anywhere}.note{font-size:12px;color:#64748b;margin-top:16px}</style><main class='ticket'><div class='brand'>SEITON.ID · TIKET PENGAMBILAN</div><div class='state'>" + title + "</div>" + body + "<p class='note'>Tunjukkan halaman ini kepada petugas saat mengambil pesanan. Tiket tidak membuktikan pembayaran bank di luar status verifikasi Seiton.id.</p></main></html>";
  return new Response(html, { status: 200, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer" } });
}
function pickupQrImageUrl(ticketUrl) {
  return "https://quickchart.io/qr?size=420&margin=2&ecLevel=H&text=" + encodeURIComponent(ticketUrl);
}
function pickupReceiptCaption(row, receiptCode) {
  return [
    "✅ BUKTI PEMBAYARAN TERVERIFIKASI · SEITON.ID",
    "ID Pesanan: " + row[0],
    "Pelanggan: " + (row[4] || "-"),
    "Produk: " + (row[5] || "-"),
    "Jumlah: " + (row[6] || 0),
    "Total: " + rupiah(row[10]),
    "Metode: " + (row[11] || "-"),
    "Kode Resi: " + receiptCode,
    "",
    "Tunjukkan QR ini kepada petugas saat pengambilan."
  ].join("\n");
}
async function sendPickupReceipt(env, customerId, row, orderId, receiptCode) {
  const ticketUrl = await createPickupTicketUrl(env, orderId, receiptCode);
  const caption = pickupReceiptCaption(row, receiptCode);
  try {
    await sendTelegramPhoto(env, customerId, pickupQrImageUrl(ticketUrl), caption, {
      inline_keyboard: [[{ text: "🔎 Periksa Status Resi", url: ticketUrl }]]
    });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "pickup_qr_send", message: error.message }));
    await sendTelegram(env, customerId, caption + "\n\nLink verifikasi: " + ticketUrl);
  }
}
async function sendTelegramDocumentById(env, chatId, fileId, caption = "") {
  const payload = { chat_id: chatId, document: fileId };
  if (caption) payload.caption = String(caption).slice(0, 1024);
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendDocument", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram sendDocument bukti gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}
async function showPickupQueuePage(env, message, page = 0) {
  await ensurePaymentWorkflowHeaders(env);
  const rows = await readSheet(env, "Pesanan!A2:T");
  const queue = rows.map((r,i) => ({ r, rowNumber:i+2 }))
    .filter(x => String(x.r[13] || "") === "DISETUJUI" && String(x.r[18] || "") && String(x.r[19] || "") !== "DIAMBIL" && PAID_ORDER_STATUSES.includes(String(x.r[12] || "").toUpperCase()))
    .reverse();
  const pageSize = 8; const pages = Math.max(1, Math.ceil(queue.length / pageSize));
  const current = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
  const subset = queue.slice(current * pageSize, current * pageSize + pageSize);
  const buttons = subset.map(x => [{ text: String(x.r[0]) + " · " + String(x.r[4] || "Pelanggan"), callback_data: "pickupview:" + x.rowNumber }]);
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "picklist:" + (current - 1) });
  if (current < pages - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "picklist:" + (current + 1) });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
  await updateTelegramMessage(env, message, {
    text: queue.length ? "📦 PESANAN SUDAH DIBAYAR — BELUM DIAMBIL\nHalaman " + (current + 1) + "/" + pages + "\nTotal antrean: " + queue.length : "✅ Tidak ada pesanan lunas yang menunggu pengambilan.",
    replyMarkup: { inline_keyboard: buttons },
    clearMedia: true
  });
}
async function showPickupOrderDetail(env, message, rowNumber) {
  await ensurePaymentWorkflowHeaders(env);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0] || String(r[13] || "").trim().toUpperCase() !== "DISETUJUI" || !r[18] || !PAID_ORDER_STATUSES.includes(String(r[12] || "").trim().toUpperCase())) throw new Error("Resi pengambilan tidak ditemukan, dibatalkan, atau belum disetujui.");
  const ticketUrl = await createPickupTicketUrl(env, String(r[0]), String(r[18]));
  const picked = String(r[19] || "") === "DIAMBIL";
  const buttons = picked ? [] : [[{ text: "✅ Tandai Sudah Diambil", callback_data: "pickupdone:" + rowNumber }]];
  buttons.push([{ text: "🔗 Buka Verifikasi QR", url: ticketUrl }]);
  buttons.push([{ text: "⬅️ Antrean Pengambilan", callback_data: "adm:pickup" }]);
  await updateTelegramMessage(env, message, {
    text: [
      "📦 DETAIL PENGAMBILAN",
      "Pesanan: " + r[0],
      "Pelanggan: " + (r[4] || "-") + " (" + (r[3] || "-") + ")",
      "Produk: " + (r[5] || "-"),
      "Jumlah: " + r[6],
      "Total: " + rupiah(r[10]),
      "Kode Resi: " + r[18],
      "Status: " + (picked ? "SUDAH DIAMBIL" : "BELUM DIAMBIL")
    ].join("\n"),
    replyMarkup: { inline_keyboard: buttons },
    clearMedia: true
  });
}
async function markOrderPickedUp(env, reference) {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const updated = await markPickedUpTransactional(env,found.order.order_id,"telegram-admin");
    await mirrorTransactionalOrder(env,updated);
    return orderToSheetRow(updated);
  }
  await ensurePaymentWorkflowHeaders(env);
  const rowNumber = Number(reference);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0] || String(r[13] || "").trim().toUpperCase() !== "DISETUJUI" || !r[18] || !PAID_ORDER_STATUSES.includes(String(r[12] || "").trim().toUpperCase())) throw new Error("Pesanan tidak memiliki resi pembayaran valid atau sudah dibatalkan.");
  if (String(r[19] || "").trim().toUpperCase() === "DIAMBIL") throw new Error("Pesanan ini sudah ditandai diambil.");
  await updateSheetRange(env, "Pesanan!M" + rowNumber + ":T" + rowNumber, [[
    "SELESAI", "DISETUJUI", r[14] || "", r[15] || "", r[16] || "", r[17] || "", r[18], "DIAMBIL"
  ]]);
  return r;
}



function parseOrderText(text) {
  const match = text.match(/^beli\s+([A-Za-z0-9._-]{1,40})\s+((?:[1-9]\d{0,2}|1000))\s+(QRIS|TRANSFER|TRANSFER_BANK|COD)$/i);
  if (!match) return null;
  return {
    sku: match[1].toUpperCase(),
    quantity: Number(match[2]),
    paymentMethod: match[3].toUpperCase().replace("TRANSFER_BANK", "TRANSFER")
  };
}

async function createOrder(env, input) {
  if (!env.GOOGLE_SHEETS_ID || !env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    throw new Error("Google Sheets credentials are not configured");
  }
  const transactionState = await transactionReadiness(env);
  if (transactionState.configured && !transactionState.ready) {
    throw new Error("Lapisan transaksi D1 belum siap. Admin perlu menjalankan /migrasi_d1 sebelum pesanan baru diterima.");
  }
  if (transactionState.ready) {
    const shipping = env.DEFAULT_SHIPPING == null || env.DEFAULT_SHIPPING === "" ? 0 : Number(env.DEFAULT_SHIPPING);
    if (!Number.isSafeInteger(shipping) || shipping < 0) throw new Error("DEFAULT_SHIPPING harus berupa bilangan Rupiah nol atau lebih.");
    const order = await createOrderTransactional(env,{...input,shipping});
    if (!order.duplicate) {
      const stored = await findOrderTransactional(env,order.orderId);
      await mirrorTransactionalOrder(env,stored);
    }
    return order;
  }
  const idempotencyKey = input.idempotencyKey
    ? `update:${String(input.channel)}:${String(input.idempotencyKey).slice(0,128)}`
    : "";
  if (env.ORDERS_KV && idempotencyKey) {
    const recent = await env.ORDERS_KV.get(idempotencyKey, "json");
    if (recent) return { ...recent, duplicate: true };
  }

  const product = await findProduct(env, input.sku);
  if (!product || !product.active) throw new Error("Produk tidak ditemukan atau sedang nonaktif");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000) {
    throw new Error("Jumlah pesanan tidak valid");
  }
  if (product.stock !== null && product.stock < input.quantity) {
    throw new Error(`Stok tidak mencukupi. Stok tersedia: ${product.stock}`);
  }

  const subtotal = product.price * input.quantity;
  const shipping = env.DEFAULT_SHIPPING == null || env.DEFAULT_SHIPPING === "" ? 0 : Number(env.DEFAULT_SHIPPING);
  if (!Number.isSafeInteger(subtotal)) throw new Error("Subtotal pesanan melebihi batas angka aman.");
  if (!Number.isSafeInteger(shipping) || shipping < 0) throw new Error("DEFAULT_SHIPPING harus berupa bilangan Rupiah nol atau lebih.");
  if (!Number.isSafeInteger(subtotal + shipping)) throw new Error("Total pesanan melebihi batas angka aman.");
  // Store Jakarta-local ISO text so spreadsheet text-prefix formulas can group by business date.
  const createdAt = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace("Z", "+07:00");
  const dateStamp = localDateKey(createdAt).replace(/-/g, "");
  const total = subtotal + shipping;
  const order = {
    orderId: `SEI-${dateStamp}-${crypto.randomUUID().slice(0,8).toUpperCase()}`,
    createdAt,
    createdMs: Date.now(),
    channel: input.channel,
    customerId: String(input.customerId),
    customerName: String(input.customerName || "Pelanggan").slice(0,100),
    product: product.name,
    sku: product.sku,
    quantity: input.quantity,
    unitPrice: product.price,
    subtotal,
    shipping,
    total,
    paymentMethod: input.paymentMethod,
    status: "MENUNGGU_PEMBAYARAN"
  };
  await appendOrder(env, order);
  if (env.ORDERS_KV && idempotencyKey) {
    try {
      await env.ORDERS_KV.put(idempotencyKey, JSON.stringify(order), { expirationTtl: 86400 });
    } catch (error) {
      console.warn(JSON.stringify({level:"warn",event:"order_dedupe_cache",order_id:order.orderId,message:error.message}));
    }
  }
  return order;
}

function parseCatalogProduct(row) {
  const sku = String(row[0] || "").trim();
  const rawPrice = row[2], price = Number(rawPrice);
  const priceValid = rawPrice != null && String(rawPrice).trim() !== "" && Number.isSafeInteger(price) && price >= 0;
  const rawStock = row[3];
  const stockBlank = rawStock == null || String(rawStock).trim() === "";
  const parsedStock = stockBlank ? null : Number(rawStock);
  const stockValid = stockBlank || (Number.isSafeInteger(parsedStock) && parsedStock >= 0);
  const activeText = String(row[4] ?? "TRUE").trim().toUpperCase();
  const active = activeText === "" || ["TRUE","1","YA","YES","AKTIF"].includes(activeText);
  return {
    sku, name: String(row[1] || sku).trim(), price: priceValid ? price : 0, priceValid,
    stock: stockValid ? parsedStock : null, stockValid, active,
    photoUrl: String(row[5] || "").trim(), description: String(row[6] || "").trim()
  };
}

async function findProduct(env, sku) {
  const normalized = String(sku || "").trim().toUpperCase();
  if (!normalized) throw new Error("SKU produk tidak valid.");
  const state = await transactionReadiness(env);
  if (state.ready) {
    const p = await findProductTransactional(env,normalized);
    if (!p) return null;
    return {sku:p.sku,name:p.name,price:Number(p.price),priceValid:true,
      stock:p.stock == null ? null : Number(p.stock),stockValid:true,active:Boolean(p.active),
      photoUrl:p.photo_url || "",description:p.description || ""};
  }
  const rows = await readCatalogRows(env);
  const matches = rows.filter(row => String(row[0] || "").trim().toUpperCase() === normalized);
  if (!matches.length) return null;
  if (matches.length > 1) throw new Error("SKU duplikat ditemukan pada katalog. Hubungi admin.");
  const product = parseCatalogProduct(matches[0]);
  if (!product.priceValid) throw new Error("Harga produk pada katalog tidak valid.");
  if (!product.stockValid) throw new Error("Stok produk pada katalog tidak valid.");
  return product;
}

async function appendSheetRows(env, range, values) {
  const token = await getGoogleAccessToken(env);
  const encoded = encodeURIComponent(range);
  const response = await fetch(`${SHEETS_BASE}/${env.GOOGLE_SHEETS_ID}/values/${encoded}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values })
  });
  if (!response.ok) throw new Error(`Google Sheets append gagal (${response.status}): ${(await response.text()).slice(0,500)}`);
  return response.json();
}

async function appendOrder(env, order) {
  const row = [
    order.orderId, order.createdAt, order.channel, order.customerId, order.customerName,
    `${order.sku} - ${order.product}`, order.quantity, order.unitPrice, order.subtotal,
    order.shipping, order.total, order.paymentMethod, order.status
  ];
  await appendSheetRows(env, "Pesanan!A:M", [row]);
}

async function readSheet(env, range) {
  const token = await getGoogleAccessToken(env);
  const encoded = encodeURIComponent(range);
  const response = await fetch(`${SHEETS_BASE}/${env.GOOGLE_SHEETS_ID}/values/${encoded}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0,500);
    throw new Error(`Google Sheets read gagal (${response.status}): ${detail}`);
  }
  const data = await response.json();
  return data.values || [];
}

async function getGoogleAccessToken(env) {
  const cacheKey = "google-sheets-access-token";
  if (env.TOKEN_KV) {
    const cached = await env.TOKEN_KV.get(cacheKey, "json");
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY harus berupa JSON service account yang valid");
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Service account membutuhkan client_email dan private_key");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64urlBytes(new Uint8Array(signature))}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response.ok) throw new Error(`Google OAuth gagal (${response.status})`);
  const result = await response.json();
  if (env.TOKEN_KV && result.access_token) {
    await env.TOKEN_KV.put(cacheKey, JSON.stringify({
      token: result.access_token,
      expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000
    }), { expirationTtl: Math.max(60, Number(result.expires_in || 3600) - 60) });
  }
  return result.access_token;
}

async function importPrivateKey(pem) {
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function base64url(value) {
  return base64urlBytes(new TextEncoder().encode(value));
}
function base64urlBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function buildAdminReport(env) {
  const rows = await readSheet(env, "Pesanan!A2:M");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const orders = rows.map(row => ({
    orderId: String(row[0] || ""),
    createdAt: String(row[1] || ""),
    product: String(row[5] || "Tidak diketahui"),
    quantity: Number(row[6] || 0),
    total: Number(row[10] || 0),
    payment: String(row[11] || "Lainnya"),
    status: String(row[12] || "")
  })).filter(row => row.orderId);
  const paid = orders.filter(o => PAID_ORDER_STATUSES.includes(o.status.toUpperCase()));
  const todays = paid.filter(o => {
    const date = new Date(o.createdAt);
    return !Number.isNaN(date.getTime()) &&
      new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date) === today;
  });
  const revenue = paid.reduce((sum, o) => sum + o.total, 0);
  const todayRevenue = todays.reduce((sum, o) => sum + o.total, 0);
  const topProducts = new Map();
  for (const order of paid) {
    const name = order.product.split(" - ").slice(1).join(" - ") || order.product;
    topProducts.set(name, (topProducts.get(name) || 0) + order.quantity);
  }
  const best = [...topProducts.entries()].sort((a,b) => b[1] - a[1])[0];
  const target = Math.max(0, Number(env.TARGET_OMSET_HARIAN || 0));
  const pct = target > 0 ? Math.min(100, Math.floor(todayRevenue / target * 100)) : 0;
  const filled = Math.round(pct / 10);
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
  const paymentTotals = {};
  for (const o of paid) paymentTotals[o.payment] = (paymentTotals[o.payment] || 0) + o.total;
  return [
    "📊 *REKAP PENJUALAN SEITON.ID*",
    `🗓️ ${new Intl.DateTimeFormat("id-ID", { dateStyle: "full", timeZone: TZ }).format(new Date())}`,
    "",
    `💰 *Total Omset:* ${rupiah(revenue)}`,
    `📦 *Total Order Dibayar:* ${paid.length.toLocaleString("id-ID")}`,
    `🧾 *Omset Hari Ini:* ${rupiah(todayRevenue)}`,
    `🛍️ *Order Hari Ini:* ${todays.length.toLocaleString("id-ID")}`,
    `🏆 *Produk Terlaris:* ${best ? `${best[0]} (${best[1]} pcs)` : "Belum ada data"}`,
    "",
    "💳 *Distribusi Pembayaran*",
    ...Object.entries(paymentTotals).map(([key, value]) => `• ${key}: ${rupiah(value)}`),
    ...(Object.keys(paymentTotals).length ? [] : ["• Belum ada transaksi dibayar"]),
    "",
    `🎯 *Target Harian:* ${target ? rupiah(target) : "Belum diatur"}`,
    `📈 [${bar}] ${pct}% Target`,
    "",
    "ℹ️ Omset menghitung transaksi berstatus DIBAYAR/SELESAI/PAID/COMPLETED.",
    "_Powered by Seiton.id_"
  ].join("\n");
}

function orderConfirmation(order, env) {
  const paymentInfo = order.paymentMethod === "QRIS"
    ? `\n\n📲 Silakan scan QRIS: ${env.LINK_QRIS_IMAGE || "Hubungi admin untuk QRIS."}`
    : order.paymentMethod === "TRANSFER"
      ? "\n\n🏦 Instruksi transfer akan diberikan admin."
      : "\n\n🚚 Pembayaran COD dipilih.";
  return [
    "✅ *PESANAN DICATAT - SEITON.ID*",
    `🧾 ID: ${order.orderId}`,
    `📦 ${order.product} (${order.sku})`,
    `🔢 Jumlah: ${order.quantity}`,
    `💵 Harga: ${rupiah(order.unitPrice)}`,
    `🚚 Ongkir: ${rupiah(order.shipping)}`,
    `💰 *Total: ${rupiah(order.total)}*`,
    `💳 Metode: ${order.paymentMethod}`,
    `⏳ Status: ${order.status}`,
    paymentInfo,
    "",
    "_Powered by Seiton.id_"
  ].join("\n");
}

function helpText() {
  return [
    "🛍️ *BOT PEMESANAN SEITON.ID*",
    "",
    "Buat pesanan dengan format:",
    "`beli SKU jumlah metode_pembayaran`",
    "",
    "Contoh: `beli SEI-001 2 QRIS`",
    "Metode: QRIS, TRANSFER, COD",
    "",
    "Admin: gunakan `/laporan` untuk rekap penjualan.",
    "_Powered by Seiton.id_"
  ].join("\n");
}

async function sendTelegram(env, chatId, text, replyMarkup = null) {
  if (!env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN belum diatur");
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram sendMessage gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}



function isAdmin(id, env) {
  const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  return admins.includes(String(id));
}
function rupiah(value) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", maximumFractionDigits: 0
  }).format(Number(value) || 0);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}