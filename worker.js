/**
 * ============================================================================
 * SEITON.ID - HIGH-PERFORMANCE BOT & INTERACTIVE DASHBOARD ENGINE
 * Stack: Cloudflare Workers + Google Sheets API + Telegram/WhatsApp Webhook
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

const ADMIN_DASHBOARD_HTML = "<!doctype html>\n<html lang=\"id\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Seiton.id · Dashboard Admin</title>\n<script src=\"https://cdn.jsdelivr.net/npm/chart.js\"></script>\n<style>\n:root{color-scheme:dark;--bg:#0b1220;--panel:#131e30;--panel2:#18263b;--line:#26374f;--text:#eef4ff;--muted:#9db0c9;--accent:#68a7ff;--good:#47d7a0;--warn:#f5c56b;--bad:#ff7b85}\n*{box-sizing:border-box}body{margin:0;background:linear-gradient(150deg,#0b1220,#101d31 60%,#0b1220);color:var(--text);font:14px Inter,system-ui,Segoe UI,sans-serif}\n.wrap{max-width:1440px;margin:auto;padding:26px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:22px}\n.brand h1{font-size:24px;margin:0 0 5px}.brand p{margin:0;color:var(--muted)}.actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}\nbutton,select{background:var(--panel2);border:1px solid var(--line);border-radius:10px;color:var(--text);padding:10px 13px;font:inherit}button{cursor:pointer}button.primary{background:#235a9e;border-color:#367ccc}button:hover{filter:brightness(1.15)}\n.status{font-size:12px;color:var(--muted);margin-top:7px}.grid{display:grid;gap:14px}.metrics{grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:14px}\n.card{background:linear-gradient(160deg,#17243a,#111c2c);border:1px solid var(--line);border-radius:16px;padding:17px;min-width:0;box-shadow:0 12px 30px #0002}\n.metric-label{color:var(--muted);font-size:12px}.metric-value{font-size:25px;font-weight:750;margin-top:9px;letter-spacing:-.5px}.metric-note{color:var(--muted);font-size:11px;margin-top:7px}\n.charts{grid-template-columns:1.5fr 1fr 1.1fr;margin-bottom:14px}.chart-card h2,.section-head h2{font-size:15px;margin:0 0 14px}.chart-box{height:270px;position:relative}\n.lower{grid-template-columns:1.8fr 1fr}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:13px;gap:12px}\n.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:720px}th,td{text-align:left;padding:11px 9px;border-bottom:1px solid var(--line);font-size:12px;white-space:nowrap}th{color:var(--muted);font-weight:600}td.amount{text-align:right;font-variant-numeric:tabular-nums}\n.pill{padding:4px 8px;border-radius:99px;background:#243852;color:#c8ddf7;font-size:10px}.pill.good{background:#153e39;color:#81e7c0}.pill.warn{background:#4a3a1c;color:#f8d78b}.pill.bad{background:#4a2630;color:#ffabb2}\n.list{display:grid;gap:10px}.list-row{display:flex;justify-content:space-between;gap:12px;padding-bottom:9px;border-bottom:1px solid var(--line)}.list-row span:first-child{color:var(--muted)}\n.note{margin-top:14px;color:var(--muted);font-size:11px;line-height:1.6}.error{display:none;background:#4a2630;border:1px solid #713844;padding:13px;border-radius:10px;margin-bottom:14px;color:#ffced2}\n@media(max-width:1100px){.metrics{grid-template-columns:repeat(3,1fr)}.charts{grid-template-columns:1fr 1fr}.charts .chart-card:first-child{grid-column:span 2}.lower{grid-template-columns:1fr}}\n@media(max-width:650px){.wrap{padding:15px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric-value{font-size:20px}.charts{grid-template-columns:1fr}.charts .chart-card:first-child{grid-column:auto}.chart-box{height:235px}.brand h1{font-size:21px}}\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n <header class=\"top\">\n  <div class=\"brand\"><h1>Seiton.id · Admin Analytics</h1><p>Ringkasan penjualan dan operasional toko</p><div class=\"status\" id=\"refreshStatus\">Menyiapkan dashboard…</div></div>\n  <div class=\"actions\"><select id=\"period\"><option value=\"7\">7 hari</option><option value=\"30\" selected>30 hari</option><option value=\"90\">90 hari</option><option value=\"365\">12 bulan</option><option value=\"all\">Semua data</option></select><button id=\"refreshBtn\">↻ Perbarui</button><button class=\"primary\" id=\"exportAll\">⬇ Unduh Paket CSV</button></div>\n </header>\n <div class=\"error\" id=\"errorBox\"></div>\n <section class=\"grid metrics\">\n  <div class=\"card\"><div class=\"metric-label\">Total pesanan</div><div class=\"metric-value\" id=\"mOrders\">—</div><div class=\"metric-note\">Dalam periode terpilih</div></div>\n  <div class=\"card\"><div class=\"metric-label\">Penerimaan terkonfirmasi</div><div class=\"metric-value\" id=\"mRevenue\">—</div><div class=\"metric-note\">Status dibayar, diproses, dikirim, selesai</div></div>\n  <div class=\"card\"><div class=\"metric-label\">Belum tertagih</div><div class=\"metric-value\" id=\"mOutstanding\">—</div><div class=\"metric-note\">Pesanan belum dibayar</div></div>\n  <div class=\"card\"><div class=\"metric-label\">Pesanan menunggu</div><div class=\"metric-value\" id=\"mPending\">—</div><div class=\"metric-note\">Menunggu pembayaran</div></div>\n  <div class=\"card\"><div class=\"metric-label\">Produk aktif</div><div class=\"metric-value\" id=\"mProducts\">—</div><div class=\"metric-note\" id=\"mStock\">—</div></div>\n </section>\n <section class=\"grid charts\">\n  <div class=\"card chart-card\"><h2>Tren penerimaan harian</h2><div class=\"chart-box\"><canvas id=\"revenueChart\"></canvas></div></div>\n  <div class=\"card chart-card\"><h2>Status pesanan</h2><div class=\"chart-box\"><canvas id=\"statusChart\"></canvas></div></div>\n  <div class=\"card chart-card\"><h2>Produk terlaris</h2><div class=\"chart-box\"><canvas id=\"productChart\"></canvas></div></div>\n </section>\n <section class=\"grid lower\">\n  <div class=\"card\"><div class=\"section-head\"><h2>Pesanan terbaru</h2><button data-export=\"orders\">Unduh CSV</button></div><div class=\"table-wrap\"><table><thead><tr><th>ID</th><th>Tanggal</th><th>Pelanggan</th><th>Produk</th><th>Total</th><th>Status</th></tr></thead><tbody id=\"ordersBody\"><tr><td colspan=\"6\">Memuat data…</td></tr></tbody></table></div></div>\n  <div class=\"card\"><div class=\"section-head\"><h2>Operasional produk</h2><button data-export=\"inventory\">Stok CSV</button></div><div class=\"list\" id=\"productSummary\"></div><div class=\"note\">Nilai stok dihitung dari harga jual × stok, bukan harga modal.</div></div>\n </section>\n <p class=\"note\">Sumber: Google Sheets. Data diperbarui otomatis setiap 30 detik selama dashboard terbuka. Angka penerimaan dihitung dari status yang dianggap telah dibayar. Laba bersih belum tersedia karena harga pokok/modal produk belum tercatat. Tautan dashboard memiliki masa berlaku akses terbatas.</p>\n</div>\n<script>\n(function(){\n const params=new URLSearchParams(location.search);\n let access=params.get('access')||sessionStorage.getItem('seitonAdminAccess')||'';\n if(access){sessionStorage.setItem('seitonAdminAccess',access);history.replaceState({},'',location.pathname);}\n const $=id=>document.getElementById(id);\n const paid=['DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED'];\n const cancelled=['DIBATALKAN','CANCELLED','CANCELED'];\n const money=n=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(n)||0);\n const num=n=>new Intl.NumberFormat('id-ID').format(Number(n)||0);\n const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n const day=d=>{const x=new Date(d);return Number.isNaN(x.getTime())?'Tidak diketahui':new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(x);};\n const fmtDate=d=>{const x=new Date(d);return Number.isNaN(x.getTime())?'-':x.toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});};\n let raw=null,charts={};\n async function api(url){const r=await fetch(url,{headers:{Authorization:'Bearer '+access}});if(r.status===401)throw new Error('Akses dashboard berakhir. Buka kembali Dashboard Interaktif dari menu admin Telegram.');if(!r.ok)throw new Error('Gagal membaca data ('+r.status+').');return r;}\n function periodOrders(){\n  let list=raw.orders||[],p=$('period').value;\n  if(p==='all')return list;\n  let cutoff=Date.now()-Number(p)*86400000;\n  return list.filter(o=>{let d=new Date(o.created_at).getTime();return Number.isFinite(d)&&d>=cutoff;});\n }\n function setChart(id,type,data,options){\n  if(charts[id]){charts[id].destroy();}\n  charts[id]=new Chart($(id),{type:type,data:data,options:Object.assign({responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#c8d6e9',boxWidth:10,font:{size:10}}}},scales:type==='doughnut'?{}:{x:{ticks:{color:'#9db0c9'},grid:{color:'#26374f'}},y:{ticks:{color:'#9db0c9'},grid:{color:'#26374f'}}}},options||{})});\n }\n function render(){\n  if(!raw)return;\n  const orders=periodOrders(),products=raw.products||[];\n  const confirmed=orders.filter(o=>paid.includes(o.status)),pending=orders.filter(o=>!paid.includes(o.status)&&!cancelled.includes(o.status));\n  const revenue=confirmed.reduce((s,o)=>s+o.total,0),outstanding=pending.reduce((s,o)=>s+o.total,0);\n  const active=products.filter(p=>p.active),stockCount=active.reduce((s,p)=>s+(p.stock==null?0:Math.max(0,p.stock)),0);\n  $('mOrders').textContent=num(orders.length);$('mRevenue').textContent=money(revenue);$('mOutstanding').textContent=money(outstanding);$('mPending').textContent=num(pending.length);$('mProducts').textContent=num(active.length);$('mStock').textContent=num(stockCount)+' unit stok tercatat';\n  const daily={};confirmed.forEach(o=>{let k=day(o.created_at);daily[k]=(daily[k]||0)+o.total;});\n  const labels=Object.keys(daily).sort();\n  setChart('revenueChart','line',{labels:labels,datasets:[{label:'Penerimaan',data:labels.map(k=>daily[k]),borderColor:'#68a7ff',backgroundColor:'#68a7ff22',fill:true,tension:.32,pointRadius:3}]},{plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#9db0c9',maxTicksLimit:8},grid:{color:'#26374f'}},y:{ticks:{color:'#9db0c9',callback:v=>new Intl.NumberFormat('id-ID',{notation:'compact'}).format(v)},grid:{color:'#26374f'}}}});\n  const statusMap={};orders.forEach(o=>{statusMap[o.status||'TANPA STATUS']=(statusMap[o.status||'TANPA STATUS']||0)+1;});\n  setChart('statusChart','doughnut',{labels:Object.keys(statusMap),datasets:[{data:Object.values(statusMap),backgroundColor:['#68a7ff','#47d7a0','#f5c56b','#ff7b85','#a78bfa','#55c5cf','#e79cc5'],borderColor:'#131e30',borderWidth:3}]},{plugins:{legend:{position:'bottom',labels:{color:'#c8d6e9',boxWidth:9,font:{size:9}}}}});\n  const top={};confirmed.forEach(o=>{let name=String(o.product||'').split(' - ').slice(1).join(' - ')||o.product;top[name]=(top[name]||0)+o.quantity;});\n  const tops=Object.entries(top).sort((a,b)=>b[1]-a[1]).slice(0,7);\n  setChart('productChart','bar',{labels:tops.map(x=>x[0]),datasets:[{label:'Unit terjual',data:tops.map(x=>x[1]),backgroundColor:'#47d7a0',borderRadius:5}]},{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#9db0c9'},grid:{color:'#26374f'}},y:{ticks:{color:'#c8d6e9'},grid:{display:false}}}});\n  const recent=[...orders].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,15);\n  $('ordersBody').innerHTML=recent.length?recent.map(o=>'<tr><td>'+esc(o.order_id)+'</td><td>'+esc(fmtDate(o.created_at))+'</td><td>'+esc(o.customer_name)+'</td><td>'+esc(o.product)+'</td><td class=\"amount\">'+esc(money(o.total))+'</td><td><span class=\"pill '+(paid.includes(o.status)?'good':cancelled.includes(o.status)?'bad':'warn')+'\">'+esc(o.status)+'</span></td></tr>').join(''):'<tr><td colspan=\"6\">Belum ada pesanan.</td></tr>';\n  $('productSummary').innerHTML='<div class=\"list-row\"><span>Total SKU</span><b>'+num(products.length)+'</b></div><div class=\"list-row\"><span>Produk aktif</span><b>'+num(active.length)+'</b></div><div class=\"list-row\"><span>Stok rendah (≤ 5)</span><b>'+num(active.filter(p=>p.stock!=null&&p.stock<=5).length)+'</b></div><div class=\"list-row\"><span>Produk nonaktif</span><b>'+num(products.length-active.length)+'</b></div><div class=\"list-row\"><span>Estimasi nilai stok</span><b>'+money(active.reduce((s,p)=>s+(p.stock==null?0:p.price*p.stock),0))+'</b></div>';\n  $('refreshStatus').textContent='Terakhir diperbarui: '+new Date(raw.generated_at).toLocaleString('id-ID')+' · refresh otomatis 30 detik';\n }\n async function refresh(){\n  if(!access){$('errorBox').style.display='block';$('errorBox').textContent='Tautan akses belum tersedia. Buka menu admin Telegram → Dashboard Interaktif untuk mendapatkan tautan baru.';return;}\n  try{$('errorBox').style.display='none';const r=await api('/api/admin/data');const j=await r.json();if(!j.ok)throw new Error(j.error||'Tidak dapat memuat data');raw=j;render();}\n  catch(e){$('errorBox').style.display='block';$('errorBox').textContent=e.message;}\n }\n async function download(type){\n  try{const r=await api('/api/admin/export?type='+encodeURIComponent(type));const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='Seiton_'+type+'.csv';a.click();URL.revokeObjectURL(url);}\n  catch(e){$('errorBox').style.display='block';$('errorBox').textContent=e.message;}\n }\n $('refreshBtn').addEventListener('click',refresh);$('period').addEventListener('change',render);$('exportAll').addEventListener('click',()=>['orders','finance','daily','inventory'].forEach((t,i)=>setTimeout(()=>download(t),i*350)));\n document.querySelectorAll('[data-export]').forEach(b=>b.addEventListener('click',()=>download(b.dataset.export)));\n refresh();setInterval(refresh,30000);\n})();\n</script>\n</body></html>";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TELEGRAM_API = "https://api.telegram.org";
const WHATSAPP_API_VERSION = "v21.0";
const TZ = "Asia/Jakarta";
const HEADERS = [
  "order_id", "created_at", "channel", "customer_id", "customer_name",
  "product", "quantity", "unit_price", "subtotal", "shipping", "total",
  "payment_method", "status"
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/pickup") {
      return handlePickupVerificationPage(request, env);
    }
    if (request.method === "GET" && url.pathname === "/admin") {
      return new Response(ADMIN_DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
    }
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
    if (request.method === "GET" && url.pathname === "/whatsapp") {
      return verifyWhatsApp(request, env);
    }
    if (request.method === "POST" && url.pathname === "/whatsapp") {
      return handleWhatsApp(request, env, ctx);
    }
    return json({ ok: false, error: "Not found" }, 404);
  }
};

async function handleTelegram(request, env, ctx) {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!constantTimeEqual(supplied, env.TELEGRAM_WEBHOOK_SECRET)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
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
      ...orderInput, channel: "telegram", customerId, customerName
    });
    await sendTelegram(env, chatId, orderConfirmation(result, env), orderConfirmationKeyboard(result));
  })();
  ctx.waitUntil(work.catch(async error => {
    console.error(JSON.stringify({ level: "error", event: "telegram_processing", message: error.message }));
    await sendTelegram(env, chatId, "⚠️ Pesanan belum dapat diproses. Silakan coba kembali atau hubungi admin.");
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
    const rows = await readSheet(env, "Katalog_Produk!A2:G");
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
  const [sku, name, priceText, stockText, activeText, imageUrl, description] = parts;
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new Error("SKU hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung (maksimal 40 karakter).");
  if (!name || name.length > 100) throw new Error("Nama produk wajib diisi (maksimal 100 karakter).");
  if (description.length > 500) throw new Error("Deskripsi maksimal 500 karakter.");
  const price = Number(priceText); const stock = Number(stockText);
  if (!Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) throw new Error("Harga dan stok harus berupa angka valid.");
  if (!["TRUE","FALSE","YA","TIDAK","1","0","AKTIF","NONAKTIF"].includes(activeText.toUpperCase())) throw new Error("Status aktif harus TRUE atau FALSE.");
  if (imageUrl && (!/^https:\/\//i.test(imageUrl) || imageUrl.length > 1000)) throw new Error("URL foto harus berupa tautan HTTPS yang bisa diakses publik.");
  const active = !["FALSE","TIDAK","0","NONAKTIF"].includes(activeText.toUpperCase());
  const token = await getGoogleAccessToken(env);
  const rows = await readSheet(env, "Katalog_Produk!A2:G");
  const existingIndex = rows.findIndex(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
  const isEdit = prompt.includes(" — EDIT — ");
  if (isEdit) {
    const originalSku = prompt.split(" — EDIT — ").pop().trim();
    if (sku.toUpperCase() !== originalSku.toUpperCase()) throw new Error("SKU tidak boleh diubah saat mengedit produk.");
    if (existingIndex < 0) throw new Error("Produk yang akan diedit tidak ditemukan.");
    const rowNumber = existingIndex + 2;
    const range = encodeURIComponent("Katalog_Produk!A" + rowNumber + ":G" + rowNumber);
    const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "/values/" + range + "?valueInputOption=USER_ENTERED", {
      method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[sku, name, price, stock, active, imageUrl, description]] })
    });
    if (!response.ok) throw new Error("Gagal memperbarui produk: " + (await response.text()).slice(0,300));
    await sendTelegram(env, chatId, "✅ Produk " + sku + " berhasil diperbarui.", adminMenuKeyboard()); return;
  }
  if (existingIndex >= 0) throw new Error("SKU sudah digunakan. Gunakan SKU lain atau pilih Atur Produk.");
  const range = encodeURIComponent("Katalog_Produk!A:G");
  const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "/values/" + range + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [[sku, name, price, stock, active, imageUrl, description]] })
  });
  if (!response.ok) throw new Error("Gagal menambahkan produk: " + (await response.text()).slice(0,300));
  await sendTelegram(env, chatId, "✅ Produk " + sku + " berhasil ditambahkan ke katalog.", adminMenuKeyboard());
}
async function deleteCatalogProduct(env, sku) {
  const normalizedSku = String(sku || "").trim().toUpperCase();
  if (!normalizedSku) throw new Error("SKU produk tidak valid.");
  const rows = await readSheet(env, "Katalog_Produk!A2:G");
  const index = rows.findIndex(r => String(r[0] || "").trim().toUpperCase() === normalizedSku);
  if (index < 0) throw new Error("Produk tidak ditemukan. Muat ulang katalog admin lalu coba kembali.");

  // Google Sheets API requires OAuth authorization for spreadsheet metadata too.
  const token = await getGoogleAccessToken(env);
  const meta = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "?fields=sheets.properties", {
    headers: { Authorization: "Bearer " + token }
  });
  if (!meta.ok) {
    const detail = (await meta.text()).slice(0, 400);
    throw new Error("Tidak dapat membaca metadata spreadsheet (" + meta.status + "): " + detail);
  }
  const metadata = await meta.json();
  const sheet = (metadata.sheets || []).find(x => x.properties?.title === "Katalog_Produk");
  if (!sheet || sheet.properties?.sheetId == null) throw new Error("Tab Katalog_Produk tidak ditemukan atau sheetId tidak tersedia.");

  // A2 is row index 1 in the zero-based GridRange used by batchUpdate.
  const rowIndex = index + 1;
  const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + ":batchUpdate", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1
    } } }] })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error("Gagal menghapus produk (" + response.status + "): " + detail);
  }
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
    const rows = await readSheet(env, "Katalog_Produk!A2:E");
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
      channel: "telegram", customerId: userId, customerName: [query.from.first_name, query.from.last_name].filter(Boolean).join(" ") });
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
      const link = "https://seiton-order-bot.midzpribadi.workers.dev/admin#access=" + encodeURIComponent(accessToken);
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
    await sendPickupReceipt(env, String(approved.row[3]), approved.row, String(approved.row[0]), approved.receiptCode);
    await updateTelegramMessage(env, message, {
      text: "✅ Pembayaran " + approved.row[0] + " berhasil disetujui. Resi dan QR pengambilan sudah dikirim ke pelanggan.",
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
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const parts = data.split(":"); const rowNum = Number(parts[1]); const status = parts[2];
    const allowed = ["MENUNGGU_PEMBAYARAN","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"];
    if (!Number.isInteger(rowNum) || rowNum < 2 || !allowed.includes(status)) throw new Error("Pembaruan status tidak valid");
    if (["DIBAYAR", "DIPROSES", "DIKIRIM", "SELESAI"].includes(status)) {
      const orderValues = await readSheet(env, "Pesanan!A" + rowNum + ":N" + rowNum);
      const orderRow = orderValues[0];
      if (!orderRow) throw new Error("Pesanan tidak ditemukan.");
      const method = String(orderRow[11] || "").toUpperCase();
      if (["QRIS", "TRANSFER"].includes(method) && String(orderRow[13] || "") !== "DISETUJUI") {
        throw new Error("Pembayaran QRIS/Transfer harus disetujui melalui menu 💳 Konfirmasi Pembayaran agar resi QR terbit otomatis.");
      }
    }
    const token = await getGoogleAccessToken(env); const range = encodeURIComponent("Pesanan!M" + rowNum);
    const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "/values/" + range + "?valueInputOption=USER_ENTERED", {
      method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[status]] })
    });
    if (!response.ok) throw new Error("Pembaruan status gagal (" + response.status + "): " + (await response.text()).slice(0,300));
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
  const products = rows.filter(r => r[0] && !["FALSE","0","NONAKTIF","NO"].includes(String(r[4] ?? "TRUE").toUpperCase()));
  if (!products.length) {
    await updateTelegramMessage(env, message, { text: "Katalog belum memiliki produk aktif.", replyMarkup: customerMenuKeyboard() });
    return;
  }
  const pageCount = products.length;
  const current = Math.max(0, Math.min(pageCount - 1, Number.isInteger(page) ? page : 0));
  const p = products[current];
  const sku = String(p[0]).trim();
  const stock = p[3] === "" || p[3] == null ? "Tidak dibatasi" : p[3];
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
    [{ text: "🛒 Pilih Produk Ini", callback_data: "buy:" + sku }],
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
    status: String(r[12] || "").toUpperCase()
  }));
}
function productRowsToObjects(rows) {
  return rows.filter(r => r[0]).map(r => ({
    sku: String(r[0] || ""),
    name: String(r[1] || ""),
    price: Number(r[2] || 0),
    stock: r[3] === "" || r[3] == null ? null : Number(r[3]),
    active: !["FALSE", "0", "NONAKTIF", "NO"].includes(String(r[4] ?? "TRUE").toUpperCase()),
    photo_url: String(r[5] || ""),
    description: String(r[6] || "")
  }));
}
function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Tidak diketahui";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
async function loadAdminDashboardData(env) {
  const [orderRows, productRows] = await Promise.all([
    readSheet(env, "Pesanan!A2:M"),
    readSheet(env, "Katalog_Produk!A2:G")
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
    return payload.v === 1 && Number(payload.exp) > Math.floor(Date.now() / 1000) && isAdmin(payload.sub, env);
  } catch {
    return false;
  }
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
  if (/^[=+\-@]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;
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
  const rows = await readSheet(env, "Pesanan!A2:T");
  const index = rows.findIndex(r => String(r[0] || "").trim() === String(orderId || "").trim());
  return index < 0 ? null : { rowNumber: index + 2, row: rows[index] };
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
  await ensurePaymentWorkflowHeaders(env);
  const found = await findOrderById(env, orderId);
  if (!found) throw new Error("Pesanan tidak ditemukan.");
  const r = found.row;
  if (String(r[3] || "") !== String(userId)) throw new Error("Pesanan ini bukan milik akun Telegram Anda.");
  const method = String(r[11] || "").toUpperCase();
  if (method === "COD") throw new Error("Pesanan COD dibayar saat pengambilan dan tidak memakai verifikasi pembayaran online.");
  if (PAID_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase()) && String(r[18] || "")) {
    await sendPickupReceipt(env, String(r[3]), r, orderId, String(r[18]));
    await updateTelegramMessage(env, message, { text: "✅ Pembayaran pesanan ini sudah diverifikasi. Resi pengambilan telah dikirim kembali.", replyMarkup: customerMenuKeyboard(), clearMedia: true });
    return;
  }
  if (CANCELLED_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase())) throw new Error("Pesanan ini sudah dibatalkan.");
  if (String(r[13] || "") === "MENUNGGU_VERIFIKASI") {
    await updateTelegramMessage(env, message, {
      text: "⏳ Permintaan verifikasi untuk " + orderId + " sudah tercatat. Kirim foto atau dokumen bukti pembayaran dengan membalas pesan instruksi bot.",
      replyMarkup: customerMenuKeyboard(),
      clearMedia: true
    });
    await sendTelegram(env, chatId, paymentProofPrompt(orderId), { force_reply: true, input_field_placeholder: "Lampirkan foto/dokumen bukti pembayaran" });
    return;
  }
  if (!["MENUNGGU_PEMBAYARAN", "DITOLAK"].includes(String(r[12] || "").toUpperCase())) {
    throw new Error("Status pesanan tidak mengizinkan permintaan verifikasi pembayaran.");
  }
  const requestedAt = new Date().toISOString();
  await updateSheetRange(env, "Pesanan!N" + found.rowNumber + ":T" + found.rowNumber,
    [["MENUNGGU_VERIFIKASI", "", "", requestedAt, "", "", ""]]);
  await updateTelegramMessage(env, message, {
    text: "✅ Permintaan verifikasi pembayaran untuk " + orderId + " telah dikirim ke admin.\n\nSilakan lampirkan bukti transfer/QRIS dengan membalas pesan instruksi bot. Resi pengambilan akan dikirim setelah admin menyetujui pembayaran.",
    replyMarkup: customerMenuKeyboard(),
    clearMedia: true
  });
  await sendTelegram(env, chatId, paymentProofPrompt(orderId), { force_reply: true, input_field_placeholder: "Lampirkan foto/dokumen bukti pembayaran" });
  const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  for (const adminId of admins) {
    try {
      await sendTelegram(env, adminId,
        "🔔 Permintaan verifikasi pembayaran baru\nPesanan: " + orderId + "\nPelanggan: " + String(r[4] || "-") + "\nTotal: " + rupiah(r[10]),
        { inline_keyboard: [[{ text: "Periksa Permintaan", callback_data: "payview:" + found.rowNumber }]] });
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "payment_admin_notify", message: error.message }));
    }
  }
}
async function handlePaymentProofUpload(env, message, chatId, userId) {
  await ensurePaymentWorkflowHeaders(env);
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
    fileId = String(message.photo[message.photo.length - 1].file_id || "");
    fileType = "PHOTO";
  } else if (message.document?.file_id) {
    fileId = String(message.document.file_id);
    fileType = "DOCUMENT";
  } else {
    await sendTelegram(env, chatId, "Mohon kirim bukti sebagai foto atau dokumen dengan membalas pesan instruksi sebelumnya.");
    return;
  }
  await updateSheetRange(env, "Pesanan!O" + found.rowNumber + ":P" + found.rowNumber, [[fileId, fileType]]);
  await sendTelegram(env, chatId, "✅ Bukti pembayaran untuk " + orderId + " berhasil diterima. Admin akan memeriksanya.");
  const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  for (const adminId of admins) {
    try {
      await sendTelegram(env, adminId,
        "📎 Bukti pembayaran diunggah\nPesanan: " + orderId + "\nPelanggan: " + String(r[4] || "-"),
        { inline_keyboard: [[{ text: "Lihat Bukti & Verifikasi", callback_data: "payview:" + found.rowNumber }]] });
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
async function approvePaymentAndIssueTicket(env, rowNumber) {
  await ensurePaymentWorkflowHeaders(env);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan pembayaran sudah diproses.");
  if (String(r[11] || "").toUpperCase() === "COD") throw new Error("Pesanan COD tidak menggunakan verifikasi pembayaran online.");
  if (CANCELLED_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase())) throw new Error("Pesanan sudah dibatalkan.");
  const now = new Date().toISOString();
  const receiptCode = "SEI-" + new Date().toISOString().slice(0,10).replace(/-/g,"") + "-" + crypto.randomUUID().slice(0,6).toUpperCase();
  await updateSheetRange(env, "Pesanan!M" + rowNumber + ":T" + rowNumber, [[
    "DIBAYAR", "DISETUJUI", r[14] || "", r[15] || "", r[16] || now, now, receiptCode, "BELUM_DIAMBIL"
  ]]);
  const ticketUrl = await createPickupTicketUrl(env, String(r[0]), receiptCode);
  return { row:r, receiptCode, ticketUrl };
}
async function rejectPaymentRequest(env, rowNumber) {
  await ensurePaymentWorkflowHeaders(env);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan pembayaran sudah diproses.");
  await updateSheetRange(env, "Pesanan!N" + rowNumber + ":N" + rowNumber, [["DITOLAK"]]);
  return r;
}
async function createPickupTicketToken(env, orderId, receiptCode) {
  const payload = base64url(JSON.stringify({ order: orderId, code: receiptCode, v: 1 }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("SEITON_PICKUP_TICKET_V1." + payload));
  return payload + "." + base64urlBytes(new Uint8Array(sig));
}
async function verifyPickupTicketToken(env, token) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("SEITON_PICKUP_TICKET_V1." + parts[0]));
  if (!constantTimeEqual(base64urlBytes(new Uint8Array(sig)), parts[1])) return null;
  try {
    const encoded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(encoded + "=".repeat((4 - encoded.length % 4) % 4)));
    return payload.v === 1 && payload.order && payload.code ? payload : null;
  } catch { return null; }
}
async function createPickupTicketUrl(env, orderId, receiptCode) {
  const token = await createPickupTicketToken(env, orderId, receiptCode);
  return "https://seiton-order-bot.midzpribadi.workers.dev/pickup?ticket=" + encodeURIComponent(token);
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
  if (!r || !r[0] || String(r[13] || "") !== "DISETUJUI" || !r[18]) throw new Error("Resi pengambilan tidak ditemukan atau belum disetujui.");
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
async function markOrderPickedUp(env, rowNumber) {
  await ensurePaymentWorkflowHeaders(env);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0] || String(r[13] || "") !== "DISETUJUI" || !r[18]) throw new Error("Pesanan tidak memiliki resi pembayaran yang valid.");
  if (String(r[19] || "") === "DIAMBIL") throw new Error("Pesanan ini sudah ditandai diambil.");
  await updateSheetRange(env, "Pesanan!M" + rowNumber + ":T" + rowNumber, [[
    "SELESAI", "DISETUJUI", r[14] || "", r[15] || "", r[16] || "", r[17] || "", r[18], "DIAMBIL"
  ]]);
  return r;
}

function verifyWhatsApp(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && env.WHATSAPP_VERIFY_TOKEN &&
      constantTimeEqual(token || "", env.WHATSAPP_VERIFY_TOKEN)) {
    return new Response(challenge || "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

async function handleWhatsApp(request, env, ctx) {
  if (!env.WHATSAPP_APP_SECRET) {
    return json({ ok: false, error: "WhatsApp signature verification is not configured" }, 503);
  }
  const rawBody = await request.text();
  const signature = request.headers.get("X-Hub-Signature-256") || "";
  if (!(await verifyWhatsAppSignature(rawBody, signature, env.WHATSAPP_APP_SECRET))) {
    return json({ ok: false, error: "Invalid WhatsApp signature" }, 401);
  }
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json({ ok: false }, 400); }
  const changes = payload.entry?.flatMap(entry => entry.changes || []) || [];
  const messages = changes.flatMap(change => change.value?.messages || []);
  const contacts = changes.flatMap(change => change.value?.contacts || []);
  const work = Promise.all(messages.map(async message => {
    if (message.type !== "text" || !message.from) return;
    const text = String(message.text?.body || "").trim();
    const customer = contacts.find(c => c.wa_id === message.from)?.profile?.name || "Pelanggan";
    if (text.toLowerCase().startsWith("/laporan")) {
      if (!isAdmin(message.from, env)) {
        await sendWhatsApp(env, message.from, "⛔ Perintah ini khusus admin.");
      } else {
        await sendWhatsApp(env, message.from, await buildAdminReport(env));
      }
      return;
    }
    if (/^(\/start|\/help|halo|hai)$/i.test(text)) {
      await sendWhatsApp(env, message.from, helpText());
      return;
    }
    const orderInput = parseOrderText(text);
    if (!orderInput) {
      await sendWhatsApp(env, message.from,
        "🛍️ Selamat datang di Seiton.id!\nFormat: beli SKU jumlah metode_pembayaran\nContoh: beli SEI-001 2 QRIS");
      return;
    }
    const result = await createOrder(env, {
      ...orderInput, channel: "whatsapp", customerId: message.from, customerName: customer
    });
    await sendWhatsApp(env, message.from, orderConfirmation(result, env));
  }));
  ctx.waitUntil(work.catch(error => {
    console.error(JSON.stringify({ level: "error", event: "whatsapp_processing", message: error.message }));
  }));
  return json({ ok: true });
}


async function verifyWhatsAppSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const suppliedHex = signatureHeader.slice(7).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(suppliedHex)) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(rawBody)
  ));
  const expectedHex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(expectedHex, suppliedHex);
}

function parseOrderText(text) {
  const match = text.match(/^beli\s+([A-Za-z0-9._-]{1,50})\s+([1-9]\d{0,3})\s+(QRIS|TRANSFER|TRANSFER_BANK|COD)$/i);
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
  const idempotencyKey = `${input.channel}:${input.customerId}:${input.sku}:${input.quantity}:${input.paymentMethod}`;
  if (env.ORDERS_KV) {
    const recent = await env.ORDERS_KV.get(`recent:${idempotencyKey}`, "json");
    if (recent && Date.now() - recent.createdMs < 30000) return { ...recent, duplicate: true };
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
  const shipping = Number(env.DEFAULT_SHIPPING || 0);
  const total = subtotal + shipping;
  const order = {
    orderId: `SEI-${new Date().toISOString().slice(0,10).replaceAll("-", "")}-${crypto.randomUUID().slice(0,8).toUpperCase()}`,
    createdAt: new Date().toISOString(),
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
  if (env.ORDERS_KV) {
    await env.ORDERS_KV.put(`recent:${idempotencyKey}`, JSON.stringify(order), { expirationTtl: 30 });
  }
  return order;
}

async function findProduct(env, sku) {
  const rows = await readSheet(env, "Katalog_Produk!A2:E");
  for (const row of rows) {
    if (String(row[0] || "").trim().toUpperCase() !== sku) continue;
    const price = Number(row[2]);
    const stock = row[3] === "" || row[3] == null ? null : Number(row[3]);
    const active = !["FALSE", "0", "NONAKTIF", "NO"].includes(String(row[4] ?? "TRUE").toUpperCase());
    if (!Number.isFinite(price) || price < 0) throw new Error("Harga produk pada katalog tidak valid");
    return { sku, name: String(row[1] || sku), price, stock: Number.isFinite(stock) ? stock : null, active };
  }
  return null;
}

async function appendOrder(env, order) {
  const row = [
    order.orderId, order.createdAt, order.channel, order.customerId, order.customerName,
    `${order.sku} - ${order.product}`, order.quantity, order.unitPrice, order.subtotal,
    order.shipping, order.total, order.paymentMethod, order.status
  ];
  const token = await getGoogleAccessToken(env);
  const range = encodeURIComponent("Pesanan!A:M");
  const response = await fetch(`${SHEETS_BASE}/${env.GOOGLE_SHEETS_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0,500);
    throw new Error(`Google Sheets append gagal (${response.status}): ${detail}`);
  }
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

async function sendWhatsApp(env, to, text) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.error("WhatsApp credentials are not configured");
    return;
  }
  const response = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text.replace(/\*/g, "").replace(/_/g, "") }
    })
  });
  if (!response.ok) throw new Error(`WhatsApp send gagal (${response.status})`);
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