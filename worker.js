import {
  bootstrapTransactions, createOrderTransactional, transactionReadiness,
  getCartTransactional, addCartItemTransactional, updateCartItemTransactional,
  removeCartItemTransactional, clearCartTransactional, checkoutCartTransactional,
  findOrderTransactional, findOrderByLegacyRow, listOrdersTransactional,
  listProductsTransactional, findProductTransactional, saveProductTransactional,
  deleteProductTransactional, setLegacyRowTransactional, updateProofTransactional,
  requestVerificationTransactional, approvePaymentTransactional, rejectPaymentTransactional,
  setOrderStatusTransactional, markPickedUpTransactional, listDashboardDataTransactional,
  orderToSheetRow, OrderCoordinator, claimSheetMirrorOutbox,
  completeSheetMirrorOutbox, failSheetMirrorOutbox
} from "./transaction-layer.js";
import {
  processMessagingEvent,
  claimMessagingOutbox,
  completeMessagingOutbox,
  failMessagingOutbox,
  parseMessagingAdminCommand,
  listMessagingHandoffs,
  claimMessagingHandoff,
  closeMessagingHandoff,
  resolveMessagingHandoff,
  declineMessagingHandoff,
  queueMessagingHandoffReply
} from "./messaging-core.mjs";
import {
  MAX_PRODUCT_IMAGE_BYTES, isProductMediaKey, productMediaPublicUrl,
  storeProductImage, deleteProductMediaObject, serveProductMedia,
  uploadThenPersistProductImage
} from "./product-media.mjs";
export { OrderCoordinator };
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
 * Source of truth: Cloudflare D1. Durable Objects serialize per-SKU checkout
 * and per-order state transitions; Google Sheets is a retryable reporting mirror.
 */

const ADMIN_DASHBOARD_HTML = "<!doctype html>\n<html lang=\"id\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"robots\" content=\"noindex,nofollow\"><meta name=\"referrer\" content=\"no-referrer\">\n<title>Seiton.id · Admin Workspace</title>\n<script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.min.js\" crossorigin=\"anonymous\"></script>\n<style>\n:root{color-scheme:light;--bg:#f4f6fa;--surface:#fff;--ink:#172033;--muted:#69758a;--line:#e7ebf1;--nav:#101a2b;--nav2:#1a2940;--accent:#e87935;--accent2:#f59b57;--green:#16845b;--greenbg:#e8f6ef;--amber:#a86409;--amberbg:#fff5df;--red:#b83242;--redbg:#fff0f1;--blue:#2864b4;--bluebg:#edf4ff;--shadow:0 12px 32px rgba(25,38,60,.07)}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}.hidden{display:none!important}\n.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 15%,#263c5c 0,transparent 35%),linear-gradient(145deg,#101a2b,#1a2c46)}\n.login-card{width:min(420px,100%);background:#fff;border-radius:22px;padding:32px;box-shadow:0 24px 90px #0005}.brand-mark{display:flex;align-items:center;gap:12px;font-weight:800;font-size:19px}.brand-symbol{width:42px;height:42px;border-radius:13px;background:var(--accent);display:grid;place-items:center;color:#fff;font-size:20px}.login-card h1{font-size:24px;margin:28px 0 8px}.login-card p{color:var(--muted);line-height:1.6;margin:0 0 22px}.field{display:grid;gap:7px;margin-bottom:15px}.field label{font-size:12px;font-weight:700;color:#49566c}.field input,.field select,.field textarea,.toolbar input,.toolbar select{width:100%;border:1px solid #dce2eb;background:#fff;padding:11px 12px;border-radius:10px;color:var(--ink);outline:none}.field input:focus,.field select:focus,.field textarea:focus,.toolbar input:focus,.toolbar select:focus{border-color:#8faed7;box-shadow:0 0 0 3px #2864b41a}.btn{border:0;border-radius:10px;padding:10px 14px;font-weight:700;background:#edf1f6;color:#31405a}.btn:hover{filter:brightness(.97)}.btn-primary{background:var(--accent);color:#fff}.btn-dark{background:#1a2940;color:#fff}.btn-soft{background:var(--bluebg);color:var(--blue)}.btn-danger{background:var(--redbg);color:var(--red)}.btn-small{padding:7px 10px;font-size:12px}.btn-block{width:100%;padding:12px}.login-error{min-height:20px;color:var(--red);font-size:12px;margin-top:10px}\n.app{min-height:100vh;display:grid;grid-template-columns:250px minmax(0,1fr)}.sidebar{background:var(--nav);color:#e9eff8;padding:22px 16px;display:flex;flex-direction:column;min-height:100vh;position:sticky;top:0;height:100vh}.side-brand{display:flex;align-items:center;gap:11px;padding:5px 10px 25px;border-bottom:1px solid #ffffff19}.side-brand .brand-symbol{width:38px;height:38px}.side-brand strong{display:block;font-size:16px}.side-brand small{display:block;color:#9eacc0;font-size:10px;letter-spacing:.13em;margin-top:3px}.nav-label{padding:24px 10px 9px;color:#8797ae;font-size:10px;letter-spacing:.14em;font-weight:800}.side-nav{display:grid;gap:5px}.side-nav button{border:0;background:transparent;color:#b9c5d5;text-align:left;padding:11px 12px;border-radius:10px;display:flex;align-items:center;gap:12px;font-weight:600}.side-nav button:hover{background:#ffffff0d;color:#fff}.side-nav button.active{background:#253751;color:#fff;box-shadow:inset 3px 0 var(--accent)}.nav-icon{width:20px;text-align:center;font-size:16px}.side-bottom{margin-top:auto;border-top:1px solid #ffffff19;padding:16px 8px 0;color:#9eacc0;font-size:11px;line-height:1.6}.side-bottom a{color:#fff;text-decoration:none}\n.main{min-width:0}.topbar{height:76px;background:#ffffffeb;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 30px;position:sticky;top:0;z-index:10;backdrop-filter:blur(12px)}.topbar-left{display:flex;align-items:center;gap:12px}.menu-toggle{display:none}.eyebrow{font-size:10px;letter-spacing:.13em;color:var(--muted);font-weight:800}.topbar h1{font-size:20px;margin:2px 0 0}.top-actions{display:flex;align-items:center;gap:13px}.live-dot{display:inline-flex;align-items:center;gap:7px;color:var(--green);font-size:11px;font-weight:800}.live-dot:before{content:\"\";width:7px;height:7px;border-radius:50%;background:#20a36e;box-shadow:0 0 0 4px #20a36e20}.avatar{width:34px;height:34px;border-radius:50%;background:#fbe7d9;color:#a34b19;display:grid;place-items:center;font-weight:800}\n.content{padding:28px 30px 40px;max-width:1600px;margin:0 auto}.welcome{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px}.welcome h2{font-size:24px;letter-spacing:-.04em;margin:0 0 5px}.welcome p{margin:0;color:var(--muted)}.welcome-actions{display:flex;gap:8px;flex-wrap:wrap}\n.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}.metric{background:var(--surface);border:1px solid var(--line);border-radius:15px;padding:17px 18px;box-shadow:var(--shadow);min-width:0}.metric-top{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:12px;font-weight:700}.metric-icon{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:#fff1e7;color:#ba5e22;font-size:16px}.metric-value{font-size:26px;font-weight:800;letter-spacing:-.04em;margin:13px 0 4px}.metric-note{font-size:11px;color:var(--muted)}\n.grid{display:grid;gap:16px}.grid-main{grid-template-columns:minmax(0,1.65fr) minmax(280px,1fr);margin-bottom:18px}.grid-equal{grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:18px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:15px;padding:18px;box-shadow:var(--shadow);min-width:0}.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.panel-head h3{margin:0;font-size:14px}.panel-sub{font-size:11px;color:var(--muted);margin-top:4px}.chart-box{height:270px;position:relative}.status-list{display:grid;gap:12px}.status-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}.status-row .label{font-size:12px;color:var(--muted)}.status-row strong{font-size:12px}.status-track{grid-column:1/-1;height:7px;border-radius:20px;background:#eff2f6;overflow:hidden}.status-fill{height:100%;border-radius:20px;background:var(--accent)}\n.toolbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:0 0 14px}.toolbar input{max-width:320px}.toolbar select{width:auto;min-width:150px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:12px 12px;border-bottom:1px solid #edf0f4;vertical-align:middle;font-size:12px}th{background:#f8fafc;color:#758197;font-size:10px;letter-spacing:.06em;text-transform:uppercase;position:sticky;top:0}tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfcfe}.right{text-align:right}.muted{color:var(--muted)}.mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace}.status{display:inline-flex;padding:5px 8px;border-radius:99px;font-size:10px;font-weight:800;white-space:nowrap;background:#eef2f6;color:#586477}.status.paid{background:var(--greenbg);color:var(--green)}.status.pending{background:var(--amberbg);color:var(--amber)}.status.cancelled{background:var(--redbg);color:var(--red)}.status.info{background:var(--bluebg);color:var(--blue)}\n.product-cell{display:flex;align-items:center;gap:10px;min-width:190px}.product-cell img{width:38px;height:38px;border-radius:9px;object-fit:cover;background:#f2f4f7}.product-cell strong{display:block;font-size:12px}.product-cell small{color:var(--muted);font-size:10px}.pay-card{border:1px solid var(--line);border-radius:13px;padding:14px;display:grid;gap:10px;margin-bottom:10px}.pay-top{display:flex;justify-content:space-between;gap:12px}.pay-title{font-weight:800}.pay-meta{font-size:11px;color:var(--muted);line-height:1.65}.pay-actions{display:flex;gap:7px;flex-wrap:wrap}.empty{padding:32px 14px;text-align:center;color:var(--muted);font-size:12px}.empty strong{display:block;color:var(--ink);font-size:14px;margin-bottom:5px}\n.report-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}.report-card{border:1px solid var(--line);border-radius:13px;padding:17px}.report-card .report-icon{font-size:22px}.report-card h4{margin:12px 0 5px}.report-card p{margin:0 0 14px;color:var(--muted);font-size:11px;line-height:1.5}\n.modal-backdrop{position:fixed;inset:0;background:#101a2b88;display:grid;place-items:center;padding:20px;z-index:40}.modal{background:white;border-radius:17px;padding:22px;width:min(580px,100%);max-height:92vh;overflow:auto;box-shadow:0 24px 90px #0004}.modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.modal-head h3{margin:0}.modal-close{border:0;background:#f1f3f6;border-radius:8px;width:32px;height:32px;font-size:18px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.span-2{grid-column:span 2}.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}.proof-preview{max-width:100%;max-height:65vh;object-fit:contain;border-radius:10px;background:#f6f8fb}.toast{position:fixed;bottom:22px;right:22px;background:#17263c;color:#fff;padding:12px 16px;border-radius:11px;box-shadow:var(--shadow);z-index:60;font-size:12px;max-width:min(420px,calc(100vw - 44px))}.toast.error{background:#8f2635}\n.footer-note{font-size:10px;color:var(--muted);margin-top:18px}\n@media(max-width:1100px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.report-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-main{grid-template-columns:1fr}.chart-box{height:240px}}\n@media(max-width:760px){.app{grid-template-columns:1fr}.sidebar{position:fixed;left:-270px;top:0;width:250px;z-index:30;transition:left .2s}.sidebar.open{left:0}.menu-toggle{display:inline-grid;border:0;background:#f1f3f6;border-radius:9px;width:36px;height:36px;place-items:center}.topbar{padding:0 15px;height:66px}.content{padding:20px 14px 32px}.topbar h1{font-size:17px}.top-actions .live-dot{display:none}.welcome{align-items:flex-start;flex-direction:column}.welcome h2{font-size:21px}.metrics{gap:9px}.metric{padding:13px}.metric-value{font-size:21px}.grid-equal{grid-template-columns:1fr}.report-grid{grid-template-columns:1fr 1fr}.toolbar input{max-width:100%;flex:1 1 100%}.form-grid{grid-template-columns:1fr}.span-2{grid-column:auto}}\n@media(max-width:420px){.report-grid{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.metric-value{font-size:18px}.top-actions .btn{padding:8px 9px;font-size:11px}}\n</style>\n</head>\n<body>\n<section id=\"loginView\" class=\"login-wrap\">\n <form id=\"loginForm\" class=\"login-card\">\n  <div class=\"brand-mark\"><span class=\"brand-symbol\">S</span><span>Seiton.id<br><small style=\"color:#8b95a7;font-size:10px;letter-spacing:.12em\">ADMIN WORKSPACE</small></span></div>\n  <h1>Masuk ke panel admin</h1><p>Kelola pesanan, verifikasi pembayaran, katalog produk, dan laporan bisnis Seiton.id.</p>\n  <div class=\"field\"><label for=\"adminPassword\">Password admin</label><input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" placeholder=\"Masukkan password admin\" required></div>\n  <button id=\"loginButton\" class=\"btn btn-primary btn-block\" type=\"submit\">Masuk ke Dashboard</button>\n  <div id=\"loginError\" class=\"login-error\" role=\"alert\"></div>\n  <p style=\"font-size:10px;margin:18px 0 0\">Akses terbatas untuk pengelola Seiton.id · <a href=\"https://seiton.biz.id\" style=\"color:#a34b19\">Kembali ke situs utama</a></p>\n </form>\n</section>\n<div id=\"appView\" class=\"app hidden\">\n <aside id=\"sidebar\" class=\"sidebar\">\n  <div class=\"side-brand\"><span class=\"brand-symbol\">S</span><div><strong>Seiton.id</strong><small>ADMIN WORKSPACE</small></div></div>\n  <div class=\"nav-label\">WORKSPACE</div>\n  <nav class=\"side-nav\">\n   <button data-page=\"overview\" class=\"active\"><span class=\"nav-icon\">▦</span> Ringkasan</button>\n   <button data-page=\"orders\"><span class=\"nav-icon\">▤</span> Pesanan</button>\n   <button data-page=\"payments\"><span class=\"nav-icon\">◉</span> Verifikasi Pembayaran <span id=\"pendingBadge\" class=\"status pending\" style=\"margin-left:auto\">0</span></button>\n   <button data-page=\"products\"><span class=\"nav-icon\">▣</span> Produk & Katalog</button>\n   <button data-page=\"reports\"><span class=\"nav-icon\">▥</span> Laporan</button>\n  </nav>\n  <div class=\"nav-label\">SITUS</div>\n  <nav class=\"side-nav\"><button id=\"openSite\"><span class=\"nav-icon\">↗</span> Website Seiton.id</button></nav>\n  <div class=\"side-bottom\">Transaksi utama tersimpan di Cloudflare D1.<br>Google Sheets adalah mirror laporan.<br><a href=\"https://seiton.biz.id\">seiton.biz.id ↗</a></div>\n </aside>\n <main class=\"main\">\n  <header class=\"topbar\">\n   <div class=\"topbar-left\"><button id=\"menuToggle\" class=\"menu-toggle\" aria-label=\"Buka menu\">☰</button><div><div class=\"eyebrow\">SEITON.ID / ADMIN</div><h1 id=\"pageTitle\">Ringkasan</h1></div></div>\n   <div class=\"top-actions\"><span class=\"live-dot\">LIVE DATA</span><span id=\"lastUpdated\" class=\"muted\" style=\"font-size:11px\">Menghubungkan…</span><span class=\"avatar\">A</span><button id=\"logoutButton\" class=\"btn btn-small\">Keluar</button></div>\n  </header>\n  <section class=\"content\">\n   <div id=\"page-overview\" class=\"page\">\n    <div class=\"welcome\"><div><h2>Selamat datang kembali 👋</h2><p>Berikut gambaran operasional toko saat ini.</p></div><div class=\"welcome-actions\"><select id=\"period\" class=\"btn\"><option value=\"7\">7 hari terakhir</option><option value=\"30\" selected>30 hari terakhir</option><option value=\"90\">90 hari terakhir</option><option value=\"365\">12 bulan</option><option value=\"all\">Semua data</option></select><button class=\"btn btn-dark\" id=\"refreshButton\">↻ Perbarui</button></div></div>\n    <div class=\"metrics\">\n     <article class=\"metric\"><div class=\"metric-top\">Omzet terverifikasi <span class=\"metric-icon\">↗</span></div><div id=\"metricRevenue\" class=\"metric-value\">—</div><div class=\"metric-note\">Pembayaran yang telah disetujui</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Total pesanan <span class=\"metric-icon\">▤</span></div><div id=\"metricOrders\" class=\"metric-value\">—</div><div class=\"metric-note\">Sesuai periode yang dipilih</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Menunggu verifikasi <span class=\"metric-icon\">◷</span></div><div id=\"metricVerification\" class=\"metric-value\">—</div><div class=\"metric-note\">Butuh pemeriksaan admin</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Produk aktif <span class=\"metric-icon\">▣</span></div><div id=\"metricProducts\" class=\"metric-value\">—</div><div class=\"metric-note\" id=\"metricStock\">—</div></article>\n    </div>\n    <div class=\"grid grid-main\">\n     <article class=\"panel\"><div class=\"panel-head\"><div><h3>Tren penerimaan</h3><div class=\"panel-sub\">Nilai transaksi yang sudah diverifikasi per hari</div></div><span class=\"status paid\">TERKONFIRMASI</span></div><div class=\"chart-box\"><canvas id=\"revenueChart\"></canvas></div></article>\n     <article class=\"panel\"><div class=\"panel-head\"><div><h3>Status pesanan</h3><div class=\"panel-sub\">Distribusi pesanan pada periode terpilih</div></div></div><div class=\"chart-box\"><canvas id=\"statusChart\"></canvas></div></article>\n    </div>\n    <div class=\"grid grid-equal\">\n     <article class=\"panel\"><div class=\"panel-head\"><div><h3>Produk terlaris</h3><div class=\"panel-sub\">Berdasarkan unit dari pesanan terbayar</div></div></div><div class=\"chart-box\"><canvas id=\"productChart\"></canvas></div></article>\n     <article class=\"panel\"><div class=\"panel-head\"><div><h3>Pesanan terbaru</h3><button class=\"btn btn-small btn-soft\" data-go=\"orders\">Lihat semua ↗</button></div></div><div id=\"recentOrders\"></div></article>\n    </div>\n   </div>\n   <div id=\"page-orders\" class=\"page hidden\">\n    <div class=\"welcome\"><div><h2>Manajemen pesanan</h2><p>Telusuri transaksi dan perbarui status operasional.</p></div><button class=\"btn btn-soft\" data-export=\"orders\">⬇ Ekspor pesanan</button></div>\n    <div class=\"panel\"><div class=\"toolbar\"><input id=\"orderSearch\" placeholder=\"Cari ID, nama pelanggan, atau produk…\"><select id=\"orderStatus\"><option value=\"\">Semua status</option><option>MENUNGGU_PEMBAYARAN</option><option>MENUNGGU_VERIFIKASI</option><option>DIBAYAR</option><option>DIPROSES</option><option>DIKIRIM</option><option>SELESAI</option><option>DIBATALKAN</option></select></div><div id=\"ordersTable\"></div></div>\n   </div>\n   <div id=\"page-payments\" class=\"page hidden\">\n    <div class=\"welcome\"><div><h2>Verifikasi pembayaran</h2><p>Periksa bukti transfer/QRIS sebelum menerbitkan resi pengambilan.</p></div><button class=\"btn btn-soft\" id=\"refreshPayments\">↻ Muat ulang</button></div>\n    <div class=\"metrics\" style=\"grid-template-columns:repeat(3,minmax(0,1fr))\">\n     <article class=\"metric\"><div class=\"metric-top\">Menunggu pemeriksaan</div><div id=\"payPending\" class=\"metric-value\">—</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Bukti terlampir</div><div id=\"payProof\" class=\"metric-value\">—</div></article>\n     <article class=\"metric\"><div class=\"metric-top\">Belum ada bukti</div><div id=\"payNoProof\" class=\"metric-value\">—</div></article>\n    </div>\n    <div id=\"paymentQueue\" class=\"panel\"></div>\n   </div>\n   <div id=\"page-products\" class=\"page hidden\">\n    <div class=\"welcome\"><div><h2>Produk & katalog</h2><p>Atur informasi, stok, harga, deskripsi, serta foto produk.</p></div><button id=\"addProductButton\" class=\"btn btn-primary\">＋ Tambah produk</button></div>\n    <div class=\"panel\"><div class=\"toolbar\"><input id=\"productSearch\" placeholder=\"Cari SKU atau nama produk…\"><select id=\"productFilter\"><option value=\"\">Semua produk</option><option value=\"active\">Aktif</option><option value=\"inactive\">Nonaktif</option><option value=\"low\">Stok rendah (≤ 5)</option></select></div><div id=\"productsTable\"></div></div>\n   </div>\n   <div id=\"page-reports\" class=\"page hidden\">\n    <div class=\"welcome\"><div><h2>Laporan bisnis</h2><p>Unduh laporan terbaru dari basis data transaksi D1.</p></div></div>\n    <div class=\"report-grid\">\n     <article class=\"report-card\"><div class=\"report-icon\">📋</div><h4>Data Pesanan</h4><p>Rincian order, pelanggan, produk, nilai transaksi, dan status.</p><button class=\"btn btn-soft btn-block\" data-export=\"orders\">Unduh CSV</button></article>\n     <article class=\"report-card\"><div class=\"report-icon\">💰</div><h4>Buku Keuangan</h4><p>Tagihan, pembayaran terverifikasi, dan saldo belum tertagih.</p><button class=\"btn btn-soft btn-block\" data-export=\"finance\">Unduh CSV</button></article>\n     <article class=\"report-card\"><div class=\"report-icon\">📅</div><h4>Ringkasan Harian</h4><p>Jumlah pesanan, transaksi dibayar, dan penerimaan per hari.</p><button class=\"btn btn-soft btn-block\" data-export=\"daily\">Unduh CSV</button></article>\n     <article class=\"report-card\"><div class=\"report-icon\">📦</div><h4>Stok & Katalog</h4><p>Harga jual, stok, nilai stok, status aktif, dan foto.</p><button class=\"btn btn-soft btn-block\" data-export=\"inventory\">Unduh CSV</button></article>\n    </div>\n    <div class=\"panel\" style=\"margin-top:15px\"><div class=\"panel-head\"><div><h3>Paket laporan lengkap</h3><div class=\"panel-sub\">Keempat laporan dikirim satu per satu sebagai file CSV.</div></div><button class=\"btn btn-primary\" data-export=\"all\">⬇ Unduh semua laporan</button></div><p class=\"footer-note\">Laba bersih tidak ditampilkan karena harga pokok/modal produk belum tercatat.</p></div>\n   </div>\n   <p class=\"footer-note\">Seiton.id Admin Workspace · Data diperbarui otomatis setiap 30 detik · Sumber transaksi: D1 · Mirror laporan: Google Sheets</p>\n  </section>\n </main>\n</div>\n<div id=\"modalBackdrop\" class=\"modal-backdrop hidden\"><div id=\"modal\" class=\"modal\" role=\"dialog\" aria-modal=\"true\"></div></div>\n<div id=\"toast\" class=\"toast hidden\" role=\"status\"></div>\n<script>\n(function(){\n const $=id=>document.getElementById(id);\n const money=n=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(n)||0);\n const num=n=>new Intl.NumberFormat('id-ID').format(Number(n)||0);\n const esc=s=>String(s==null?'':s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});\n const paid=['DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED'];\n const cancelled=['DIBATALKAN','CANCELLED','CANCELED'];\n const names={overview:'Ringkasan',orders:'Pesanan',payments:'Verifikasi Pembayaran',products:'Produk & Katalog',reports:'Laporan'};\n let token=sessionStorage.getItem('seitonAdminAccess')||'';\n const hash=new URLSearchParams((location.hash||'').replace(/^#/,''));\n const deep=hash.get('access');\n if(deep){token=deep;sessionStorage.setItem('seitonAdminAccess',token);history.replaceState({},'',location.pathname+location.search);}\n let data=null,charts={},toastTimer=null,refreshInFlight=false;\n async function api(path,options){\n  options=options||{};const headers=Object.assign({},options.headers||{});\n  if(token)headers.Authorization='Bearer '+token;\n  if(options.body && !(options.body instanceof FormData))headers['Content-Type']='application/json';\n  const res=await fetch(path,Object.assign({},options,{headers:headers,cache:'no-store'}));\n  if(res.status===401){logout(false);throw new Error('Sesi berakhir. Silakan login kembali.');}\n  const ct=res.headers.get('content-type')||'';\n  const body=ct.includes('application/json')?await res.json():res;\n  if(!res.ok)throw new Error(body.error||'Permintaan gagal ('+res.status+').');\n  return body;\n }\n function toast(message,error){$('toast').textContent=message;$('toast').classList.toggle('error',!!error);$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),3600);}\n function showLogin(){ $('loginView').classList.remove('hidden');$('appView').classList.add('hidden'); }\n function showApp(){ $('loginView').classList.add('hidden');$('appView').classList.remove('hidden'); }\n async function login(event){\n  event.preventDefault();const btn=$('loginButton');btn.disabled=true;btn.textContent='Memeriksa…';$('loginError').textContent='';\n  try{const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('adminPassword').value})});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Login gagal.');token=j.token;sessionStorage.setItem('seitonAdminAccess',token);$('adminPassword').value='';showApp();await refresh();}\n  catch(e){$('loginError').textContent=e.message;}\n  finally{btn.disabled=false;btn.textContent='Masuk ke Dashboard';}\n }\n function logout(show){token='';sessionStorage.removeItem('seitonAdminAccess');Object.values(charts).forEach(c=>c.destroy());charts={};showLogin();if(show)toast('Anda telah keluar.');}\n function setPage(page){\n  if(!names[page])return;\n  document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden'));\n  $('page-'+page).classList.remove('hidden');\n  document.querySelectorAll('.side-nav button[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));\n  $('pageTitle').textContent=names[page];$('sidebar').classList.remove('open');\n  renderCurrent();\n }\n function periodOrders(){\n  const list=data.orders||[],p=$('period').value;\n  if(p==='all')return list;\n  const cutoff=Date.now()-Number(p)*86400000;\n  return list.filter(o=>{const d=new Date(o.created_at).getTime();return Number.isFinite(d)&&d>=cutoff;});\n }\n function fmtDate(s){const d=new Date(s);return Number.isNaN(d.getTime())?'-':d.toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});}\n function statusClass(s){s=String(s||'').toUpperCase();return paid.includes(s)?'paid':cancelled.includes(s)?'cancelled':s==='MENUNGGU_VERIFIKASI'?'info':'pending';}\n function badge(s){return '<span class=\"status '+statusClass(s)+'\">'+esc(s||'TANPA STATUS')+'</span>';}\n function killChart(id){if(charts[id]){charts[id].destroy();delete charts[id];}}\n function renderOverview(){\n  if(!data)return;const orders=periodOrders(),products=data.products||[],confirmed=orders.filter(o=>paid.includes(o.status));\n  const pending=orders.filter(o=>o.payment_confirmation_status==='MENUNGGU_VERIFIKASI');\n  const revenue=confirmed.reduce((a,o)=>a+o.total,0),active=products.filter(p=>p.active);\n  $('metricRevenue').textContent=money(revenue);$('metricOrders').textContent=num(orders.length);$('metricVerification').textContent=num(pending.length);$('metricProducts').textContent=num(active.length);$('metricStock').textContent=num(active.reduce((a,p)=>a+Math.max(0,p.stock||0),0))+' unit stok aktif';\n  $('pendingBadge').textContent=num((data.orders||[]).filter(o=>o.payment_confirmation_status==='MENUNGGU_VERIFIKASI').length);\n  if(typeof Chart!==\"function\"){\n   const recent=[...(data.orders||[])].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,6);\n   $('recentOrders').innerHTML=recent.length?tableOrders(recent,false):'<div class=\"empty\"><strong>Belum ada pesanan</strong>Pesanan baru akan muncul di sini.</div>';\n   return;\n  }\n  const dayKey=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'Tidak diketahui':new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);};\n  const daily={};confirmed.forEach(o=>{const k=dayKey(o.created_at);daily[k]=(daily[k]||0)+o.total;});\n  const labels=Object.keys(daily).sort();killChart('revenueChart');\n  charts.revenueChart=new Chart($('revenueChart'),{type:'line',data:{labels:labels,datasets:[{label:'Penerimaan',data:labels.map(k=>daily[k]),borderColor:'#e87935',backgroundColor:'#e8793520',fill:true,tension:.35,pointRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>money(c.raw)}}},scales:{x:{grid:{display:false},ticks:{color:'#778298',maxTicksLimit:8}},y:{grid:{color:'#edf0f4'},ticks:{color:'#778298',callback:v=>new Intl.NumberFormat('id-ID',{notation:'compact'}).format(v)}}}}});\n  const map={};orders.forEach(o=>{const s=o.status||'TANPA STATUS';map[s]=(map[s]||0)+1;});killChart('statusChart');\n  charts.statusChart=new Chart($('statusChart'),{type:'doughnut',data:{labels:Object.keys(map),datasets:[{data:Object.values(map),backgroundColor:['#16845b','#e87935','#4d83c6','#d2a03e','#8995a7','#c45a66','#7e67b2'],borderWidth:3,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,cutout:'66%',plugins:{legend:{position:'bottom',labels:{usePointStyle:true,boxWidth:7,color:'#66748a',font:{size:10}}}}}});\n  const top={};confirmed.forEach(o=>{const n=String(o.product||'').split(' - ').slice(1).join(' - ')||o.product;top[n]=(top[n]||0)+o.quantity;});const best=Object.entries(top).sort((a,b)=>b[1]-a[1]).slice(0,6);killChart('productChart');\n  charts.productChart=new Chart($('productChart'),{type:'bar',data:{labels:best.map(x=>x[0]),datasets:[{label:'Unit terjual',data:best.map(x=>x[1]),backgroundColor:'#83b59b',borderRadius:6}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:'#edf0f4'},ticks:{color:'#778298'}},y:{grid:{display:false},ticks:{color:'#56647a'}}}}});\n  const recent=[...(data.orders||[])].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,6);\n  $('recentOrders').innerHTML=recent.length?tableOrders(recent,false):'<div class=\"empty\"><strong>Belum ada pesanan</strong>Pesanan baru akan muncul di sini.</div>';\n }\n function tableOrders(rows,actions){\n  if(!rows.length)return '<div class=\"empty\"><strong>Tidak ada hasil</strong>Coba ubah pencarian atau filter.</div>';\n  return '<div class=\"table-wrap\"><table><thead><tr><th>Pesanan</th><th>Pelanggan</th><th>Total</th><th>Status</th>'+(actions?'<th>Aksi</th>':'')+'</tr></thead><tbody>'+rows.map(o=>'<tr><td><strong class=\"mono\">'+esc(o.order_id)+'</strong><div class=\"muted\" style=\"font-size:10px;margin-top:4px\">'+esc(fmtDate(o.created_at))+'</div></td><td>'+esc(o.customer_name)+'<div class=\"muted\" style=\"font-size:10px;margin-top:4px\">'+esc(o.product)+'</div></td><td class=\"mono\">'+money(o.total)+'</td><td>'+badge(o.status)+'</td>'+(actions?'<td><button class=\"btn btn-small btn-soft\" data-order-status=\"'+esc(o.order_id)+'\">Ubah status</button></td>':'')+'</tr>').join('')+'</tbody></table></div>';\n }\n function renderOrders(){\n  if(!data)return;const q=($('orderSearch').value||'').toLowerCase(),status=$('orderStatus').value;\n  const rows=[...(data.orders||[])].filter(o=>(!status||o.status===status)&&[o.order_id,o.customer_name,o.product,o.customer_id].join(' ').toLowerCase().includes(q)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));\n  $('ordersTable').innerHTML=tableOrders(rows,true);\n }\n function renderPayments(){\n  if(!data)return;const rows=(data.orders||[]).filter(o=>o.payment_confirmation_status==='MENUNGGU_VERIFIKASI').sort((a,b)=>new Date(b.payment_requested_at||b.created_at)-new Date(a.payment_requested_at||a.created_at));\n  $('payPending').textContent=num(rows.length);$('payProof').textContent=num(rows.filter(o=>o.payment_proof_file_id).length);$('payNoProof').textContent=num(rows.filter(o=>!o.payment_proof_file_id).length);\n  $('paymentQueue').innerHTML=rows.length?rows.map(o=>'<article class=\"pay-card\"><div class=\"pay-top\"><div><div class=\"pay-title\">'+esc(o.customer_name)+' · '+esc(o.order_id)+'</div><div class=\"pay-meta\">'+esc(o.product)+' · '+num(o.quantity)+' pcs<br>'+esc(o.payment_method)+' · Diminta '+esc(fmtDate(o.payment_requested_at||o.created_at))+'</div></div><div style=\"text-align:right\"><strong>'+money(o.total)+'</strong><div style=\"margin-top:7px\">'+(o.payment_proof_file_id?'<span class=\"status info\">BUKTI TERLAMPIR</span>':'<span class=\"status pending\">TANPA BUKTI</span>')+'</div></div></div><div class=\"pay-actions\">'+(o.payment_proof_file_id?'<button class=\"btn btn-small btn-soft\" data-proof=\"'+esc(o.order_id)+'\">Lihat bukti</button>':'')+'<button class=\"btn btn-small btn-primary\" data-pay-approve=\"'+esc(o.order_id)+'\">Setujui pembayaran</button><button class=\"btn btn-small btn-danger\" data-pay-reject=\"'+esc(o.order_id)+'\">Tolak / minta ulang</button></div></article>').join(''):'<div class=\"empty\"><strong>Semua pembayaran sudah ditangani</strong>Belum ada permintaan verifikasi yang menunggu.</div>';\n }\n function renderProducts(){\n  if(!data)return;const q=($('productSearch').value||'').toLowerCase(),f=$('productFilter').value;\n  const rows=(data.products||[]).filter(p=>[p.sku,p.name,p.description].join(' ').toLowerCase().includes(q))\n   .filter(p=>!f||(f==='active'&&p.active)||(f==='inactive'&&!p.active)||(f==='low'&&p.active&&p.stock_valid&&p.stock!=null&&p.stock<=5));\n  $('productsTable').innerHTML=rows.length?'<div class=\"table-wrap\"><table><thead><tr><th>Produk</th><th>Harga</th><th>Stok</th><th>Status</th><th>Aksi</th></tr></thead><tbody>'+rows.map(p=>'<tr><td><div class=\"product-cell\">'+(p.photo_url?'<img src=\"'+esc(p.photo_url)+'\" alt=\"\">':'<div class=\"metric-icon\">▣</div>')+'<div><strong>'+esc(p.name)+'</strong><small>'+esc(p.sku)+'</small></div></div></td><td class=\"mono\">'+(p.price_valid===false?'<span class=\"status cancelled\">Harga invalid</span>':money(p.price))+'</td><td>'+(p.stock_valid===false?'<span class=\"status cancelled\">Stok invalid</span>':(p.stock==null?'Tidak dibatasi':num(p.stock)))+'</td><td>'+(p.active?'<span class=\"status paid\">AKTIF</span>':'<span class=\"status cancelled\">NONAKTIF / PERLU PERBAIKAN</span>')+'</td><td><button class=\"btn btn-small btn-soft\" data-product-edit=\"'+esc(p.sku)+'\">Atur</button> <button class=\"btn btn-small btn-danger\" data-product-delete=\"'+esc(p.sku)+'\">Hapus</button></td></tr>').join('')+'</tbody></table></div>':'<div class=\"empty\"><strong>Produk tidak ditemukan</strong>Tambahkan produk baru atau ubah filter.</div>';\n }\n function renderCurrent(){\n  const page=document.querySelector('.page:not(.hidden)')?.id.replace('page-','');\n  if(page==='overview')renderOverview();if(page==='orders')renderOrders();if(page==='payments')renderPayments();if(page==='products')renderProducts();\n }\n async function refresh(){\n  if(refreshInFlight || !token)return;\n  refreshInFlight=true;\n  try{const r=await api('/api/admin/data');if(!r.ok)throw new Error(r.error||'Tidak dapat memuat data');data=r;$('lastUpdated').textContent='Diperbarui '+new Date(r.generated_at).toLocaleTimeString('id-ID');renderCurrent();$('pendingBadge').textContent=num((data.orders||[]).filter(o=>o.payment_confirmation_status==='MENUNGGU_VERIFIKASI').length);}\n  catch(e){toast(e.message,true);}\n  finally{refreshInFlight=false;}\n }\n async function exportReport(type){\n  try{const r=await fetch('/api/admin/export?type='+encodeURIComponent(type),{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(r.status===401){logout(false);throw new Error('Sesi login berakhir.');}if(!r.ok){const j=await r.json();throw new Error(j.error||'Export gagal.');}const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Seiton_'+type+'.csv';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('File laporan berhasil disiapkan.');}\n  catch(e){toast(e.message,true);}\n }\n function openModal(title,body){\n  $('modal').innerHTML='<div class=\"modal-head\"><h3>'+title+'</h3><button class=\"modal-close\" id=\"modalClose\">×</button></div>'+body;\n  $('modalBackdrop').classList.remove('hidden');$('modalClose').onclick=closeModal;\n }\n function closeModal(){$('modalBackdrop').classList.add('hidden');$('modal').innerHTML='';}\n function productForm(p){\n  p=p||{};const active=p.active!==false;\n  openModal(p.sku?'Atur Produk':'Tambah Produk','<form id=\"productForm\"><input type=\"hidden\" name=\"original_sku\" value=\"'+esc(p.sku||'')+'\"><div class=\"form-grid\">'+\n   '<div class=\"field\"><label>SKU</label><input name=\"sku\" required maxlength=\"40\" value=\"'+esc(p.sku||'')+'\" '+(p.sku?'readonly':'')+'></div>'+\n   '<div class=\"field\"><label>Nama Produk</label><input name=\"name\" required maxlength=\"100\" value=\"'+esc(p.name||'')+'\"></div>'+\n   '<div class=\"field\"><label>Harga (Rupiah)</label><input name=\"price\" type=\"number\" min=\"0\" required value=\"'+esc(p.price??'')+'\"></div>'+\n   '<div class=\"field\"><label>Stok</label><input name=\"stock\" type=\"number\" min=\"0\" value=\"'+esc(p.stock??0)+'\" required></div>'+\n   '<div class=\"field\"><label>Status</label><select name=\"active\"><option value=\"true\" '+(active?'selected':'')+'>Aktif</option><option value=\"false\" '+(!active?'selected':'')+'>Nonaktif</option></select></div>'+\n   '<div class=\"field\"><label>URL Foto HTTPS (opsional)</label><input name=\"photo_url\" type=\"url\" placeholder=\"https://…\" value=\"'+esc(p.photo_r2?'':(p.photo_url||''))+'\"></div>'+\n   '<div class=\"field\"><label>Upload Foto (JPEG/PNG/WebP · maks 5 MB)</label><input name=\"image\" type=\"file\" accept=\"image/jpeg,image/png,image/webp\"></div>'+\n   '<div class=\"field\"><label><input name=\"remove_photo\" type=\"checkbox\"> Hapus foto saat ini</label></div>'+\n   '<div class=\"field span-2\"><label>Foto produk saat ini</label>'+(p.photo_url?'<img src=\"'+esc(p.photo_url)+'\" alt=\"Foto '+esc(p.name||'produk')+'\" style=\"max-width:140px;max-height:110px;object-fit:contain;border-radius:10px\">': '<span class=\"muted\">Belum ada foto</span>')+'</div>'+\n   '<div class=\"field span-2\"><label>Deskripsi</label><textarea name=\"description\" rows=\"3\" maxlength=\"500\">'+esc(p.description||'')+'</textarea></div></div>'+\n   '<div class=\"form-actions\"><button type=\"button\" id=\"cancelProduct\" class=\"btn\">Batal</button><button class=\"btn btn-primary\" type=\"submit\">Simpan produk</button></div></form>');\n  $('cancelProduct').onclick=closeModal;\n  $('productForm').onsubmit=async e=>{e.preventDefault();const form=new FormData(e.target),obj=Object.fromEntries(form.entries()),image=form.get('image'),removePhoto=form.get('remove_photo')==='on';delete obj.image;delete obj.remove_photo;obj.price=Number(obj.price);obj.stock=Number(obj.stock);obj.active=obj.active==='true';try{if(image&&image.size>0){const upload=new FormData();['sku','name','price','stock','active','description','original_sku'].forEach(k=>upload.set(k,obj[k]??''));upload.set('image',image,image.name||'product-image');await api('/api/admin/products/photo',{method:'POST',body:upload});}else{if(removePhoto)obj.photo_url='__REMOVE__';else if(p.photo_r2&&!obj.photo_url)obj.photo_url='__KEEP__';await api('/api/admin/products',{method:'POST',body:JSON.stringify({action:'save',product:obj})});}closeModal();toast('Produk berhasil disimpan.');await refresh();}catch(err){toast(err.message,true);}};\n }\n async function deleteProduct(sku){\n  if(!confirm('Hapus produk '+sku+' secara permanen? Riwayat pesanan tidak ikut terhapus.'))return;\n  try{await api('/api/admin/products',{method:'POST',body:JSON.stringify({action:'delete',sku:sku})});toast('Produk berhasil dihapus.');await refresh();}catch(e){toast(e.message,true);}\n }\n async function changeStatus(orderId){\n  const order=(data.orders||[]).find(o=>o.order_id===orderId);if(!order)return;\n  const options=['MENUNGGU_PEMBAYARAN','MENUNGGU_VERIFIKASI','DIBAYAR','DIPROSES','DIKIRIM','SELESAI','DIBATALKAN'];\n  openModal('Perbarui status pesanan','<div class=\"field\"><label>'+esc(order.order_id)+' · '+esc(order.customer_name)+'</label><select id=\"newStatus\">'+options.map(s=>'<option '+(s===order.status?'selected':'')+'>'+s+'</option>').join('')+'</select></div><div class=\"form-actions\"><button id=\"cancelStatus\" class=\"btn\">Batal</button><button id=\"saveStatus\" class=\"btn btn-primary\">Simpan status</button></div>');\n  $('cancelStatus').onclick=closeModal;$('saveStatus').onclick=async()=>{try{await api('/api/admin/order-status',{method:'POST',body:JSON.stringify({order_id:orderId,status:$('newStatus').value})});closeModal();toast('Status pesanan diperbarui.');await refresh();}catch(e){toast(e.message,true);}};\n }\n async function paymentAction(orderId,action){\n  const verb=action==='approve'?'menyetujui':'menolak';\n  if(!confirm('Yakin '+verb+' pembayaran pesanan '+orderId+'? Pastikan cocok dengan mutasi rekening/QRIS.'))return;\n  try{const r=await api('/api/admin/payment',{method:'POST',body:JSON.stringify({order_id:orderId,action:action})});toast(action==='approve'?(r.receipt_sent===false?'Pembayaran disetujui; pengiriman resi gagal. Pelanggan dapat meminta resi ulang.':'Pembayaran disetujui dan resi dikirim ke pelanggan.'):'Permintaan pembayaran ditolak.');await refresh();}\n  catch(e){toast(e.message,true);}\n }\n async function showProof(orderId){\n  try{const r=await fetch('/api/admin/proof?order_id='+encodeURIComponent(orderId),{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(r.status===401){logout(false);throw new Error('Sesi login berakhir.');}if(!r.ok)throw new Error('Gagal mengambil file bukti ('+r.status+').');const blob=await r.blob(),url=URL.createObjectURL(blob),type=blob.type||'';\n   if(type.startsWith('image/'))openModal('Bukti pembayaran · '+orderId,'<img class=\"proof-preview\" src=\"'+url+'\" alt=\"Bukti pembayaran\">');\n   else openModal('Bukti pembayaran · '+orderId,'<p>File bukti berhasil diambil.</p><a class=\"btn btn-primary\" href=\"'+url+'\" target=\"_blank\" rel=\"noopener\">Buka / unduh dokumen</a>');\n  }catch(e){toast(e.message,true);}\n }\n document.addEventListener('click',e=>{\n  const page=e.target.closest('[data-page]');if(page){setPage(page.dataset.page);return;}\n  const go=e.target.closest('[data-go]');if(go){setPage(go.dataset.go);return;}\n  const ex=e.target.closest('[data-export]');if(ex){exportReport(ex.dataset.export);return;}\n  const edit=e.target.closest('[data-product-edit]');if(edit){const p=(data.products||[]).find(x=>x.sku===edit.dataset.productEdit);if(p)productForm(p);return;}\n  const del=e.target.closest('[data-product-delete]');if(del){deleteProduct(del.dataset.productDelete);return;}\n  const approve=e.target.closest('[data-pay-approve]');if(approve){paymentAction(approve.dataset.payApprove,'approve');return;}\n  const reject=e.target.closest('[data-pay-reject]');if(reject){paymentAction(reject.dataset.payReject,'reject');return;}\n  const proof=e.target.closest('[data-proof]');if(proof){showProof(proof.dataset.proof);return;}\n  const status=e.target.closest('[data-order-status]');if(status){changeStatus(status.dataset.orderStatus);return;}\n });\n $('loginForm').addEventListener('submit',login);$('logoutButton').addEventListener('click',()=>logout(true));\n $('openSite').addEventListener('click',()=>location.href='https://seiton.biz.id');\n $('menuToggle').addEventListener('click',()=>$('sidebar').classList.toggle('open'));\n $('refreshButton').addEventListener('click',refresh);$('refreshPayments').addEventListener('click',refresh);\n $('period').addEventListener('change',renderOverview);$('orderSearch').addEventListener('input',renderOrders);$('orderStatus').addEventListener('change',renderOrders);$('productSearch').addEventListener('input',renderProducts);$('productFilter').addEventListener('change',renderProducts);\n $('addProductButton').addEventListener('click',()=>productForm(null));\n $('modalBackdrop').addEventListener('click',e=>{if(e.target===$('modalBackdrop'))closeModal();});\n if(token){showApp();refresh();}else showLogin();\n setInterval(()=>{if(token)refresh();},30000);\n})();\n</script>\n</body></html>";
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
async function mirrorTransactionalOrder(env, order, options = {}) {
  if (!order) return null;
  const row = orderToSheetRow(order);
  let rowNumber = order.legacy_sheet_row == null ? null : Number(order.legacy_sheet_row);
  try {
    if (rowNumber && rowNumber >= 2) {
      await updateSheetRange(env, "Pesanan!A" + rowNumber + ":T" + rowNumber, [row]);
      return rowNumber;
    }
    // Recovery pass: an earlier append may have succeeded before D1 stored its row number.
    if (options.recoverAppend) {
      const ids = await readSheet(env, "Pesanan!A2:A");
      const existing = ids.findIndex(r => String(r[0] || "").trim() === String(order.order_id));
      if (existing >= 0) {
        rowNumber = existing + 2;
        await setLegacyRowTransactional(env, order.order_id, rowNumber);
        await updateSheetRange(env, "Pesanan!A" + rowNumber + ":T" + rowNumber, [row]);
        return rowNumber;
      }
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
async function dispatchSheetsMirrorOutbox(env, limit = 20) {
  const events = await claimSheetMirrorOutbox(env, limit);
  let delivered = 0, retried = 0, failed = 0;
  for (const event of events) {
    try {
      if (event.event_type === "CATALOG_MIRROR") {
        const product = await findProductTransactional(env, event.aggregate_id);
        if (!product || !(await mirrorTransactionalProduct(env, product))) {
          throw new Error("Katalog produk belum berhasil dicerminkan ke Google Sheets.");
        }
      } else {
        const order = await findOrderTransactional(env, event.aggregate_id);
        if (!order) throw new Error("Order untuk event mirror tidak ditemukan.");
        const rowNumber = await mirrorTransactionalOrder(env, order, { recoverAppend: true });
        if (!rowNumber || rowNumber < 2) throw new Error("Google Sheets belum mengonfirmasi lokasi baris order.");
      }
      if (!(await completeSheetMirrorOutbox(env, event))) throw new Error("Lease outbox berubah sebelum event selesai dicatat.");
      delivered++;
    } catch (error) {
      try {
        const saved = await failSheetMirrorOutbox(env, event, error);
        if (saved && Number(event.attempts) >= 8) failed++;
        else if (saved) retried++;
      } catch (retryError) {
        console.error(JSON.stringify({level:"error",event:"sheet_mirror_outbox_state",outbox_id:event.id,message:retryError.message}));
      }
    }
  }
  return {claimed:events.length,delivered,retried,failed};
}
async function mirrorTransactionalProduct(env, product) {
  try {
    const range = "Katalog_Produk!A2:G";
    const rows = await readSheet(env, range);
    const index = rows.findIndex(r => String(r[0] || "").trim().toUpperCase() === String(product.sku).toUpperCase());
    const photoForSheet = isProductMediaKey(product.photo_url) ? "" : (product.photo_url || "");
    const values = [[product.sku,product.name,product.price,product.stock == null ? "" : product.stock,
      Boolean(product.active),photoForSheet,product.description || ""]];
    if (index >= 0) await updateSheetRange(env,"Katalog_Produk!A"+(index+2)+":G"+(index+2),values);
    else await appendSheetRows(env,"Katalog_Produk!A:G",values);
    return true;
  } catch(error) {
    console.warn(JSON.stringify({level:"warn",event:"catalog_sheet_mirror",sku:product.sku,message:error.message}));
    return false;
  }
}

export default {
  async scheduled(controller, env) {
    try {
      await pruneAdminLoginAttempts(env);
    } catch {
      console.warn(JSON.stringify({ level:"warn", event:"admin_login_attempt_cleanup_failed" }));
    }
    try {
      await pruneAdminWebSessions(env);
    } catch {
      console.warn(JSON.stringify({ level:"warn", event:"admin_web_session_cleanup_failed" }));
    }
    if (await messagingCoreReady(env)) {
      const messaging = await dispatchTelegramMessagingOutbox(env, 20);
      if (messaging.claimed) {
        console.log(JSON.stringify({level:"info",event:"messaging_outbox_batch",cron:controller.cron,...messaging}));
      }
    }
    const state = await transactionReadiness(env);
    if (!state.ready) return;
    const result = await dispatchSheetsMirrorOutbox(env, 20);
    if (result.claimed) {
      console.log(JSON.stringify({level:"info",event:"sheet_mirror_outbox_batch",cron:controller.cron,...result}));
    }
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/pickup") {
      return handlePickupVerificationPage(request, env);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
      return new Response(ADMIN_DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self' https://cdn.jsdelivr.net; img-src 'self' https: blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/login") return handleAdminLogin(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/session/revoke") return handleAdminWebSessionRevoke(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/payment") return handleAdminPaymentAction(request, env);
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/")) {
      let key;
      try { key = decodeURIComponent(url.pathname.slice("/media/".length)); }
      catch { return new Response("Not Found", { status: 404 }); }
      return serveProductMedia(request,env.PRODUCT_MEDIA,key);
    }
    if (request.method === "POST" && url.pathname === "/api/admin/products") return handleAdminProductMutation(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/products/photo") return handleAdminProductPhotoUpload(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/order-status") return handleAdminOrderStatus(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/proof") return handleAdminPaymentProof(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/data") {
      return handleAdminDashboardData(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/admin/activity-audit") {
      return handleAdminActivityAudit(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/admin/export") {
      return handleAdminDashboardExport(request, env);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const tx = await transactionReadiness(env);
      return json({ ok: true, service: "seiton-order-bot",
        transaction_store: tx.ready ? "READY" : tx.configured ? "MIGRATION_REQUIRED" : "LEGACY",
        time: new Date().toISOString() });
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
    if (isAdmin(chatId, env) && message.reply_to_message?.text?.startsWith("📷 UPLOAD FOTO PRODUK SEITON")) {
      try {
        await handleTelegramProductPhotoUpload(
          env,message,chatId,customerId,message.reply_to_message.text
        );
      } catch(error) {
        await sendTelegram(env,chatId,"⚠️ "+error.message+"\nSilakan kirim ulang foto yang valid.");
      }
      return;
    }
    if (isAdmin(chatId, env) && message.reply_to_message?.text?.startsWith("📝 FORM PRODUK SEITON")) {
      try { await handleAdminProductForm(env, chatId, customerId, text, message.reply_to_message.text); }
      catch (error) { await sendTelegram(env, chatId, "⚠️ " + error.message + "\\nSilakan kirim ulang dengan format yang benar."); }
      return;
    }
    const handoffCommand = parseMessagingAdminCommand(text);
    if (handoffCommand.kind !== "UNKNOWN") {
      if (!isAdmin(chatId, env)) {
        await sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
        return;
      }
      if (handoffCommand.kind === "INVALID") {
        await sendTelegram(env, chatId,
          "⚠️ Format perintah tidak valid. Gunakan /handoff, /handoff_claim ID, /handoff_reply ID pesan, atau /handoff_close ID.");
        return;
      }
      if (!(await messagingHandoffSchemaReady(env))) {
        await sendTelegram(env, chatId,
          "⚠️ Fitur pengelolaan bantuan belum aktif. Pastikan migrasi D1 0004, 0005, dan 0006 sudah diterapkan.");
        return;
      }
      try {
        if (handoffCommand.kind === "HANDOFF_LIST") {
          await showTelegramHandoffQueue(env, { chat: { id: chatId } }, chatId);
          return;
        }
        if (handoffCommand.kind === "HANDOFF_CLAIM") {
          const result = await claimMessagingHandoff(env, handoffCommand.handoffId, chatId);
          if (result.ok && !result.alreadyClaimed) await recordAdminActivity(env, { actorId: customerId, action: "HANDOFF_CLAIMED", resourceType: "support_handoff", resourceId: handoffCommand.handoffId, summary: { handoff_id: handoffCommand.handoffId } });
          if (result.ok) {
            await sendTelegram(env, chatId,
              (result.alreadyClaimed ? "ℹ️ Kasus ini sudah diambil oleh Anda." : "✅ Kasus berhasil diambil.") +
              "\nPelanggan: " + (result.handoff?.customer_name || "-") +
              "\nBalas dengan: /handoff_reply " + handoffCommand.handoffId + " pesan Anda" +
              "\nSelesaikan dengan: /handoff_close " + handoffCommand.handoffId);
          } else {
            const messageByReason = {
              NOT_FOUND: "Kasus bantuan tidak ditemukan.",
              CLOSED: "Kasus bantuan sudah ditutup.",
              CLAIMED_BY_OTHER: "Kasus ini sedang ditangani admin lain: " + (result.handoff?.claimed_by || "-"),
              CONFLICT: "Status kasus berubah. Jalankan /handoff untuk memuat ulang antrean."
            };
            await sendTelegram(env, chatId, "⚠️ " + (messageByReason[result.reason] || "Kasus tidak dapat diambil."));
          }
          return;
        }
        if (handoffCommand.kind === "HANDOFF_REPLY") {
          const result = await queueMessagingHandoffReply(
            env, handoffCommand.handoffId, chatId, handoffCommand.message
          );
          if (!result.ok) {
            const messageByReason = {
              NOT_FOUND: "Kasus bantuan tidak ditemukan.",
              CLOSED: "Kasus sudah ditutup. Balasan tidak dikirim.",
              NOT_CLAIMED: "Ambil kasus terlebih dahulu dengan /handoff_claim ID.",
              CLAIMED_BY_OTHER: "Kasus ini sedang dipegang admin lain: " + (result.handoff?.claimed_by || "-"),
              CHANNEL_NOT_CONNECTED: "Kanal pelanggan belum memiliki pengirim aktif."
            };
            await sendTelegram(env, chatId, "⚠️ " + (messageByReason[result.reason] || "Balasan tidak dapat diantrikan."));
            return;
          }
          await recordAdminActivity(env, { actorId: customerId, action: "HANDOFF_REPLY_QUEUED", resourceType: "support_handoff", resourceId: handoffCommand.handoffId, summary: { handoff_id: handoffCommand.handoffId, message_characters: handoffCommand.message.length } });
          await dispatchTelegramMessagingOutbox(env, 50);
          await sendTelegram(env, chatId,
            "✅ Balasan admin dimasukkan ke antrean pengiriman Telegram untuk pelanggan " +
            (result.handoff?.customer_name || "") + ". Perintah pengiriman langsung sudah dijalankan; kegagalan sementara akan dicoba ulang otomatis.");
          return;
        }
        if (handoffCommand.kind === "HANDOFF_CLOSE") {
          const result = await closeMessagingHandoff(env, handoffCommand.handoffId, chatId);
          if (result.ok && !result.alreadyClosed) await recordAdminActivity(env, { actorId: customerId, action: "HANDOFF_RESOLVED", resourceType: "support_handoff", resourceId: handoffCommand.handoffId, summary: { handoff_id: handoffCommand.handoffId, resolution: "RESOLVED" } });
          if (!result.ok) {
            const messageByReason = {
              NOT_FOUND: "Kasus bantuan tidak ditemukan.",
              CLAIMED_BY_OTHER: "Kasus ini sedang dipegang admin lain: " + (result.handoff?.claimed_by || "-"),
              CONFLICT: "Status kasus berubah. Jalankan /handoff untuk memuat ulang antrean."
            };
            await sendTelegram(env, chatId, "⚠️ " + (messageByReason[result.reason] || "Kasus tidak dapat ditutup."));
          } else if (result.alreadyClosed) {
            await sendTelegram(env, chatId, "ℹ️ Kasus bantuan tersebut sudah berstatus ditutup.");
          } else if (result.automationResumed) {
            await sendTelegram(env, chatId, "✅ Kasus ditutup. Balasan otomatis BOT diaktifkan kembali untuk percakapan tersebut.");
          } else if (result.conversationMode === "OPTED_OUT") {
            await sendTelegram(env, chatId, "✅ Kasus ditutup. Pelanggan sebelumnya menonaktifkan balasan otomatis, sehingga mode STOP tetap dipertahankan.");
          } else {
            await sendTelegram(env, chatId, "✅ Kasus ditutup. Percakapan tetap dalam penanganan admin karena masih ada permintaan bantuan aktif lainnya.");
          }
          return;
        }
      } catch (error) {
        console.error(JSON.stringify({level:"error",event:"messaging_handoff_admin",message:error.message}));
        await sendTelegram(env, chatId, "⚠️ Operasi bantuan gagal. Periksa status migrasi D1 dan coba kembali.");
        return;
      }
    }
    if (text === "/migrasi_d1") {
      if (!isAdmin(chatId,env)) return sendTelegram(env,chatId,"⛔ Perintah ini khusus admin.");
      if (!env.DB || !env.ORDER_COORDINATOR) return sendTelegram(env,chatId,"⚠️ Binding D1/ORDER_COORDINATOR belum tersedia. Migrasi belum dapat dijalankan.");
      const state = await transactionReadiness(env);
      if (state.ready) return sendTelegram(env,chatId,"✅ Lapisan transaksi D1 sudah aktif. Tidak ada migrasi ulang yang diperlukan.");
      await ensurePaymentWorkflowHeaders(env);
      const [catalogRows,orderRows] = await Promise.all([
        readSheet(env,"Katalog_Produk!A2:G"),
        readSheet(env,"Pesanan!A2:T")
      ]);
      const result = await bootstrapTransactions(env.DB,catalogRows,orderRows);
      await recordAdminActivity(env, { actorId: customerId, action: "D1_MIGRATION_COMPLETED", resourceType: "transaction_store", summary: { catalog_imported: result.catalog, historical_orders_imported: result.orders } });
      await sendTelegram(env,chatId,
        "✅ Migrasi transaksi D1 selesai.\nProduk diimpor: "+result.catalog+
        "\nOrder historis diimpor: "+result.orders+
        "\n\nOrder lama tidak mengurangi stok ulang. Checkout baru kini memakai D1 dan reservasi stok atomik.");
      return;
    }
    if (text.startsWith("/laporan")) {
      if (!isAdmin(chatId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const report = await buildAdminReport(env);
      await recordAdminActivity(env, { actorId: customerId, action: "REPORT_GENERATED", resourceType: "sales_report", summary: { report_type: "sales_summary" } });
      await sendTelegram(env, chatId, report);
      return;
    }
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const admin = isAdmin(chatId, env);
      if (admin) {
        await sendTelegram(env, chatId, adminMenuText(), adminMenuKeyboard());
        await recordAdminActivity(env, {
          actorId: customerId, action: "ADMIN_MENU_OPENED", resourceType: "admin_menu",
          summary: { entry_point: text.startsWith("/start") ? "start" : "help" }
        });
        return;
      }
      if (message.chat.type && message.chat.type !== "private") return;
      if (await messagingCoreReady(env)) {
        const messagingText = text.startsWith("/start") ? "START" : "MENU";
        const event = telegramMessagingEvent(update, message, messagingText);
        await processMessagingEvent(env, event, createMessagingServices(env));
        await dispatchTelegramMessagingOutbox(env, 20);
      } else {
        await sendTelegram(env, chatId, customerMenuText(), customerMenuKeyboard());
      }
      return;
    }
    if (!isAdmin(chatId, env)) {
      if (message.chat.type && message.chat.type !== "private") return;
      if (await messagingCoreReady(env)) {
        const event = telegramMessagingEvent(update, message, text);
        await processMessagingEvent(env, event, createMessagingServices(env));
        await dispatchTelegramMessagingOutbox(env, 20);
        return;
      }

      // Migration is additive but must be applied before Messaging Core is enabled.
      // Preserve the previous Telegram ordering flow until the messaging tables exist.
      const legacyOrderInput = parseOrderText(text);
      if (!legacyOrderInput) {
        await sendTelegram(env, chatId,
          "🛍️ *Selamat datang di Seiton.id!*\\n\\n" +
          "Format pesanan:\\n`beli SKU jumlah metode_pembayaran`\\n" +
          "Contoh: `beli SEI-001 2 QRIS`\\n\\n" +
          "Ketik /help untuk bantuan.");
        return;
      }
      const legacyResult = await createOrder(env, {
        ...legacyOrderInput, channel: "telegram", customerId, customerName,
        idempotencyKey: String(update.update_id ?? (chatId + ":" + message.message_id))
      });
      await sendTelegram(env, chatId, orderConfirmation(legacyResult, env), orderConfirmationKeyboard(legacyResult));
      return;
    }
    const orderInput = parseOrderText(text);
    if (!orderInput) {
      await sendTelegram(env, chatId,
        "🛍️ *Selamat datang di Seiton.id!*\\n\\n" +
        "Format pesanan:\\n`beli SKU jumlah metode_pembayaran`\\n" +
        "Contoh: `beli SEI-001 2 QRIS`\\n\\n" +
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
    [{ text: "🆘 Bantuan Pelanggan", callback_data: "adm:handoff" }],
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
    const currentPhoto = isProductMediaKey(product[5]) ? "__KEEP__" : (product[5] || "");
    current = "DATA SAAT INI:\n" + [product[0] || "", product[1] || "", product[2] ?? 0, product[3] ?? 0, product[4] ?? "TRUE", currentPhoto, product[6] || ""].join(" | ") + "\n\n";
  }
  const guide = [
    intro,
    current + "Kirim satu pesan dengan 7 kolom dipisahkan tanda |",
    "SKU | Nama Produk | Harga | Stok | Aktif(TRUE/FALSE) | URL_FOTO / __KEEP__ / __REMOVE__ | Deskripsi",
    mode === "ADD" ? "Contoh: SEI-002 | Kaos Seiton | 99000 | 20 | TRUE |  | Kaos cotton combed" :
      "Salin data saat ini lalu ubah bagian yang diperlukan. SKU harus tetap sama. Gunakan __KEEP__ untuk mempertahankan foto R2, __REMOVE__ untuk menghapus, atau URL HTTPS untuk foto eksternal. Upload foto baru melalui tombol Upload Foto pada katalog admin.",
    "Gunakan angka 0 untuk stok habis. Deskripsi maksimal 500 karakter dan tanpa tanda |."
  ].join("\n");
  await sendTelegram(env, chatId, guide, { force_reply: true, input_field_placeholder: "SKU | Nama | Harga | Stok | TRUE/FALSE | URL foto | Deskripsi" });
}
async function handleAdminProductForm(env, chatId, actorId, input, prompt) {
  const parts = String(input || "").split("|").map(v => v.trim());
  if (parts.length !== 7) throw new Error("Format produk harus berisi tepat 7 kolom dipisahkan tanda |");
  const [sku, name, price, stock, activeText, photoUrl, description] = parts;
  if (!["TRUE","FALSE","YA","TIDAK","1","0","AKTIF","NONAKTIF"].includes(activeText.toUpperCase())) throw new Error("Status aktif harus TRUE atau FALSE.");
  if (photoUrl && !["__KEEP__","__REMOVE__"].includes(photoUrl) &&
      !isProductMediaKey(photoUrl) &&
      (!/^https:\/\//i.test(photoUrl) || photoUrl.length > 1000)) {
    throw new Error("Foto harus berupa URL HTTPS atau __KEEP__/__REMOVE__.");
  }
  const result = await saveCatalogProduct(env, {
    sku, name, price, stock,
    active: !["FALSE","TIDAK","0","NONAKTIF"].includes(activeText.toUpperCase()),
    photo_url: photoUrl, description
  }, prompt.includes(" — EDIT — ") ? prompt.split(" — EDIT — ").pop().trim() : "");
  await recordAdminActivity(env, { actorId, action: result === "updated" ? "PRODUCT_UPDATED" : "PRODUCT_CREATED", resourceType: "product", resourceId: sku, summary: { sku, name: String(name).slice(0, 100), price: Number(price), stock: stock === "" ? null : Number(stock), active: !["FALSE","TIDAK","0","NONAKTIF"].includes(activeText.toUpperCase()) } });
  await sendTelegram(env, chatId, "✅ Produk " + sku + (result === "updated" ? " berhasil diperbarui." : " berhasil ditambahkan."), adminMenuKeyboard());
}

async function saveCatalogProduct(env, product, originalSku = "") {
  const sku = String(product.sku || "").trim();
  const name = String(product.name || "").trim();
  const priceText = product.price == null ? "" : String(product.price).trim();
  const stockText = product.stock == null ? "" : String(product.stock).trim();
  const price = Number(priceText), stock = stockText === "" ? null : Number(stockText);
  const photoInput = String(product.photo_url || "").trim();
  const description = String(product.description || "").trim();

  if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new Error("SKU hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung (maksimal 40 karakter).");
  if (!name || name.length > 100) throw new Error("Nama produk wajib diisi (maksimal 100 karakter).");
  if (priceText === "" || !Number.isSafeInteger(price) || price < 0 ||
      (stock !== null && (!Number.isSafeInteger(stock) || stock < 0))) {
    throw new Error("Harga harus valid dan stok harus bilangan bulat nol atau lebih.");
  }
  if (typeof product.active !== "boolean") throw new Error("Status aktif harus boolean.");
  if (photoInput && !["__KEEP__", "__REMOVE__"].includes(photoInput) &&
      !isProductMediaKey(photoInput) &&
      (!/^https:\/\//i.test(photoInput) || photoInput.length > 1000)) {
    throw new Error("Foto harus berupa URL HTTPS, key foto R2 yang valid, atau pilihan tetap/hapus.");
  }
  if (description.length > 500) throw new Error("Deskripsi maksimal 500 karakter.");

  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1 terlebih dahulu.");
  if (state.ready) {
    const lookupSku = originalSku || sku;
    const previous = await findProductTransactional(env,lookupSku);
    const previousPhoto = String(previous?.photo_url || "");
    const photo = photoInput === "__KEEP__"
      ? previousPhoto
      : photoInput === "__REMOVE__"
        ? ""
        : photoInput;
    if (isProductMediaKey(photo) && !env.PRODUCT_MEDIA) {
      throw new Error("Binding R2 PRODUCT_MEDIA belum tersedia.");
    }
    const result = await saveProductTransactional(env,{
      sku,name,price,stock,active:product.active,photo_url:photo,description
    },originalSku);
    if (isProductMediaKey(previousPhoto) && previousPhoto !== photo) {
      try {
        await deleteProductMediaObject(env.PRODUCT_MEDIA,previousPhoto);
      } catch (error) {
        console.warn(JSON.stringify({
          level:"warn",event:"product_media_old_object_cleanup_failed",
          sku,message:String(error?.message||error).slice(0,240)
        }));
      }
    }
    try {
      const stored = await findProductTransactional(env,sku);
      await mirrorTransactionalProduct(env,stored);
    } catch (error) {
      console.warn(JSON.stringify({
        level:"warn",event:"product_media_post_commit_mirror_failed",
        sku,message:String(error?.message||error).slice(0,240)
      }));
    }
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

  const previousPhoto = editing ? String(rows[index][5] || "") : "";
  const photo = photoInput === "__KEEP__" ? previousPhoto : photoInput === "__REMOVE__" ? "" : photoInput;
  if (isProductMediaKey(photo)) throw new Error("Upload foto R2 memerlukan lapisan transaksi D1 yang aktif.");
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

  if (data.startsWith("hf:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, {
        text: "⛔ Tombol antrean bantuan khusus admin.",
        replyMarkup: null,
        clearMedia: true
      });
      return;
    }
    const parts = data.split(":");
    const action = parts[1];
    const handoffId = parts.slice(2).join(":");
    if (!["take", "done", "decline"].includes(action) || !handoffId) {
      await showTelegramHandoffQueue(env, message, chatId, "⚠️ Tombol tidak valid. Perbarui antrean.");
      return;
    }

    if (!(await messagingHandoffSchemaReady(env))) {
      await showTelegramHandoffQueue(env, message, chatId, "⚠️ Fitur bantuan belum aktif.");
      return;
    }

    let result;
    try {
      if (action === "take") {
        result = await claimMessagingHandoff(env, handoffId, chatId);
      } else if (action === "done") {
        result = await resolveMessagingHandoff(env, handoffId, chatId);
      } else {
        result = await declineMessagingHandoff(env, handoffId, chatId);
      }
    } catch (error) {
      console.error(JSON.stringify({level:"error",event:"telegram_handoff_action",message:error.message}));
      await showTelegramHandoffQueue(env, message, chatId, "⚠️ Aksi tidak berhasil. Coba perbarui antrean.");
      return;
    }

    if (result.ok && !result.alreadyClosed && !(action === "take" && result.alreadyClaimed)) {
      const actions = { take: "HANDOFF_CLAIMED", done: "HANDOFF_RESOLVED", decline: "HANDOFF_DECLINED" };
      await recordAdminActivity(env, { actorId: userId, action: actions[action], resourceType: "support_handoff", resourceId: handoffId, summary: { handoff_id: handoffId, resolution: action === "decline" ? "DECLINED" : action === "done" ? "RESOLVED" : null } });
    }
    if (result.ok) {
      if (action === "decline" && result.noticeQueued) {
        await dispatchTelegramMessagingOutbox(env, 50);
      }
      let notice;
      if (result.alreadyClosed) {
        notice = result.resolution === "DECLINED"
          ? "ℹ️ Permintaan bantuan ini sudah ditolak sebelumnya."
          : "ℹ️ Permintaan bantuan ini sudah diselesaikan sebelumnya.";
      } else if (action === "take") {
        notice = result.alreadyClaimed
          ? "ℹ️ Kasus ini sudah Anda ambil."
          : "✅ Kasus berhasil Anda terima. Anda sekarang menjadi admin penanggung jawab.";
      } else if (action === "done") {
        notice = result.automationResumed
          ? "✅ Bantuan selesai. Bot otomatis aktif kembali untuk pelanggan."
          : result.conversationMode === "OPTED_OUT"
            ? "✅ Bantuan selesai. Preferensi STOP pelanggan tetap berlaku."
            : "✅ Kasus diselesaikan, tetapi percakapan masih memiliki permintaan bantuan lain.";
      } else {
        notice = result.conversationMode === "OPTED_OUT"
          ? "❌ Permintaan ditolak. Pelanggan diberi tahu; preferensi STOP tetap berlaku sehingga balasan otomatis tetap nonaktif."
          : result.automationResumed
            ? "❌ Permintaan ditolak. Pelanggan diberi tahu dan bot otomatis diaktifkan kembali."
            : "❌ Permintaan ditolak. Pelanggan diberi tahu; bot tetap dijeda karena masih ada kasus aktif lain.";
      }
      await showTelegramHandoffQueue(env, message, chatId, notice);
      return;
    }

    const reason = {
      NOT_FOUND: "Kasus tidak ditemukan.",
      CLOSED: "Kasus sudah ditutup.",
      ALREADY_CLAIMED: "Kasus sudah diterima admin lain dan tidak dapat ditolak.",
      NOT_CLAIMED: "Terima kasus terlebih dahulu.",
      CLAIMED_BY_OTHER: "Kasus sedang ditangani admin lain: " + (result.handoff?.claimed_by || "-"),
      CONFLICT: "Status kasus berubah. Perbarui antrean."
    };
    await showTelegramHandoffQueue(env, message, chatId,
      "⚠️ " + (reason[result.reason] || "Aksi tidak dapat dilakukan."));
    return;
  }

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
    const rows = await readCatalogRows(env);
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
    const state = await transactionReadiness(env);
    if (!state.ready) await ensurePaymentWorkflowHeaders(env);
    const rows = state.ready
      ? (await listOrdersTransactional(env,{limit:5000})).map(orderToSheetRow)
      : await readSheet(env, "Pesanan!A2:T");
    const mine = (state.ready ? rows : rows.filter(r => String(r[3] || "") === userId).slice(-5).reverse())
      .filter(r => String(r[3] || "") === userId).slice(0,5);
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
    if (action === "handoff") {
      await showTelegramHandoffQueue(env, message, chatId);
      return;
    }
    if (action === "report") {
      const report = await buildAdminReport(env);
      await recordAdminActivity(env, { actorId: userId, action: "REPORT_GENERATED", resourceType: "sales_report", summary: { report_type: "sales_summary" } });
      await updateTelegramMessage(env, message, { text: report, replyMarkup: adminMenuKeyboard(), clearMedia: true });
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
      await recordAdminActivity(env, { actorId: userId, action: "DASHBOARD_LINK_ISSUED", resourceType: "admin_dashboard", summary: { lifetime_minutes: 240 } });
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
      const state = await transactionReadiness(env);
      const recent = state.ready
        ? (await listOrdersTransactional(env,{limit:10})).map(o => ({r:orderToSheetRow(o),reference:o.order_id}))
        : (await readSheet(env, "Pesanan!A2:M")).map((r,i) => ({r,reference:String(i+2)})).filter(x => x.r[0]).slice(-10).reverse();
      if (!recent.length) {
        await updateTelegramMessage(env, message, { text: "Belum ada pesanan.", replyMarkup: adminMenuKeyboard() });
        return;
      }
      const buttons = recent.map(x => [{ text: String(x.r[0]).slice(0,22) + " · " + String(x.r[12] || "BARU").slice(0,18),
        callback_data: (action === "statuslist" ? "st:" : "detail:") + x.reference }]);
      buttons.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
      const summary = recent.map(x => String(x.r[0]) + " | " + String(x.r[5]) + " | " + rupiah(x.r[10]) + " | " + String(x.r[12])).join("\n");
      await updateTelegramMessage(env, message, {
        text: action === "statuslist" ? "Pilih pesanan yang statusnya ingin diperbarui:" : "10 pesanan terbaru:\n\n" + summary,
        replyMarkup: { inline_keyboard: buttons }
      });
      return;
    }
  }

  if (data.startsWith("prod:photo:")) {
    if (!admin) {
      await updateTelegramMessage(env,message,{
        text:"⛔ Upload foto produk khusus admin.",replyMarkup:null,clearMedia:true
      });
      return;
    }
    const sku = data.slice("prod:photo:".length).trim();
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new Error("SKU produk tidak valid.");
    await promptAdminProductPhoto(env,chatId,sku);
    return;
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
      text: "Yakin ingin menghapus produk " + sku + "? Produk akan dinonaktifkan agar riwayat pesanan tetap utuh.",
      replyMarkup: { inline_keyboard: [
        [{ text: "🗑️ Ya, arsipkan produk", callback_data: "prod:delok:" + sku }],
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
    const deletedSku = data.slice("prod:delok:".length);
    await deleteCatalogProduct(env, deletedSku);
    await recordAdminActivity(env, { actorId: userId, action: "PRODUCT_DELETED", resourceType: "product", resourceId: deletedSku, summary: { sku: deletedSku } });
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
    await recordAdminActivity(env, { actorId: userId, action: "REPORT_EXPORT_SENT", resourceType: "sales_export", summary: { report_types: types } });
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
    await showPaymentRequestDetail(env, message, data.slice("payview:".length));
    return;
  }
  if (data.startsWith("payapprove:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const reference = data.slice("payapprove:".length);
    const approved = await approvePaymentAndIssueTicket(env, reference, "telegram:" + (userId || chatId));
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
    const reference = data.slice("payreject:".length);
    const rejected = await rejectPaymentRequest(env, reference, "telegram:" + (userId || chatId));
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
    await showPickupOrderDetail(env, message, data.slice("pickupview:".length));
    return;
  }
  if (data.startsWith("pickupdone:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const reference = data.slice("pickupdone:".length);
    const order = await markOrderPickedUp(env, reference, "telegram:" + (userId || chatId));
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
    const reference = data.slice("detail:".length);
    const found = await resolveOrderReference(env,reference);
    const r = found?.row;
    if (!r) throw new Error("Pesanan tidak ditemukan");
    await updateTelegramMessage(env, message, {
      text: "Detail Pesanan\nID: " + r[0] + "\nPelanggan: " + r[4] + " (" + r[3] + ")\nProduk: " + r[5] + "\nJumlah: " + r[6] + "\nTotal: " + rupiah(r[10]) + "\nPembayaran: " + r[11] + "\nStatus: " + r[12],
      replyMarkup: { inline_keyboard: [
        [{ text: "🔄 Perbarui Status", callback_data: "st:" + reference }],
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
    const reference = data.slice("st:".length);
    await updateTelegramMessage(env, message, {
      text: "Pilih status baru:",
      replyMarkup: { inline_keyboard: [
        [{ text: "Menunggu Pembayaran", callback_data: "su:" + reference + ":MENUNGGU_PEMBAYARAN" }],
        [{ text: "Dibayar", callback_data: "su:" + reference + ":DIBAYAR" }],
        [{ text: "Diproses", callback_data: "su:" + reference + ":DIPROSES" }],
        [{ text: "Dikirim", callback_data: "su:" + reference + ":DIKIRIM" }],
        [{ text: "Selesai", callback_data: "su:" + reference + ":SELESAI" }],
        [{ text: "Dibatalkan", callback_data: "su:" + reference + ":DIBATALKAN" }],
        [{ text: "⬅️ Kembali", callback_data: "detail:" + reference }]
      ] }
    });
    return;
  }

  if (data.startsWith("su:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const parts = data.split(":"); const reference = parts[1]; const status = parts[2];
    const allowed = ["MENUNGGU_PEMBAYARAN","MENUNGGU_VERIFIKASI","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"];
    if (!reference || !allowed.includes(status)) throw new Error("Pembaruan status tidak valid");
    await setOrderStatus(env, reference, status, "telegram:" + (userId || chatId));
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
  const rows = await readCatalogRows(env);
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
    photo: productMediaPublicUrl(p[5]) || null,
    clearMedia: !productMediaPublicUrl(p[5]),
    replyMarkup: keyboard
  });
}

async function showAdminCatalogPage(env, message, page = 0) {
  const rows = await readCatalogRows(env);
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
    [{ text: "📷 Upload Foto", callback_data: "prod:photo:" + sku }],
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
async function pruneAdminWebSessions(env) {
  if (!env.DB) return;
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "DELETE FROM admin_web_sessions WHERE expires_at_ms <= ? OR (revoked_at_ms IS NOT NULL AND revoked_at_ms < ?)"
  ).bind(now, cutoff).run();
}
async function adminWebSessionTokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("site-owner-session:" + String(token)));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
function webAdminPayloadFromRequest(request) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const parts = authorization.slice(7).trim().split(".");
  if (parts.length !== 2) return null;
  try {
    const encoded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
async function handleAdminActivityAudit(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ ok: false, error: "Sesi admin tidak valid atau kedaluwarsa." }, 401);
  }
  const raw = Number(new URL(request.url).searchParams.get("limit") || 30);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.floor(raw))) : 30;
  try {
    const [orderEvents, adminActivities] = await Promise.all([
      env.DB.prepare(
        "SELECT id,order_id,event_type,from_status,to_status,actor,created_at " +
        "FROM order_events WHERE event_type IN ('PAYMENT_APPROVED','PAYMENT_REJECTED','STATUS_CHANGED','PICKED_UP') " +
        "ORDER BY id DESC LIMIT ?"
      ).bind(limit).all(),
      env.DB.prepare(
        "SELECT audit_id,actor_channel,actor_id,action,resource_type,resource_id,summary_json,created_at_ms " +
        "FROM admin_activity_audit ORDER BY created_at_ms DESC LIMIT ?"
      ).bind(limit).all()
    ]);
    const adminAuditRows = adminActivities.results || [];
    const orderAuditKey = (action, resourceId, actorChannel, actorId, fromStatus, toStatus, timestamp) =>
      JSON.stringify([action, resourceId, actorChannel, actorId, fromStatus, toStatus, timestamp]);
    const auditedOrderEvents = new Set();
    for (const row of adminAuditRows) {
      if (String(row.resource_type || "") !== "order") continue;
      const action = String(row.action || "");
      if (!["PAYMENT_APPROVED", "PAYMENT_REJECTED", "STATUS_CHANGED", "PICKED_UP"].includes(action)) continue;
      let summary = {};
      try { summary = JSON.parse(row.summary_json || "{}"); } catch {}
      auditedOrderEvents.add(orderAuditKey(
        action, String(row.resource_id || ""), String(row.actor_channel || "web"),
        String(row.actor_id || ""), String(summary.from_status || ""),
        String(summary.to_status || ""), Number(row.created_at_ms || 0)
      ));
    }
    const items = (orderEvents.results || []).flatMap(row => {
      const actor = String(row.actor || "");
      const actorChannel = actor.startsWith("telegram") ? "telegram" : "web";
      const actorId = actor.startsWith("telegram:") ? actor.slice("telegram:".length) : actor;
      const timestamp = Date.parse(row.created_at || "");
      const timestampMs = Number.isFinite(timestamp) ? timestamp : 0;
      const action = String(row.event_type || "ORDER_EVENT");
      const resourceId = String(row.order_id || "");
      const fromStatus = String(row.from_status || "");
      const toStatus = String(row.to_status || "");
      if (auditedOrderEvents.has(orderAuditKey(
        action, resourceId, actorChannel, actorId, fromStatus, toStatus, timestampMs
      ))) return [];
      const fromTelegram = actor.startsWith("telegram:") || actor === "telegram-admin";
      const actorLabel = actor.startsWith("telegram:")
        ? "Telegram · " + actor.slice("telegram:".length)
        : actor === "telegram-admin" ? "Telegram Admin (riwayat lama)"
        : actor === "web-admin" ? "Panel Web" : actor || "Admin (tidak diketahui)";
      return [{
        id: "order-event:" + row.id,
        actor: actorLabel,
        actor_id: actor,
        action,
        resource: "order",
        resource_id: resourceId,
        source: fromTelegram ? "Telegram" : actor === "web-admin" ? "Panel Web" : "Admin/Legacy",
        summary: {
          event_type: action,
          from_status: fromStatus,
          to_status: toStatus,
          transition_type: action === "PAYMENT_REJECTED" ? "payment_confirmation" : "order_status"
        },
        created_at_ms: timestampMs
      }];
    });
    for (const row of adminAuditRows) {
      let summary = {};
      try { summary = JSON.parse(row.summary_json || "{}"); } catch {}
      items.push({
        id: "admin-activity:" + row.audit_id,
        actor: row.actor_channel === "telegram"
          ? "Telegram · " + String(row.actor_id || "")
          : "Panel Web · " + String(row.actor_id || ""),
        actor_id: String(row.actor_id || ""),
        action: String(row.action || "ADMIN_ACTION"),
        resource: String(row.resource_type || ""),
        resource_id: String(row.resource_id || ""),
        source: row.actor_channel === "telegram" ? "Telegram" : "Panel Web",
        summary,
        created_at_ms: Number(row.created_at_ms || 0)
      });
    }
    items.sort((a, b) => b.created_at_ms - a.created_at_ms);
    return json({ ok: true, items: items.slice(0, limit) });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error", event: "admin_activity_audit_read_failed",
      code: "ADMIN_ACTIVITY_AUDIT_READ_FAILED"
    }));
    return json({ ok: false, error: "Riwayat operasional tidak dapat dibaca." }, 503);
  }
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
    if (!validTime) return false;
    if (payload.v === 1) return isAdmin(payload.sub, env);
    if (payload.v === 2 && payload.scope === "admin-dashboard" && payload.sub === "web-admin" && env.DB) {
      const tokenHash = await adminWebSessionTokenHash(token);
      const session = await env.DB.prepare(
        "SELECT expires_at_ms, revoked_at_ms FROM admin_web_sessions WHERE token_hash = ? LIMIT 1"
      ).bind(tokenHash).first();
      return Boolean(session && Number(session.expires_at_ms) > Date.now() &&
        (session.revoked_at_ms === null || session.revoked_at_ms === undefined));
    }
    return false;
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
const ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 5;

async function adminLoginClientKey(request, env) {
  const clientIp = String(request.headers.get("CF-Connecting-IP") || "").trim();
  if (!clientIp || !env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("ADMIN_LOGIN_CLIENT_ID_UNAVAILABLE");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("SEITON_ADMIN_LOGIN_CLIENT_V1." + clientIp)
  );
  return base64urlBytes(new Uint8Array(signature));
}

async function getAdminLoginLockout(env, clientKey, now = Date.now()) {
  const row = await env.DB.prepare(
    "SELECT blocked_until_ms FROM admin_login_attempts WHERE client_key = ? LIMIT 1"
  ).bind(clientKey).first();
  const blockedUntil = Number(row?.blocked_until_ms || 0);
  return {
    blocked: blockedUntil > now,
    retryAfterSeconds: blockedUntil > now ? Math.max(1, Math.ceil((blockedUntil - now) / 1000)) : 0
  };
}

async function recordAdminLoginFailure(env, clientKey, now = Date.now()) {
  const cutoff = now - ADMIN_LOGIN_FAILURE_WINDOW_MS;
  return env.DB.prepare(`
    INSERT INTO admin_login_attempts (
      client_key, window_started_ms, failed_attempts, blocked_until_ms, updated_at_ms
    ) VALUES (?, ?, 1, 0, ?)
    ON CONFLICT(client_key) DO UPDATE SET
      window_started_ms = CASE
        WHEN admin_login_attempts.window_started_ms <= ? THEN excluded.window_started_ms
        ELSE admin_login_attempts.window_started_ms
      END,
      failed_attempts = CASE
        WHEN admin_login_attempts.window_started_ms <= ? THEN 1
        ELSE MIN(admin_login_attempts.failed_attempts + 1, ?)
      END,
      blocked_until_ms = CASE
        WHEN (
          CASE
            WHEN admin_login_attempts.window_started_ms <= ? THEN 1
            ELSE MIN(admin_login_attempts.failed_attempts + 1, ?)
          END
        ) >= ? THEN excluded.updated_at_ms + ?
        ELSE 0
      END,
      updated_at_ms = excluded.updated_at_ms
    RETURNING failed_attempts, blocked_until_ms
  `).bind(
    clientKey,
    now,
    now,
    cutoff,
    cutoff,
    ADMIN_LOGIN_MAX_FAILURES,
    cutoff,
    ADMIN_LOGIN_MAX_FAILURES,
    ADMIN_LOGIN_MAX_FAILURES,
    ADMIN_LOGIN_LOCKOUT_MS
  ).first();
}

async function clearAdminLoginFailures(env, clientKey) {
  await env.DB.prepare(
    "DELETE FROM admin_login_attempts WHERE client_key = ?"
  ).bind(clientKey).run();
}

async function pruneAdminLoginAttempts(env) {
  if (!env.DB) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "DELETE FROM admin_login_attempts WHERE updated_at_ms < ?"
  ).bind(cutoff).run();
}

function adminLoginRateLimited(retryAfterSeconds) {
  const retry = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 60));
  const response = json({
    ok: false,
    error: "Terlalu banyak percobaan login. Silakan coba kembali setelah jeda."
  }, 429);
  const headers = new Headers(response.headers);
  headers.set("Retry-After", String(retry));
  return new Response(response.body, { status: 429, headers });
}

async function handleAdminLogin(request, env) {
  if (request.method !== "POST" || !env.ADMIN_WEB_PASSWORD) {
    return json({ ok:false, error:"Login dashboard belum dikonfigurasi." }, 503);
  }
  if (!env.DB || !env.ADMIN_LOGIN_RATE_LIMITER || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok:false, error:"Login sementara tidak tersedia." }, 503);
  }

  let stage = "client_key";
  try {
    const clientKey = await adminLoginClientKey(request, env);
    stage = "cloudflare_rate_limit";
    const rate = await env.ADMIN_LOGIN_RATE_LIMITER.limit({ key: clientKey });
    if (!rate.success) {
      console.warn(JSON.stringify({ level:"warn", event:"admin_login_rate_limited", source:"cloudflare" }));
      return adminLoginRateLimited(60);
    }

    const now = Date.now();
    stage = "d1_lockout_lookup";
    const lockout = await getAdminLoginLockout(env, clientKey, now);
    if (lockout.blocked) {
      console.warn(JSON.stringify({ level:"warn", event:"admin_login_rate_limited", source:"failed_attempt_lockout" }));
      return adminLoginRateLimited(lockout.retryAfterSeconds);
    }

    let body;
    stage = "parse_login_body";
    try {
      body = await request.json();
    } catch {
      return json({ok:false,error:"Format login tidak valid."},400);
    }
    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length > 1024 || !constantTimeEqual(password, String(env.ADMIN_WEB_PASSWORD))) {
      stage = "d1_record_failure";
      const failure = await recordAdminLoginFailure(env, clientKey, now);
      const blockedUntil = Number(failure?.blocked_until_ms || 0);
      if (blockedUntil > now) {
        console.warn(JSON.stringify({ level:"warn", event:"admin_login_rate_limited", source:"failed_attempt_lockout" }));
        return adminLoginRateLimited(Math.ceil((blockedUntil - now) / 1000));
      }
      return json({ ok:false, error:"Kredensial tidak valid." }, 401);
    }

    stage = "d1_clear_failures";
    await clearAdminLoginFailures(env, clientKey);
    stage = "create_admin_session";
    const token = await createWebAdminSessionToken(env);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 28800 * 1000;
    const tokenHash = await adminWebSessionTokenHash(token);
    const sessionId = crypto.randomUUID();
    stage = "persist_admin_session";
    await env.DB.prepare(
      "INSERT INTO admin_web_sessions(session_id, token_hash, issued_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)"
    ).bind(sessionId, tokenHash, issuedAt, expiresAt).run();
    return json({ ok:true, token, expires_in:28800 });
  } catch (error) {
    console.error(JSON.stringify({
      level:"error",
      event:"admin_login_security_dependency",
      stage,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_code: error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message) ? error.message : "UNEXPECTED",
      client_ip_header_present: Boolean(request.headers.get("CF-Connecting-IP")),
      real_ip_header_present: Boolean(request.headers.get("X-Real-IP")),
      forwarded_for_header_present: Boolean(request.headers.get("X-Forwarded-For")),
      webhook_secret_configured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
      message:"Login security dependency unavailable"
    }));
    return json({ ok:false, error:"Login sementara tidak tersedia." }, 503);
  }
}
async function handleAdminWebSessionRevoke(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ ok:false, error:"Sesi admin tidak valid atau kedaluwarsa." }, 401);
  }
  const payload = webAdminPayloadFromRequest(request);
  if (!payload || payload.v !== 2 || payload.scope !== "admin-dashboard" || payload.sub !== "web-admin") {
    return json({ ok:false, error:"Hanya sesi panel pemilik yang dapat mencabut sesi web." }, 403);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ ok:false, error:"Format permintaan pencabutan sesi tidak valid." }, 400); }
  const tokenHash = String(body?.token_hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
    return json({ ok:false, error:"Fingerprint sesi tidak valid." }, 400);
  }
  const now = Date.now();
  const revoked = await env.DB.prepare(
    "UPDATE admin_web_sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ? RETURNING session_id"
  ).bind(now, tokenHash, now).first();
  if (!revoked) return json({ ok:false, error:"Sesi tidak ditemukan, kedaluwarsa, atau sudah dicabut." }, 404);
  return json({ ok:true, revoked:true });
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
      const approved=await approvePaymentAndIssueTicket(env,found.rowNumber ?? body.order_id,"web-admin");
      let receiptSent = true;
      try { await sendPickupReceipt(env,String(approved.row[3]),approved.row,String(approved.row[0]),approved.receiptCode); }
      catch(error) {
        receiptSent = false;
        console.error(JSON.stringify({level:"error",event:"dashboard_receipt_delivery",order_id:approved.row[0],message:error.message}));
      }
      return json({ok:true,status:"DIBAYAR",receipt_code:approved.receiptCode,receipt_sent:receiptSent});
    }
    if (body.action==="reject") {
      const rejected=await rejectPaymentRequest(env,found.rowNumber ?? body.order_id,"web-admin");
      try { await sendTelegram(env,String(rejected[3]),"⚠️ Permintaan verifikasi pembayaran untuk "+rejected[0]+" belum dapat disetujui. Periksa kembali bukti dan nominal pembayaran, lalu ajukan ulang dari menu Pesanan Saya.",{inline_keyboard:[[{text:"🔁 Ajukan Verifikasi Ulang",callback_data:"pc:req:"+rejected[0]}]]}); } catch (error) { console.warn(JSON.stringify({level:"warn",event:"dashboard_payment_rejection_notice",message:error.message})); }
      return json({ok:true,status:"DITOLAK"});
    }
    return json({ok:false,error:"Aksi pembayaran tidak dikenal."},400);
  } catch(error) { return json({ok:false,error:error.message},400); }
}
async function handleAdminProductPhotoUpload(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  }
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_PRODUCT_IMAGE_BYTES + 128 * 1024) {
    return json({ok:false,error:"Ukuran gambar produk maksimal 5 MB."},413);
  }
  const state = await transactionReadiness(env);
  if (!state.ready) {
    return json({ok:false,error:"Upload foto R2 membutuhkan transaction store D1 berstatus READY."},503);
  }
  if (!env.PRODUCT_MEDIA) {
    return json({ok:false,error:"Binding R2 PRODUCT_MEDIA belum tersedia."},503);
  }
  let uploaded = null;
  try {
    const form = await request.formData();
    const image = form.get("image");
    if (!image || typeof image.arrayBuffer !== "function" || !Number.isFinite(Number(image.size))) {
      throw new Error("Pilih file gambar JPEG, PNG, atau WebP terlebih dahulu.");
    }
    if (Number(image.size) < 1 || Number(image.size) > MAX_PRODUCT_IMAGE_BYTES) {
      throw new Error("Ukuran gambar produk maksimal 5 MB.");
    }
    const product = {
      sku: String(form.get("sku") || "").trim(),
      name: String(form.get("name") || "").trim(),
      price: String(form.get("price") ?? "").trim(),
      stock: String(form.get("stock") ?? "").trim(),
      active: String(form.get("active") || "").toLowerCase() === "true",
      description: String(form.get("description") || ""),
      photo_url: ""
    };
    const originalSku = String(form.get("original_sku") || "").trim();
    const bytes = new Uint8Array(await image.arrayBuffer());
    const persisted = await uploadThenPersistProductImage(
      env.PRODUCT_MEDIA,bytes,image.type || "","admin",
      key => saveCatalogProduct(env,{...product,photo_url:key},originalSku)
    );
    uploaded = persisted.uploaded;
    const result = persisted.result;
    await recordAdminActivity(env, {
      actorChannel:"web",actorId:"web-admin",
      action:"PRODUCT_IMAGE_UPDATED",resourceType:"product",resourceId:product.sku,
      summary:{sku:product.sku,content_type:uploaded.contentType,size:uploaded.size}
    }).catch(error => console.warn(JSON.stringify({
      level:"warn",event:"product_media_audit_failed",
      message:String(error?.message||error).slice(0,200)
    })));
    return json({
      ok:true,sku:product.sku,action:result,
      photo_url:productMediaPublicUrl(uploaded.key,new URL(request.url).origin)
    });
  } catch(error) {
    const status = /maksimal 5 MB|Ukuran gambar/i.test(error.message) ? 413 : 400;
    return json({ok:false,error:error.message},status);
  }
}

function telegramProductImageDescriptor(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    return {
      fileId:String(photo.file_id || ""),
      size:Number(photo.file_size || 0),
      declaredMime:""
    };
  }
  if (message.document?.file_id) {
    const mime = String(message.document.mime_type || "").toLowerCase().split(";")[0].trim();
    if (mime && !["image/jpeg","image/png","image/webp","application/octet-stream"].includes(mime)) {
      throw new Error("Dokumen foto harus berupa JPEG, PNG, atau WebP.");
    }
    return {
      fileId:String(message.document.file_id),
      size:Number(message.document.file_size || 0),
      declaredMime:mime.startsWith("image/") ? mime : ""
    };
  }
  throw new Error("Kirim foto atau dokumen gambar JPEG, PNG, atau WebP.");
}

async function downloadTelegramProductImage(env,message) {
  const descriptor = telegramProductImageDescriptor(message);
  if (!descriptor.fileId) throw new Error("Telegram tidak memberikan identitas file gambar.");
  if (descriptor.size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("Ukuran gambar produk maksimal 5 MB.");
  }
  const metadataResponse = await fetch(
    TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/getFile?file_id=" +
    encodeURIComponent(descriptor.fileId)
  );
  const metadata = await metadataResponse.json().catch(()=>({}));
  if (!metadataResponse.ok || !metadata.ok || !metadata.result?.file_path) {
    throw new Error("Telegram tidak dapat menyiapkan file gambar produk.");
  }
  if (Number(metadata.result.file_size || 0) > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("Ukuran gambar produk maksimal 5 MB.");
  }
  const filePath = String(metadata.result.file_path);
  const segments = filePath.split("/");
  if (!filePath || filePath.startsWith("/") ||
      segments.some(part => !part || part === "." || part === "..")) {
    throw new Error("Lokasi file Telegram tidak valid.");
  }
  const encodedPath = segments.map(encodeURIComponent).join("/");
  const fileResponse = await fetch(
    "https://api.telegram.org/file/bot" + env.TELEGRAM_TOKEN + "/" + encodedPath
  );
  if (!fileResponse.ok) throw new Error("Gagal mengambil foto produk dari Telegram.");
  const remoteLength = Number(fileResponse.headers.get("Content-Length") || 0);
  if (remoteLength > MAX_PRODUCT_IMAGE_BYTES) throw new Error("Ukuran gambar produk maksimal 5 MB.");
  const bytes = new Uint8Array(await fileResponse.arrayBuffer());
  if (bytes.byteLength > MAX_PRODUCT_IMAGE_BYTES) throw new Error("Ukuran gambar produk maksimal 5 MB.");
  const responseType = String(fileResponse.headers.get("Content-Type") || "")
    .split(";")[0].trim().toLowerCase();
  const declaredMime = descriptor.declaredMime || (
    ["image/jpeg","image/png","image/webp"].includes(responseType) ? responseType : ""
  );
  return {bytes,declaredMime};
}

async function promptAdminProductPhoto(env,chatId,sku) {
  const product = await findProductTransactional(env,sku);
  if (!product) throw new Error("Produk tidak ditemukan.");
  const text = [
    "📷 UPLOAD FOTO PRODUK SEITON",
    "SKU=" + String(product.sku),
    "",
    "Balas pesan ini dengan foto atau dokumen JPEG, PNG, atau WebP.",
    "Ukuran maksimal 5 MB. File akan diperiksa dari signature aslinya sebelum disimpan ke R2.",
    "Foto lama baru diganti setelah foto baru berhasil disimpan dan data produk diperbarui."
  ].join("\n");
  await sendTelegram(env,chatId,text,{
    force_reply:true,input_field_placeholder:"Lampirkan foto produk"
  });
}

async function handleTelegramProductPhotoUpload(env,message,chatId,actorId,prompt) {
  if (!env.PRODUCT_MEDIA) throw new Error("Binding R2 PRODUCT_MEDIA belum tersedia.");
  const state = await transactionReadiness(env);
  if (!state.ready) throw new Error("Upload foto produk membutuhkan transaction store D1 yang aktif.");
  const match = String(prompt || "").match(/SKU=([A-Za-z0-9._-]{1,40})/);
  if (!match) throw new Error("Instruksi upload foto tidak valid. Buka ulang katalog admin.");
  const sku = match[1].toUpperCase();
  const product = await findProductTransactional(env,sku);
  if (!product) throw new Error("Produk tidak ditemukan.");
  const file = await downloadTelegramProductImage(env,message);
  const persisted = await uploadThenPersistProductImage(
    env.PRODUCT_MEDIA,file.bytes,file.declaredMime,"telegram",
    key => saveCatalogProduct(env,{
      sku:product.sku,name:product.name,price:product.price,
      stock:product.stock,active:Boolean(product.active),
      photo_url:key,description:product.description || ""
    },product.sku)
  );
  const uploaded = persisted.uploaded;
  const result = persisted.result;
  await recordAdminActivity(env,{
    actorId,action:"PRODUCT_IMAGE_UPDATED",resourceType:"product",
    resourceId:sku,summary:{sku,content_type:uploaded.contentType,size:uploaded.size}
  }).catch(error=>console.warn(JSON.stringify({
    level:"warn",event:"telegram_product_media_audit_failed",
    message:String(error?.message||error).slice(0,200)
  })));
  await sendTelegram(env,chatId,
    "✅ Foto produk " + sku + " berhasil disimpan ke R2. Foto lama sudah diganti setelah data produk berhasil diperbarui.",
    adminMenuKeyboard()
  );
}

async function handleAdminProductMutation(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Data produk tidak valid."},400); }
  try {
    await ensureCatalogHeaders(env);
    if (body.action === "delete") {
      const result = await deleteCatalogProduct(env, body.sku);
      await recordAdminActivity(env, { actorChannel: "web", actorId: "web-admin", action: "PRODUCT_DELETED", resourceType: "product", resourceId: result.sku, summary: { sku: result.sku } });
      return json({ok:true,deleted:result.sku});
    }
    if (body.action !== "save" || !body.product) return json({ok:false,error:"Aksi produk tidak dikenal."},400);
    const p = body.product;
    const active = p.active === true || String(p.active).toLowerCase() === "true";
    const result = await saveCatalogProduct(env, { ...p, active }, String(p.original_sku || ""));
    await recordAdminActivity(env, { actorChannel: "web", actorId: "web-admin", action: result === "updated" ? "PRODUCT_UPDATED" : "PRODUCT_CREATED", resourceType: "product", resourceId: String(p.sku).trim(), summary: { sku: String(p.sku).trim(), name: String(p.name || "").slice(0, 100), price: Number(p.price), active } });
    return json({ok:true,sku:String(p.sku).trim(),action:result});
  } catch(error) { return json({ok:false,error:error.message},400); }
}

async function setOrderStatus(env, rowNumber, status, actor = "admin") {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,rowNumber);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const updated = await setOrderStatusTransactional(env,found.order.order_id,status,actor);
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
  await recordAdminActivity(env, { actorChannel: actorChannel(actor), actorId: actorIdentifier(actor), action: "STATUS_CHANGED", resourceType: "order", resourceId: String(row[0]), summary: { from_status: current, to_status: status } });
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
  try { await setOrderStatus(env,found.rowNumber ?? body.order_id,status,"web-admin"); return json({ok:true,status}); }
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
    const origin = new URL(request.url).origin;
    data.products = (data.products || []).map(product => {
      const key = isProductMediaKey(product.photo_url);
      return {
        ...product,
        photo_r2: key,
        photo_url: key ? productMediaPublicUrl(product.photo_url,origin) : (product.photo_url || "")
      };
    });
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
  const state = await transactionReadiness(env);
  if (!state.ready) await ensurePaymentWorkflowHeaders(env);
  const pending = state.ready
    ? (await listOrdersTransactional(env,{limit:5000}))
        .filter(o => String(o.payment_confirmation_status || "") === "MENUNGGU_VERIFIKASI")
        .map(o => ({r:orderToSheetRow(o),reference:o.order_id}))
    : (await readSheet(env, "Pesanan!A2:T")).map((r,i) => ({r,reference:String(i+2)}))
        .filter(x => String(x.r[13] || "") === "MENUNGGU_VERIFIKASI").reverse();
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(pending.length / pageSize));
  const current = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
  const subset = pending.slice(current * pageSize, current * pageSize + pageSize);
  const lines = subset.map(x => String(x.r[0]) + " · " + String(x.r[4] || "Pelanggan") + " · " + rupiah(x.r[10]) + " · " + (x.r[14] ? "Bukti tersedia" : "Belum ada bukti"));
  const keyboard = subset.map(x => [{ text: String(x.r[0]) + (x.r[14] ? " 📎" : " ⏳"), callback_data: "payview:" + x.reference }]);
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "paylist:" + (current - 1) });
  if (current < pages - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "paylist:" + (current + 1) });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
  await updateTelegramMessage(env, message, {
    text: pending.length ? "💳 PERMINTAAN VERIFIKASI PEMBAYARAN\nHalaman " + (current + 1) + "/" + pages + "\n\n" + lines.join("\n") : "✅ Tidak ada permintaan verifikasi pembayaran yang menunggu.",
    replyMarkup: { inline_keyboard: keyboard }, clearMedia: true
  });
}
async function showPaymentRequestDetail(env, message, reference) {
  const found = await resolveOrderReference(env,reference);
  const r = found?.row;
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan ini sudah diproses atau tidak lagi menunggu verifikasi.");
  const ref = String(reference);
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
    [{ text: "✅ Setujui Pembayaran", callback_data: "payapprove:" + ref }],
    [{ text: "❌ Tolak / Minta Ulang", callback_data: "payreject:" + ref }],
    [{ text: "⬅️ Daftar Verifikasi", callback_data: "adm:paymentchecks" }]
  ] };
  if (r[14] && r[15] === "PHOTO") {
    await updateTelegramMessage(env, message, { text, photo: String(r[14]), replyMarkup: keyboard });
  } else {
    await updateTelegramMessage(env, message, { text, replyMarkup: keyboard, clearMedia: true });
    if (r[14] && r[15] === "DOCUMENT") await sendTelegramDocumentById(env, message.chat.id, String(r[14]), "Bukti pembayaran " + r[0]);
  }
}
async function approvePaymentAndIssueTicket(env, reference, actor = "telegram-admin") {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const approved = await approvePaymentTransactional(env,found.order.order_id,actor);
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
  await recordAdminActivity(env, { actorChannel: actorChannel(actor), actorId: actorIdentifier(actor), action: "PAYMENT_APPROVED", resourceType: "order", resourceId: String(r[0]), summary: { from_status: String(r[12] || ""), to_status: "DIBAYAR" } });
  const ticketUrl = await createPickupTicketUrl(env, String(r[0]), receiptCode);
  return { row:r, receiptCode, ticketUrl };
}
async function rejectPaymentRequest(env, reference, actor = "telegram-admin") {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const rejected = await rejectPaymentTransactional(env,found.order.order_id,actor);
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
  await recordAdminActivity(env, { actorChannel: actorChannel(actor), actorId: actorIdentifier(actor), action: "PAYMENT_REJECTED", resourceType: "order", resourceId: String(r[0]), summary: { payment_confirmation_status: "DITOLAK" } });
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
  const state = await transactionReadiness(env);
  if (!state.ready) await ensurePaymentWorkflowHeaders(env);
  const queue = state.ready
    ? (await listOrdersTransactional(env,{limit:5000}))
        .filter(o => String(o.payment_confirmation_status || "") === "DISETUJUI" && o.receipt_code &&
          String(o.pickup_status || "") !== "DIAMBIL" && PAID_ORDER_STATUSES.includes(String(o.status || "").toUpperCase()))
        .map(o => ({r:orderToSheetRow(o),reference:o.order_id}))
    : (await readSheet(env, "Pesanan!A2:T")).map((r,i) => ({r,reference:String(i+2)}))
        .filter(x => String(x.r[13] || "") === "DISETUJUI" && String(x.r[18] || "") &&
          String(x.r[19] || "") !== "DIAMBIL" && PAID_ORDER_STATUSES.includes(String(x.r[12] || "").toUpperCase())).reverse();
  const pageSize = 8; const pages = Math.max(1, Math.ceil(queue.length / pageSize));
  const current = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
  const subset = queue.slice(current * pageSize, current * pageSize + pageSize);
  const buttons = subset.map(x => [{ text: String(x.r[0]) + " · " + String(x.r[4] || "Pelanggan"), callback_data: "pickupview:" + x.reference }]);
  const nav = [];
  if (current > 0) nav.push({ text: "◀️ Sebelumnya", callback_data: "picklist:" + (current - 1) });
  if (current < pages - 1) nav.push({ text: "Berikutnya ▶️", callback_data: "picklist:" + (current + 1) });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
  await updateTelegramMessage(env, message, {
    text: queue.length ? "📦 PESANAN SUDAH DIBAYAR — BELUM DIAMBIL\nHalaman " + (current + 1) + "/" + pages + "\nTotal antrean: " + queue.length : "✅ Tidak ada pesanan lunas yang menunggu pengambilan.",
    replyMarkup: { inline_keyboard: buttons }, clearMedia: true
  });
}
async function showPickupOrderDetail(env, message, reference) {
  const found = await resolveOrderReference(env,reference);
  const r = found?.row;
  if (!r || !r[0] || String(r[13] || "").trim().toUpperCase() !== "DISETUJUI" ||
      !r[18] || !PAID_ORDER_STATUSES.includes(String(r[12] || "").trim().toUpperCase())) {
    throw new Error("Resi pengambilan tidak ditemukan, dibatalkan, atau belum disetujui.");
  }
  const ticketUrl = await createPickupTicketUrl(env, String(r[0]), String(r[18]));
  const picked = String(r[19] || "") === "DIAMBIL";
  const buttons = picked ? [] : [[{ text: "✅ Tandai Sudah Diambil", callback_data: "pickupdone:" + String(reference) }]];
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
    replyMarkup: { inline_keyboard: buttons }, clearMedia: true
  });
}
async function markOrderPickedUp(env, reference, actor = "telegram-admin") {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const updated = await markPickedUpTransactional(env,found.order.order_id,actor);
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
  await recordAdminActivity(env, { actorChannel: actorChannel(actor), actorId: actorIdentifier(actor), action: "PICKED_UP", resourceType: "order", resourceId: String(r[0]), summary: { from_status: String(r[12] || ""), to_status: "SELESAI", pickup_status: "DIAMBIL" } });
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

async function checkoutCart(env,input) {
  const state = await transactionReadiness(env);
  if (!state.ready) {
    throw new Error("Keranjang multi-produk membutuhkan lapisan transaksi D1 yang sudah aktif.");
  }
  const shipping = env.DEFAULT_SHIPPING == null || env.DEFAULT_SHIPPING === "" ? 0 : Number(env.DEFAULT_SHIPPING);
  if (!Number.isSafeInteger(shipping) || shipping < 0) {
    throw new Error("DEFAULT_SHIPPING harus berupa bilangan Rupiah nol atau lebih.");
  }
  const order = await checkoutCartTransactional(env,{...input,shipping});
  if (!order.duplicate) {
    try {
      const stored = await findOrderTransactional(env,order.orderId);
      await mirrorTransactionalOrder(env,stored);
    } catch (error) {
      console.warn(JSON.stringify({
        level:"warn",event:"cart_order_sheet_mirror_read",
        order_id:order.orderId,message:error.message
      }));
    }
  }
  return order;
}

async function createOrder(env, input) {
  const transactionState = await transactionReadiness(env);
  if (transactionState.configured && !transactionState.ready) {
    throw new Error("Lapisan transaksi D1 belum siap. Admin perlu menjalankan /migrasi_d1 sebelum pesanan baru diterima.");
  }
  if (transactionState.ready) {
    const shipping = env.DEFAULT_SHIPPING == null || env.DEFAULT_SHIPPING === "" ? 0 : Number(env.DEFAULT_SHIPPING);
    if (!Number.isSafeInteger(shipping) || shipping < 0) throw new Error("DEFAULT_SHIPPING harus berupa bilangan Rupiah nol atau lebih.");
    const order = await createOrderTransactional(env,{...input,shipping});
    if (!order.duplicate) {
      try {
        const stored = await findOrderTransactional(env,order.orderId);
        await mirrorTransactionalOrder(env,stored);
      } catch (error) {
        console.warn(JSON.stringify({level:"warn",event:"order_sheet_mirror_read",order_id:order.orderId,message:error.message}));
      }
    }
    return order;
  }
  if (!env.GOOGLE_SHEETS_ID || !env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    throw new Error("Google Sheets credentials are not configured");
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



async function recordAdminActivity(env, entry) {
  if (!env?.DB || !entry || !entry.actorId || !entry.action) return false;
  const actorChannelValue = entry.actorChannel === "web" ? "web" : "telegram";
  const actorIdValue = String(entry.actorId).trim().slice(0, 128);
  if (!actorIdValue) return false;
  const actionValue = String(entry.action).trim().slice(0, 80);
  const resourceTypeValue = String(entry.resourceType || "admin").trim().slice(0, 40);
  const resourceIdValue = entry.resourceId == null ? null : String(entry.resourceId).trim().slice(0, 160);
  let summaryJson = "{}";
  try { summaryJson = JSON.stringify(entry.summary || {}).slice(0, 4000); } catch {}
  try {
    await env.DB.prepare(
      "INSERT INTO admin_activity_audit(audit_id,actor_channel,actor_id,action,resource_type,resource_id,summary_json,created_at_ms) " +
      "VALUES(?,?,?,?,?,?,?,?)"
    ).bind(crypto.randomUUID(), actorChannelValue, actorIdValue, actionValue,
      resourceTypeValue, resourceIdValue, summaryJson, Date.now()).run();
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      level: "error", event: "admin_activity_audit_write_failed", action: actionValue,
      code: "ADMIN_ACTIVITY_AUDIT_WRITE_FAILED"
    }));
    return false;
  }
}
function actorChannel(actor) {
  return String(actor || "").startsWith("telegram") ? "telegram" : "web";
}
function actorIdentifier(actor) {
  const value = String(actor || "");
  return value.startsWith("telegram:") ? value.slice("telegram:".length) : value;
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

async function messagingCoreReady(env) {
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messaging_outbox' LIMIT 1"
    ).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function messagingHandoffSchemaReady(env) {
  if (!(await messagingCoreReady(env))) return false;
  try {
    await env.DB.prepare(
      "SELECT claimed_by,claimed_at,closed_by,resolution FROM messaging_handoff_requests LIMIT 0"
    ).all();
    return true;
  } catch {
    return false;
  }
}

function telegramHandoffCallback(action, handoffId) {
  const callback = "hf:" + action + ":" + String(handoffId || "");
  return new TextEncoder().encode(callback).length <= 64 ? callback : null;
}

function formatHandoffDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short"
  }).format(date);
}

async function showTelegramHandoffQueue(env, message, adminChatId, notice = "") {
  if (!(await messagingHandoffSchemaReady(env))) {
    await updateTelegramMessage(env, message, {
      text: "⚠️ Antrean bantuan belum tersedia. Periksa migrasi D1 Messaging Core.",
      replyMarkup: { inline_keyboard: [[{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]] },
      clearMedia: true
    });
    return;
  }

  const items = await listMessagingHandoffs(env, 20, "telegram");
  if (!items.length) {
    await updateTelegramMessage(env, message, {
      text: (notice ? notice + "\n\n" : "") +
        "🆘 ANTREAN BANTUAN PELANGGAN\n\n✅ Tidak ada permintaan bantuan yang menunggu atau sedang ditangani.",
      replyMarkup: { inline_keyboard: [
        [{ text: "🔄 Perbarui", callback_data: "adm:handoff" }],
        [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
      ] },
      clearMedia: true
    });
    return;
  }

  const keyboard = [];
  const cards = items.map((item, index) => {
    const claimedBy = String(item.claimed_by || "");
    const status = item.status === "OPEN" ? "🆕 MENUNGGU ADMIN" :
      claimedBy === String(adminChatId) ? "🟡 ANDA MENANGANI" : "🔒 SEDANG DITANGANI";
    const owner = item.status === "CLAIMED"
      ? "\nAdmin: " + (claimedBy === String(adminChatId) ? "Anda" : claimedBy)
      : "";
    if (item.status === "OPEN") {
      const row = [];
      const take = telegramHandoffCallback("take", item.handoff_id);
      const decline = telegramHandoffCallback("decline", item.handoff_id);
      if (take) row.push({ text: "✅ Terima #" + (index + 1), callback_data: take });
      if (decline) row.push({ text: "❌ Tolak #" + (index + 1), callback_data: decline });
      if (row.length) keyboard.push(row);
    } else if (claimedBy === String(adminChatId)) {
      const done = telegramHandoffCallback("done", item.handoff_id);
      if (done) keyboard.push([{ text: "✅ Selesaikan #" + (index + 1), callback_data: done }]);
    }
    return (index + 1) + ". " + String(item.customer_name || "Pelanggan") +
      "\nStatus: " + status +
      "\nKanal: " + item.source_channel +
      "\nWaktu: " + formatHandoffDate(item.created_at) +
      owner;
  });

  keyboard.push([{ text: "🔄 Perbarui antrean", callback_data: "adm:handoff" }]);
  keyboard.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
  await updateTelegramMessage(env, message, {
    text: (notice ? notice + "\n\n" : "") +
      "🆘 ANTREAN BANTUAN PELANGGAN\n" +
      "Pilih tindakan pada setiap permintaan.\n\n" + cards.join("\n\n"),
    replyMarkup: { inline_keyboard: keyboard },
    clearMedia: true
  });
}

function telegramMessagingEvent(update, message, textOverride = null) {
  const chatId = String(message.chat.id);
  const senderId = String(message.from.id);
  return {
    tenantId: "seiton",
    channel: "telegram",
    eventId: "telegram:" + String(update.update_id ?? (chatId + ":" + message.message_id)),
    externalMessageId: String(message.message_id ?? update.update_id ?? ""),
    conversationId: chatId,
    senderId,
    customerName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "Pelanggan",
    text: textOverride == null ? String(message.text || message.caption || "").trim() : textOverride,
    fromMe: false,
    isDirect: !message.chat.type || message.chat.type === "private",
    occurredAt: new Date().toISOString()
  };
}

function createMessagingServices(env) {
  return {
    async listProducts() {
      const state = await transactionReadiness(env);
      if (state.ready) {
        const rows = await listProductsTransactional(env,true);
        return rows.map(product => {
          const price = Number(product.price);
          const stock = product.stock == null ? null : Number(product.stock);
          const priceValid = Number.isSafeInteger(price) && price >= 0;
          const stockValid = stock == null || (Number.isSafeInteger(stock) && stock >= 0);
          return {
            sku: String(product.sku),
            name: String(product.name || ""),
            price,
            stock,
            active: Boolean(product.active),
            priceValid,
            stockValid,
            photoUrl: String(product.photo_url || ""),
            description: String(product.description || "")
          };
        }).filter(product => product.active && product.priceValid && product.stockValid);
      }
      const rows = await readCatalogRows(env);
      return rows.map(parseCatalogProduct).filter(product =>
        product.active && product.priceValid && product.stockValid
      ).map(product => ({
        sku: product.sku,
        name: product.name,
        price: product.price,
        stock: product.stock,
        active: product.active,
        priceValid: product.priceValid,
        stockValid: product.stockValid,
        photoUrl: product.photoUrl,
        description: product.description
      }));
    },
    async listOrders(customerId, channel) {
      const state = await transactionReadiness(env);
      if (state.ready) {
        const orders = await listOrdersTransactional(env, { limit: 5000 });
        return orders.filter(order =>
          String(order.customer_id) === String(customerId) &&
          String(order.channel) === String(channel)
        ).slice(0, 5).map(order => ({
          orderId: order.order_id,
          customerId: order.customer_id,
          channel: order.channel,
          product: String(order.sku || "") + " - " + String(order.product_name || ""),
          quantity: Number(order.quantity),
          total: Number(order.total),
          paymentMethod: order.payment_method,
          status: order.status
        }));
      }
      const rows = await readSheet(env, "Pesanan!A2:T");
      return rows.filter(row =>
        String(row[3] || "") === String(customerId) &&
        String(row[2] || "") === String(channel)
      ).slice(-5).reverse().map(row => ({
        orderId: String(row[0] || ""),
        customerId: String(row[3] || ""),
        channel: String(row[2] || ""),
        product: String(row[5] || ""),
        quantity: Number(row[6] || 0),
        total: Number(row[10] || 0),
        paymentMethod: String(row[11] || ""),
        status: String(row[12] || "")
      }));
    },
    async findOrder(orderId) {
      const found = await findOrderById(env, orderId);
      if (!found) return null;
      const row = found.row;
      const stored = found.order;
      return {
        orderId: String(row[0] || ""),
        customerId: String(row[3] || ""),
        channel: String(row[2] || ""),
        product: String(row[5] || ""),
        quantity: Number(row[6] || 0),
        unitPrice: Number(row[7] || 0),
        shipping: Number(row[9] || 0),
        total: Number(row[10] || 0),
        paymentMethod: String(row[11] || ""),
        status: String(row[12] || ""),
        items: Array.isArray(stored?.items) ? stored.items : []
      };
    },
    async getCart(channel,customerId) {
      const state = await transactionReadiness(env);
      if (!state.ready) throw new Error("Lapisan transaksi D1 belum aktif untuk keranjang.");
      return getCartTransactional(env,channel,customerId);
    },
    async addCartItem(sku,quantity,event) {
      return addCartItemTransactional(
        env,event.channel,event.senderId,sku,quantity,event.eventId
      );
    },
    async updateCartItem(sku,quantity,event) {
      return updateCartItemTransactional(
        env,event.channel,event.senderId,sku,quantity,event.eventId
      );
    },
    async removeCartItem(sku,event) {
      return removeCartItemTransactional(
        env,event.channel,event.senderId,sku,event.eventId
      );
    },
    async clearCart(event) {
      return clearCartTransactional(
        env,event.channel,event.senderId,event.eventId
      );
    },
    async checkoutCart(input) {
      return checkoutCart(env,input);
    },
    createOrder(input) {
      return createOrder(env, input);
    },
    getPaymentInstructions(order) {
      if (String(order.paymentMethod).toUpperCase() === "QRIS") {
        return "Instruksi QRIS: " + String(env.LINK_QRIS_IMAGE || "Hubungi admin untuk mendapatkan QRIS.");
      }
      if (String(order.paymentMethod).toUpperCase() === "TRANSFER") {
        return "Instruksi transfer akan diberikan admin.";
      }
      return "Pembayaran COD dipilih.";
    },
    getAdminTargets() {
      return String(env.ADMIN_CHAT_ID || "").split(",").map(value => value.trim()).filter(Boolean);
    }
  };
}

function telegramMessagingReplyMarkup(payload) {
  const buttons = Array.isArray(payload.buttons) ? payload.buttons : [];
  if (!buttons.length) return null;
  const callbackByValue = {
    catalog: "nav:catalog",
    orders: "nav:orders",
    help: "nav:help"
  };
  const rows = buttons.map(button => {
    const value = String(button.value || "");
    let callback = callbackByValue[value] || "nav:home";
    if (value.startsWith("handoff:take:")) callback = "hf:take:" + value.slice("handoff:take:".length);
    else if (value.startsWith("handoff:decline:")) callback = "hf:decline:" + value.slice("handoff:decline:".length);
    if (new TextEncoder().encode(callback).length > 64) return null;
    return [{ text: String(button.label || "Pilih").slice(0, 60), callback_data: callback }];
  }).filter(Boolean);
  return rows.length ? { inline_keyboard: rows } : null;
}

async function dispatchTelegramMessagingOutbox(env, limit = 20) {
  if (!env.DB || !env.TELEGRAM_TOKEN) return { claimed: 0, sent: 0, failed: 0 };
  const jobs = await claimMessagingOutbox(env, "telegram", limit);
  let sent = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payload_json || "{}");
      if (payload.type !== "text" || !payload.text) throw new Error("OUTBOX_PAYLOAD_INVALID");
      await sendTelegram(
        env,
        String(job.recipient_id),
        String(payload.text),
        telegramMessagingReplyMarkup(payload)
      );
      await completeMessagingOutbox(env, job, null);
      sent += 1;
    } catch (error) {
      await failMessagingOutbox(env, job, "TELEGRAM_SEND_FAILED");
      failed += 1;
      console.warn(JSON.stringify({
        level: "warn",
        event: "messaging_outbox_delivery_failed",
        action_id: job.action_id,
        code: error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message)
          ? error.message
          : "TELEGRAM_SEND_FAILED"
      }));
    }
  }
  return { claimed: jobs.length, sent, failed };
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