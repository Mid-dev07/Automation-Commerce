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
  const message = update.message || update.edited_message;
  if (!message || !message.chat || !message.from) return json({ ok: true });

  const text = String(message.text || message.caption || "").trim();
  const chatId = String(message.chat.id);
  const customerId = String(message.from.id);
  const customerName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  const work = (async () => {
    if (text.startsWith("/laporan")) {
      if (!isAdmin(chatId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const report = await buildAdminReport(env);
      await sendTelegram(env, chatId, report);
      return;
    }
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendTelegram(env, chatId, helpText());
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

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN belum diatur");
  const response = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true })
  });
  if (!response.ok) throw new Error(`Telegram sendMessage gagal (${response.status})`);
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