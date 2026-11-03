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
      try { await answerTelegramCallback(env, update.callback_query.id, "Terjadi kendala. Silakan coba lagi."); } catch {}
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
    await sendTelegram(env, chatId, orderConfirmation(result, env));
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
  const rows = await readSheet(env, "Katalog_Produk!A2:G");
  const index = rows.findIndex(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
  if (index < 0) throw new Error("Produk tidak ditemukan.");
  const meta = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "?fields=sheets.properties");
  if (!meta.ok) throw new Error("Tidak dapat membaca metadata spreadsheet.");
  const metadata = await meta.json();
  const sheet = (metadata.sheets || []).find(x => x.properties?.title === "Katalog_Produk");
  if (!sheet) throw new Error("Tab Katalog_Produk tidak ditemukan.");
  const rowIndex = index + 1;
  const token = await getGoogleAccessToken(env);
  const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + ":batchUpdate", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1
    } } }] })
  });
  if (!response.ok) throw new Error("Gagal menghapus produk: " + (await response.text()).slice(0,300));
}
async function sendTelegramPhoto(env, chatId, photo, caption, replyMarkup = null) {
  const payload = { chat_id: chatId, photo, caption: String(caption).slice(0,1024), disable_notification: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendPhoto", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram sendPhoto gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}

async function answerTelegramCallback(env, callbackId, message = "") {
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/answerCallbackQuery", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: message, show_alert: false })
  });
  if (!response.ok) throw new Error("Telegram answerCallbackQuery gagal (" + response.status + ")");
}
async function handleTelegramCallback(env, query) {
  const chatId = String(query.message?.chat?.id || query.from?.id || "");
  const userId = String(query.from?.id || "");
  const data = String(query.data || "");
  const admin = isAdmin(chatId, env);
  await answerTelegramCallback(env, query.id);
  if (data === "nav:home" || data === "adm:home") {
    const a = data === "adm:home" && admin;
    await sendTelegram(env, chatId, a ? adminMenuText() : customerMenuText(), a ? adminMenuKeyboard() : customerMenuKeyboard()); return;
  }
  if (data === "nav:catalog") {
    const rows = await readSheet(env, "Katalog_Produk!A2:G");
    const products = rows.filter(r => r[0] && !["FALSE","0","NONAKTIF","NO"].includes(String(r[4] ?? "TRUE").toUpperCase())).slice(0, 20);
    if (!products.length) { await sendTelegram(env, chatId, "Katalog belum memiliki produk aktif.", customerMenuKeyboard()); return; }
    await sendTelegram(env, chatId, "🛍️ Katalog produk tersedia:");
    for (const p of products) {
      const sku = String(p[0]).trim();
      const caption = [String(p[1] || sku), "SKU: " + sku, "Harga: " + rupiah(p[2]), "Stok: " + (p[3] === "" ? "Tidak dibatasi" : p[3]), p[6] ? String(p[6]) : ""].filter(Boolean).join("\n");
      const keyboard = { inline_keyboard: [[{ text: "🛒 Pilih Produk Ini", callback_data: "buy:" + sku }]] };
      if (p[5] && /^https:\/\//i.test(String(p[5]))) await sendTelegramPhoto(env, chatId, String(p[5]), caption, keyboard);
      else await sendTelegram(env, chatId, caption, keyboard);
    }
    await sendTelegram(env, chatId, "Pilih produk di atas atau kembali ke menu.", customerMenuKeyboard()); return;
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
    const productKeyboard = { inline_keyboard: [buttons, [{ text: "⬅️ Kembali ke katalog", callback_data: "nav:catalog" }]] };
    if (p[5] && /^https:\/\//i.test(String(p[5]))) await sendTelegramPhoto(env, chatId, String(p[5]), productText, productKeyboard);
    else await sendTelegram(env, chatId, productText, productKeyboard);
    return;
  }
  if (data.startsWith("qty:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new Error("Jumlah tidak valid");
    await sendTelegram(env, chatId, "Jumlah dipilih: " + qty + "\nPilih metode pembayaran:", { inline_keyboard: [
      [{ text: "QRIS", callback_data: "pay:" + sku + ":" + qty + ":QRIS" }],
      [{ text: "Transfer Bank", callback_data: "pay:" + sku + ":" + qty + ":TRANSFER" }],
      [{ text: "COD", callback_data: "pay:" + sku + ":" + qty + ":COD" }],
      [{ text: "⬅️ Kembali", callback_data: "buy:" + sku }]
    ] }); return;
  }
  if (data.startsWith("pay:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]); const method = parts[3];
    if (!["QRIS","TRANSFER","COD"].includes(method)) throw new Error("Metode pembayaran tidak valid");
    const rows = await readSheet(env, "Katalog_Produk!A2:E");
    const p = rows.find(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
    if (!p) throw new Error("Produk tidak ditemukan");
    await sendTelegram(env, chatId, "Konfirmasi pesanan\n\nProduk: " + (p[1] || sku) + "\nJumlah: " + qty + "\nHarga satuan: " + rupiah(p[2]) + "\nTotal: " + rupiah(Number(p[2]) * qty) + "\nPembayaran: " + method + "\n\nLanjutkan membuat pesanan?", { inline_keyboard: [
      [{ text: "✅ Ya, buat pesanan", callback_data: "ok:" + sku + ":" + qty + ":" + method }],
      [{ text: "⬅️ Ubah jumlah", callback_data: "buy:" + sku }],
      [{ text: "🏠 Batal", callback_data: "nav:home" }]
    ] }); return;
  }
  if (data.startsWith("ok:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]); const method = parts[3];
    const result = await createOrder(env, { sku: sku.toUpperCase(), quantity: qty, paymentMethod: method,
      channel: "telegram", customerId: userId, customerName: [query.from.first_name, query.from.last_name].filter(Boolean).join(" ") });
    await sendTelegram(env, chatId, orderConfirmation(result, env), customerMenuKeyboard()); return;
  }
  if (data === "nav:orders") {
    const rows = await readSheet(env, "Pesanan!A2:M");
    const mine = rows.filter(r => String(r[3] || "") === userId).slice(-5).reverse();
    const lines = mine.map(r => String(r[0]) + " | " + String(r[5]) + " | " + String(r[6]) + " pcs | " + rupiah(r[10]) + " | " + String(r[12]));
    await sendTelegram(env, chatId, mine.length ? "Lima pesanan terakhir:\n\n" + lines.join("\n") : "Belum ada pesanan atas akun Telegram ini.", customerMenuKeyboard()); return;
  }
  if (data === "nav:help") {
    await sendTelegram(env, chatId, "Bantuan Seiton.id\nPilih Belanja Produk untuk membuat pesanan melalui tombol. Untuk bantuan admin, silakan hubungi admin toko.", customerMenuKeyboard()); return;
  }
  if (data.startsWith("adm:")) {
    if (!admin) return sendTelegram(env, chatId, "⛔ Menu ini khusus admin.");
    const action = data.slice(4);
    if (action === "report") { await sendTelegram(env, chatId, await buildAdminReport(env), adminMenuKeyboard()); return; }
    if (action === "addproduct") { await ensureCatalogHeaders(env); await promptAdminProduct(env, chatId, "ADD"); return; }
    if (action === "catalog") {
      await ensureCatalogHeaders(env);
      const rows = await readSheet(env, "Katalog_Produk!A2:G");
      const products = rows.map((r,i) => ({ r, row:i+2 })).filter(x => x.r[0]).slice(0,30);
      if (!products.length) { await sendTelegram(env, chatId, "Katalog masih kosong.", adminCatalogKeyboard()); return; }
      await sendTelegram(env, chatId, "📦 Katalog admin — pilih produk untuk mengatur atau menghapus:");
      for (const x of products) {
        const r = x.r; const sku = String(r[0]).trim();
        const caption = [String(r[1] || sku) + " (" + sku + ")", "Harga: " + rupiah(r[2]), "Stok: " + r[3], "Status: " + (r[4] ?? "TRUE"), r[6] || ""].filter(Boolean).join("\n");
        const keyboard = { inline_keyboard: [
          [{ text: "✏️ Atur Produk", callback_data: "prod:edit:" + sku }, { text: "🗑️ Hapus", callback_data: "prod:delete:" + sku }],
          [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
        ] };
        if (r[5] && /^https:\/\//i.test(String(r[5]))) await sendTelegramPhoto(env, chatId, String(r[5]), caption, keyboard);
        else await sendTelegram(env, chatId, caption, keyboard);
      }
      return;
    }
    if (action === "recent" || action === "statuslist") {
      const rows = await readSheet(env, "Pesanan!A2:M");
      const recent = rows.map((r,i) => ({ r, row:i+2 })).filter(x => x.r[0]).slice(-10).reverse();
      if (!recent.length) { await sendTelegram(env, chatId, "Belum ada pesanan.", adminMenuKeyboard()); return; }
      const buttons = recent.map(x => [{ text: String(x.r[0]).slice(0,22) + " · " + String(x.r[12] || "BARU").slice(0,18),
        callback_data: (action === "statuslist" ? "st:" : "detail:") + x.row }]);
      buttons.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
      const summary = recent.map(x => String(x.r[0]) + " | " + String(x.r[5]) + " | " + rupiah(x.r[10]) + " | " + String(x.r[12])).join("\n");
      await sendTelegram(env, chatId, action === "statuslist" ? "Pilih pesanan yang statusnya ingin diperbarui:" : "10 pesanan terbaru:\n\n" + summary, { inline_keyboard: buttons }); return;
    }
  }
  if (data.startsWith("prod:edit:")) {
    if (!admin) return sendTelegram(env, chatId, "⛔ Menu ini khusus admin.");
    await promptAdminProduct(env, chatId, "EDIT", data.slice("prod:edit:".length)); return;
  }
  if (data.startsWith("prod:delete:")) {
    if (!admin) return sendTelegram(env, chatId, "⛔ Menu ini khusus admin.");
    const sku = data.slice("prod:delete:".length);
    await sendTelegram(env, chatId, "Yakin ingin menghapus produk " + sku + "? Baris katalog akan dihapus permanen. Riwayat pesanan tidak ikut terhapus.", { inline_keyboard: [
      [{ text: "🗑️ Ya, hapus permanen", callback_data: "prod:delok:" + sku }],
      [{ text: "Batal", callback_data: "adm:catalog" }]
    ] }); return;
  }
  if (data.startsWith("prod:delok:")) {
    if (!admin) return sendTelegram(env, chatId, "⛔ Menu ini khusus admin.");
    await deleteCatalogProduct(env, data.slice("prod:delok:".length));
    await sendTelegram(env, chatId, "✅ Produk berhasil dihapus dari katalog.", adminMenuKeyboard()); return;
  }
  if (data.startsWith("detail:")) {
    if (!admin) return sendTelegram(env, chatId, "⛔ Menu ini khusus admin.");
    const rowNum = Number(data.split(":")[1]);
    const rows = await readSheet(env, "Pesanan!A" + rowNum + ":M" + rowNum); const r = rows[0];
    if (!r) throw new Error("Pesanan tidak ditemukan");
    await sendTelegram(env, chatId, "Detail Pesanan\nID: " + r[0] + "\nPelanggan: " + r[4] + " (" + r[3] + ")\nProduk: " + r[5] + "\nJumlah: " + r[6] + "\nTotal: " + rupiah(r[10]) + "\nPembayaran: " + r[11] + "\nStatus: " + r[12], { inline_keyboard: [
      [{ text: "🔄 Perbarui Status", callback_data: "st:" + rowNum }],
      [{ text: "⬅️ Pesanan Terbaru", callback_data: "adm:recent" }]
    ] }); return;
  }
  if (data.startsWith("st:")) {
    if (!admin) return sendTelegram(env, chatId, "⛔ Menu ini khusus admin.");
    const rowNum = Number(data.split(":")[1]);
    await sendTelegram(env, chatId, "Pilih status baru:", { inline_keyboard: [
      [{ text: "Menunggu Pembayaran", callback_data: "su:" + rowNum + ":MENUNGGU_PEMBAYARAN" }],
      [{ text: "Dibayar", callback_data: "su:" + rowNum + ":DIBAYAR" }],
      [{ text: "Diproses", callback_data: "su:" + rowNum + ":DIPROSES" }],
      [{ text: "Dikirim", callback_data: "su:" + rowNum + ":DIKIRIM" }],
      [{ text: "Selesai", callback_data: "su:" + rowNum + ":SELESAI" }],
      [{ text: "Dibatalkan", callback_data: "su:" + rowNum + ":DIBATALKAN" }],
      [{ text: "⬅️ Kembali", callback_data: "detail:" + rowNum }]
    ] }); return;
  }
  if (data.startsWith("su:")) {
    if (!admin) return sendTelegram(env, chatId, "⛔ Menu ini khusus admin.");
    const parts = data.split(":"); const rowNum = Number(parts[1]); const status = parts[2];
    const allowed = ["MENUNGGU_PEMBAYARAN","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"];
    if (!Number.isInteger(rowNum) || rowNum < 2 || !allowed.includes(status)) throw new Error("Pembaruan status tidak valid");
    const token = await getGoogleAccessToken(env); const range = encodeURIComponent("Pesanan!M" + rowNum);
    const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "/values/" + range + "?valueInputOption=USER_ENTERED", {
      method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[status]] })
    });
    if (!response.ok) throw new Error("Pembaruan status gagal (" + response.status + "): " + (await response.text()).slice(0,300));
    await sendTelegram(env, chatId, "✅ Status pesanan berhasil diperbarui menjadi " + status + ".", adminMenuKeyboard()); return;
  }
  await sendTelegram(env, chatId, admin ? adminMenuText() : customerMenuText(), admin ? adminMenuKeyboard() : customerMenuKeyboard());
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
  const paid = orders.filter(o => ["DIBAYAR", "SELESAI", "PAID", "COMPLETED"].includes(o.status.toUpperCase()));
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