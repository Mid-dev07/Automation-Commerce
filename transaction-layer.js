import { DurableObject } from "cloudflare:workers";
import {
  addDigitalStockD1,
  deleteDigitalStockD1,
  claimDigitalStockD1,
  listWaitingDigitalFulfillmentsD1
} from "./digital-products.mjs";

const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const PAID_STATUSES = new Set(["DIBAYAR", "DIPROSES", "DIKIRIM", "SELESAI", "PAID", "COMPLETED"]);
const CANCELLED_STATUSES = new Set(["DIBATALKAN", "CANCELLED", "CANCELED"]);
const ONLINE_METHODS = new Set(["QRIS", "TRANSFER", "TRANSFER_BANK"]);

function nowJakarta() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().replace("Z", "+07:00");
}
function dateStamp(value) {
  const d = new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d).replace(/-/g, "");
}
function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}
function adminActivityAuditStatement(db, actor, action, resourceId, summary, at, sourceKey) {
  const actorValue = clean(actor, 128);
  const actorChannel = actorValue.startsWith("telegram") ? "telegram" : "web";
  const actorId = actorValue.startsWith("telegram:") ? actorValue.slice("telegram:".length) : actorValue;
  const createdAtMs = Date.parse(at);
  if (!actorId || !Number.isFinite(createdAtMs)) return null;
  return db.prepare(
    "INSERT INTO admin_activity_audit(audit_id,actor_channel,actor_id,action,resource_type,resource_id,summary_json,created_at_ms) " +
    "SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (" +
      "SELECT 1 FROM order_events WHERE order_id=? AND event_type=? AND source_key=?" +
    ")"
  ).bind(
    crypto.randomUUID(), actorChannel, actorId, action, "order", String(resourceId),
    JSON.stringify(summary || {}), createdAtMs, String(resourceId), action, sourceKey
  );
}
function asSafeMoney(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(label + " tidak valid.");
  return n;
}
function rowToObject(row) {
  if (!row) return null;
  return {
    order_id: row[0], created_at: row[1], channel: row[2], customer_id: row[3],
    customer_name: row[4], product: row[5], quantity: Number(row[6] || 0),
    unit_price: Number(row[7] || 0), subtotal: Number(row[8] || 0),
    shipping: Number(row[9] || 0), total: Number(row[10] || 0),
    payment_method: row[11], status: row[12], payment_confirmation_status: row[13],
    payment_proof_file_id: row[14], payment_proof_type: row[15],
    payment_requested_at: row[16], payment_confirmed_at: row[17],
    receipt_code: row[18], pickup_status: row[19], legacy_sheet_row: row[20]
  };
}
export function orderToSheetRow(o) {
  return [
    o.order_id, o.created_at, o.channel, o.customer_id, o.customer_name,
    String(o.sku || "") + " - " + String(o.product_name || ""),
    o.quantity, o.unit_price, o.subtotal, o.shipping, o.total, o.payment_method, o.status,
    o.payment_confirmation_status || "", o.payment_proof_file_id || "",
    o.payment_proof_type || "", o.payment_requested_at || "", o.payment_confirmed_at || "",
    o.receipt_code || "", o.pickup_status || ""
  ];
}
export function orderToDashboard(o) {
  return {
    order_id: o.order_id, created_at: o.created_at, channel: o.channel,
    customer_id: o.customer_id, customer_name: o.customer_name,
    product: String(o.sku || "") + " - " + String(o.product_name || ""),
    quantity: Number(o.quantity), unit_price: Number(o.unit_price),
    subtotal: Number(o.subtotal), shipping: Number(o.shipping), total: Number(o.total),
    payment_method: o.payment_method, status: o.status,
    payment_confirmation_status: o.payment_confirmation_status || "",
    payment_proof_file_id: o.payment_proof_file_id || "",
    payment_proof_type: o.payment_proof_type || "",
    payment_requested_at: o.payment_requested_at || "",
    payment_confirmed_at: o.payment_confirmed_at || "",
    receipt_code: o.receipt_code || "", pickup_status: o.pickup_status || ""
  };
}
export function productToDashboard(p) {
  return {
    sku: p.sku, name: p.name, price: Number(p.price),
    price_valid: true, stock: p.stock == null ? null : Number(p.stock),
    stock_valid: true, active: Boolean(p.active),
    photo_url: p.photo_url || "", description: p.description || ""
  };
}

async function isReady(db) {
  if (!db) return false;
  try {
    const row = await db.prepare("SELECT value FROM app_meta WHERE key = 'transaction_store_state'").first();
    return row?.value === "READY";
  } catch {
    return false;
  }
}
export async function transactionReadiness(env) {
  const configured = Boolean(env.DB);
  const ready = Boolean(env.ORDER_COORDINATOR) && await isReady(env.DB);
  return { configured, ready, coordinator: Boolean(env.ORDER_COORDINATOR) };
}
async function requireReady(db) {
  if (!(await isReady(db))) throw new Error("Lapisan transaksi D1 belum diaktifkan. Admin perlu menjalankan /migrasi_d1 di bot.");
}
function orderId() {
  return "SEI-" + dateStamp(new Date()) + "-" + crypto.randomUUID().slice(0, 8).toUpperCase();
}
function idempotencyKey(input) {
  const raw = clean(input.idempotencyKey, 128);
  return raw ? "update:" + clean(input.channel || "unknown", 24) + ":" + raw : "request:" + crypto.randomUUID();
}
function checkChanges(result, message) {
  if (!result?.meta || Number(result.meta.changes) !== 1) throw new Error(message);
}


function sheetMirrorStatement(db,id,at) {
  return db.prepare(`INSERT INTO outbox
    (event_type,aggregate_id,payload_json,status,attempts,available_at,created_at)
    SELECT 'SHEET_MIRROR',order_id,json_object('order_id',order_id),'PENDING',0,?,?
    FROM orders WHERE order_id=?
    ON CONFLICT(event_type,aggregate_id) DO UPDATE SET
      payload_json=excluded.payload_json,status='PENDING',attempts=0,
      available_at=excluded.available_at,processed_at=NULL`).bind(at,at,id);
}

async function createOrderD1(db, input) {
  await requireReady(db);
  const sku = clean(input.sku, 40).toUpperCase();
  const qty = Number(input.quantity);
  if (!/^[A-Z0-9._-]{1,40}$/.test(sku)) throw new Error("SKU produk tidak valid.");
  if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new Error("Jumlah pesanan tidak valid.");
  const method = clean(input.paymentMethod, 20).toUpperCase();
  if (!["QRIS", "TRANSFER", "COD"].includes(method)) throw new Error("Metode pembayaran tidak valid.");
  const dedupe = idempotencyKey(input);
  const prior = await db.prepare("SELECT * FROM orders WHERE idempotency_key = ?").bind(dedupe).first();
  if (prior) return { ...prior, duplicate: true, created: false, stock_reserved: Boolean(prior.stock_reserved) };
  const product = await db.prepare("SELECT sku, name, price, stock, active FROM catalog_products WHERE sku = ? COLLATE NOCASE").bind(sku).first();
  if (!product || !product.active) throw new Error("Produk tidak ditemukan atau sedang nonaktif.");
  const price = asSafeMoney(product.price, "Harga produk");
  if (price > Math.floor(SAFE_INTEGER / qty)) throw new Error("Subtotal pesanan melebihi batas angka aman.");
  const shipping = asSafeMoney(input.shipping ?? 0, "Ongkir");
  const subtotal = price * qty;
  if (!Number.isSafeInteger(subtotal + shipping)) throw new Error("Total pesanan melebihi batas angka aman.");
  if (product.stock !== null && Number(product.stock) < qty) {
    throw new Error("Stok tidak mencukupi. Stok tersedia: " + product.stock);
  }

  const createdAt = nowJakarta();
  const createdMs = Date.now();
  const id = orderId();
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO orders (
      order_id,idempotency_key,created_at,created_ms,channel,customer_id,customer_name,
      sku,product_name,quantity,unit_price,subtotal,shipping,total,payment_method,status,
      stock_reserved,updated_at
    )
    SELECT ?,?,?,?,?,?,?,p.sku,p.name,?,p.price,p.price*?, ?,p.price*?+?, ?, ?,1,?
    FROM catalog_products p
    WHERE p.sku = ? COLLATE NOCASE AND p.active = 1
      AND (p.stock IS NULL OR p.stock >= ?)`).bind(
        id, dedupe, createdAt, createdMs, clean(input.channel || "telegram",24),
        clean(input.customerId,128), clean(input.customerName || "Pelanggan",100),
        qty, qty, shipping, qty, shipping, method, "MENUNGGU_PEMBAYARAN",
        createdAt, sku, qty
      ),
    db.prepare(`INSERT OR IGNORE INTO inventory_movements(order_id,sku,movement_type,quantity,created_at)
      SELECT order_id,sku,'RESERVE',quantity,? FROM orders
      WHERE order_id=? AND stock_reserved=1`).bind(createdAt, id),
    db.prepare(`INSERT OR IGNORE INTO order_events
      (order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at)
      SELECT order_id,'ORDER_CREATED','','MENUNGGU_PEMBAYARAN',? ,?, '{}',?
      FROM orders WHERE order_id=?`).bind(clean(input.channel || "telegram",24), dedupe, createdAt, id),
    sheetMirrorStatement(db,id,createdAt)
  ]);
  const current = await db.prepare("SELECT * FROM orders WHERE idempotency_key = ?").bind(dedupe).first();
  if (current) {
    const created = current.order_id === id;
    return { ...current, duplicate: !created, created: created, stock_reserved: Boolean(current.stock_reserved) };
  }
  const fresh = await db.prepare("SELECT stock,active FROM catalog_products WHERE sku=? COLLATE NOCASE").bind(sku).first();
  if (!fresh || !fresh.active) throw new Error("Produk tidak ditemukan atau sedang nonaktif.");
  if (fresh.stock !== null && Number(fresh.stock) < qty) {
    throw new Error("Stok tidak mencukupi. Stok tersedia: " + fresh.stock);
  }
  if (results?.[0]?.meta?.changes !== 1) throw new Error("Pesanan gagal dicatat. Silakan coba kembali.");
  throw new Error("Pesanan gagal dicatat.");
}

async function getOrderD1(db, id) {
  await requireReady(db);
  const o = await db.prepare("SELECT * FROM orders WHERE order_id = ?").bind(String(id)).first();
  return o || null;
}
async function getOrderByLegacyRowD1(db, rowNumber) {
  await requireReady(db);
  const o = await db.prepare("SELECT * FROM orders WHERE legacy_sheet_row = ?").bind(Number(rowNumber)).first();
  return o || null;
}
async function listOrdersD1(db, options = {}) {
  await requireReady(db);
  const limit = Math.min(10000, Math.max(1, Number(options.limit) || 2000));
  const rows = await db.prepare("SELECT * FROM orders ORDER BY created_ms DESC LIMIT ?").bind(limit).all();
  return rows.results || [];
}
async function listProductsD1(db, includeInactive = true) {
  await requireReady(db);
  const sql = includeInactive
    ? "SELECT * FROM catalog_products ORDER BY name COLLATE NOCASE"
    : "SELECT * FROM catalog_products WHERE active = 1 ORDER BY name COLLATE NOCASE";
  const rows = await db.prepare(sql).all();
  return rows.results || [];
}
async function getProductD1(db, sku) {
  await requireReady(db);
  return db.prepare("SELECT * FROM catalog_products WHERE sku=? COLLATE NOCASE").bind(clean(sku,40)).first();
}

function catalogMirrorStatement(db,sku,at) {
  return db.prepare(`INSERT INTO outbox
    (event_type,aggregate_id,payload_json,status,attempts,available_at,created_at)
    SELECT 'CATALOG_MIRROR',sku,json_object('sku',sku),'PENDING',0,?,?
    FROM catalog_products WHERE sku=? COLLATE NOCASE
    ON CONFLICT(event_type,aggregate_id) DO UPDATE SET
      payload_json=excluded.payload_json,status='PENDING',attempts=0,
      available_at=excluded.available_at,processed_at=NULL`).bind(at,at,sku);
}

async function saveProductD1(db, product, originalSku = "") {
  await requireReady(db);
  const sku = clean(product.sku,40), name = clean(product.name,100);
  const price = asSafeMoney(product.price,"Harga");
  const stock = product.stock == null || product.stock === "" ? null : asSafeMoney(product.stock,"Stok");
  const photo = clean(product.photo_url,1000), description = clean(product.description,500);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new Error("SKU produk tidak valid.");
  if (!name) throw new Error("Nama produk wajib diisi.");
  if (typeof product.active !== "boolean") throw new Error("Status aktif harus boolean.");
  if (photo && !/^https:\/\//i.test(photo)) throw new Error("URL foto harus HTTPS.");
  const editing = Boolean(originalSku);
  if (editing && sku.toUpperCase() !== String(originalSku).toUpperCase()) throw new Error("SKU tidak boleh diubah saat mengedit produk.");
  const old = await getProductD1(db, editing ? originalSku : sku);
  if (editing && !old) throw new Error("Produk yang akan diedit tidak ditemukan.");
  const time = nowJakarta();
  if (old) {
    await db.batch([
      db.prepare(`UPDATE catalog_products SET name=?,price=?,stock=?,active=?,photo_url=?,description=?,updated_at=? WHERE sku=? COLLATE NOCASE`)
        .bind(name,price,stock,product.active?1:0,photo,description,time,old.sku),
      catalogMirrorStatement(db,old.sku,time)
    ]);
    return "updated";
  }
  await db.batch([
    db.prepare(`INSERT INTO catalog_products(sku,name,price,stock,active,photo_url,description,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).bind(sku,name,price,stock,product.active?1:0,photo,description,time),
    catalogMirrorStatement(db,sku,time)
  ]);
  return "created";
}
async function deleteProductD1(db, sku) {
  await requireReady(db);
  const old = await getProductD1(db,sku);
  if (!old) throw new Error("Produk tidak ditemukan.");
  const at=nowJakarta();
  await db.batch([
    db.prepare("UPDATE catalog_products SET active=0,updated_at=? WHERE sku=? COLLATE NOCASE").bind(at,old.sku),
    catalogMirrorStatement(db,old.sku,at)
  ]);
  return { sku: old.sku };
}
async function setLegacySheetRowD1(db, id, rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) return;
  await db.prepare("UPDATE orders SET legacy_sheet_row=? WHERE order_id=? AND legacy_sheet_row IS NULL")
    .bind(rowNumber,id).run();
}
async function recordOrderEvent(db, id, eventType, fromStatus, toStatus, actor, sourceKey, at, payload = {}) {
  await db.prepare(`INSERT OR IGNORE INTO order_events
    (order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(id,eventType,fromStatus||"",toStatus||"",actor||"",sourceKey||crypto.randomUUID(),JSON.stringify(payload),at).run();
}
async function requestVerificationD1(db, id, customerId) {
  await requireReady(db);
  const o = await getOrderD1(db,id);
  if (!o) throw new Error("Pesanan tidak ditemukan.");
  if (String(o.customer_id) !== String(customerId)) throw new Error("Pesanan ini bukan milik akun Telegram Anda.");
  if (!ONLINE_METHODS.has(String(o.payment_method).toUpperCase())) throw new Error("Metode pembayaran tidak didukung untuk verifikasi online.");
  if (PAID_STATUSES.has(String(o.status).toUpperCase()) && o.receipt_code) return { ...o, alreadyPaid: true };
  if (CANCELLED_STATUSES.has(String(o.status).toUpperCase())) throw new Error("Pesanan ini sudah dibatalkan.");
  if (!["MENUNGGU_PEMBAYARAN","DITOLAK"].includes(String(o.status).toUpperCase())) {
    throw new Error("Status pesanan tidak mengizinkan permintaan verifikasi pembayaran.");
  }
  if (String(o.payment_confirmation_status).toUpperCase() === "MENUNGGU_VERIFIKASI") return o;
  const at = nowJakarta();
  const results = await db.batch([
    db.prepare("UPDATE orders SET payment_confirmation_status='MENUNGGU_VERIFIKASI',payment_proof_file_id='',payment_proof_type='',payment_requested_at=?,updated_at=? WHERE order_id=? AND status=? AND payment_confirmation_status IN ('','DITOLAK')").bind(at,at,id,o.status),
    db.prepare("INSERT INTO order_events(order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at) SELECT order_id,'PAYMENT_REQUESTED',?,?,?,?,'{}',? FROM orders WHERE order_id=? AND payment_confirmation_status='MENUNGGU_VERIFIKASI' AND updated_at=?").bind(o.payment_confirmation_status||"","MENUNGGU_VERIFIKASI",clean(customerId,128),"request:"+at,at,id,at),
    sheetMirrorStatement(db,id,at)
  ]);
  if (Number(results[0].meta?.changes) !== 1) {
    const latest = await getOrderD1(db,id);
    if (latest?.payment_confirmation_status === "MENUNGGU_VERIFIKASI") return latest;
    throw new Error("Permintaan verifikasi sudah berubah. Muat ulang pesanan.");
  }
  return getOrderD1(db,id);
}
async function savePaymentProofD1(db,id,customerId,fileId,fileType) {
  await requireReady(db);
  const at=nowJakarta();
  const results=await db.batch([
    db.prepare("UPDATE orders SET payment_proof_file_id=?,payment_proof_type=?,updated_at=? WHERE order_id=? AND customer_id=? AND payment_confirmation_status='MENUNGGU_VERIFIKASI' AND status NOT IN ('DIBATALKAN','CANCELLED','CANCELED')").bind(fileId,fileType,at,id,String(customerId)),
    db.prepare("INSERT INTO order_events(order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at) SELECT order_id,'PAYMENT_PROOF_UPLOADED','','MENUNGGU_VERIFIKASI',?,?,?,? FROM orders WHERE order_id=? AND payment_proof_file_id=? AND updated_at=?").bind(clean(customerId,128),"proof:"+fileId,JSON.stringify({file_type:fileType}),at,id,fileId,at),
    sheetMirrorStatement(db,id,at)
  ]);
  checkChanges(results[0],"Permintaan pembayaran tidak sedang menunggu verifikasi.");
  return getOrderD1(db,id);
}
async function approvePaymentD1(db,id,actor="admin") {
  await requireReady(db);
  const o=await getOrderD1(db,id);
  if(!o)throw new Error("Pesanan tidak ditemukan.");
  const method=String(o.payment_method||"").toUpperCase();
  if(!ONLINE_METHODS.has(method))throw new Error("Hanya pembayaran QRIS/transfer yang dapat diverifikasi.");
  if(CANCELLED_STATUSES.has(String(o.status).toUpperCase()))throw new Error("Pesanan sudah dibatalkan.");
  if (String(o.payment_confirmation_status).toUpperCase() === "DISETUJUI" && o.receipt_code) {
    return { ...o, alreadyApproved: true };
  }

  // QRIS approval is guarded by the payment ledger, not just by the order row.
  // A readable amount mismatch or a reused/mismatched receipt must never be approved.
  const isQris=method==="QRIS";
  if(isQris){
    const payment=await db.prepare(
      "SELECT status,base_amount,unique_code,expected_amount,receipt_file_id,ocr_status,ocr_amount " +
      "FROM qris_payments WHERE order_id=? LIMIT 1"
    ).bind(id).first();
    if(!payment||!String(payment.receipt_file_id||"")) {
      throw new Error("Bukti QRIS belum tersedia. Minta pelanggan mengunggah bukti pembayaran.");
    }
    const base=Number(payment.base_amount),suffix=Number(payment.unique_code),expected=Number(payment.expected_amount);
    if(!Number.isSafeInteger(base)||base!==Number(o.total)||!Number.isInteger(suffix)||suffix<1||suffix>999
      ||!Number.isSafeInteger(expected)||expected!==base+suffix) {
      throw new Error("Nominal QRIS tidak konsisten dengan total pesanan. Tahan persetujuan dan periksa transaksi.");
    }
    if(String(payment.status||"").toUpperCase()==="PAID") {
      throw new Error("QRIS sudah tercatat lunas, tetapi status pesanan belum sinkron. Jangan setujui ulang; lakukan rekonsiliasi.");
    }
    if(String(payment.ocr_status||"").toUpperCase()==="MISMATCH"
      ||String(payment.status||"").toUpperCase()==="OCR_MISMATCH"
      ||(payment.ocr_amount!==null&&payment.ocr_amount!==undefined&&Number(payment.ocr_amount)!==expected)) {
      throw new Error("Bukti QRIS terdeteksi tidak cocok dengan nominal tagihan. Minta bukti yang benar sebelum menyetujui.");
    }
  }

  const at=nowJakarta(), code="SEI-"+dateStamp(at)+"-"+crypto.randomUUID().slice(0,6).toUpperCase();
  const sourceKey = "approve:" + code;
  const statements=[
    db.prepare(`UPDATE orders SET status='DIBAYAR',payment_confirmation_status='DISETUJUI',
      payment_confirmed_at=?,receipt_code=?,pickup_status='BELUM_DIAMBIL',updated_at=?
      WHERE order_id=? AND payment_confirmation_status='MENUNGGU_VERIFIKASI'
        AND status NOT IN ('DIBATALKAN','CANCELLED','CANCELED')
        AND (payment_method<>'QRIS' OR EXISTS (
          SELECT 1 FROM qris_payments qp WHERE qp.order_id=orders.order_id
            AND qp.status<>'PAID' AND qp.receipt_file_id<>''
            AND qp.base_amount=orders.total AND qp.expected_amount=qp.base_amount+qp.unique_code
            AND qp.ocr_status<>'MISMATCH'
            AND (qp.ocr_amount IS NULL OR qp.ocr_amount=qp.expected_amount)
        ))`).bind(at,code,at,id)
  ];
  if(isQris){
    statements.push(db.prepare(`UPDATE qris_payments SET status='PAID',reviewed_by=?,reviewed_at=?,paid_at=?,updated_at=?
      WHERE order_id=? AND status<>'PAID' AND receipt_file_id<>''
        AND base_amount=? AND expected_amount=base_amount+unique_code
        AND ocr_status<>'MISMATCH' AND (ocr_amount IS NULL OR ocr_amount=expected_amount)
        AND EXISTS (SELECT 1 FROM orders o WHERE o.order_id=qris_payments.order_id
          AND o.payment_confirmation_status='DISETUJUI' AND o.receipt_code=?)`)
      .bind(clean(actor,100),at,at,at,id,Number(o.total),code));
  }
  statements.push(
    db.prepare(`INSERT INTO order_events(order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at)
      SELECT order_id,'PAYMENT_APPROVED',?,'DIBAYAR',?,?, '{}',? FROM orders
      WHERE order_id=? AND receipt_code=?`).bind(o.status,clean(actor,128),sourceKey,at,id,code),
    adminActivityAuditStatement(db,actor,"PAYMENT_APPROVED",id,{from_status:String(o.status||""),to_status:"DIBAYAR",transition_type:"order_status"},at,sourceKey),
    sheetMirrorStatement(db,id,at)
  );
  const results=await db.batch(statements.filter(Boolean));
  checkChanges(results[0],"Permintaan pembayaran sudah diproses atau status pesanan tidak memenuhi syarat.");
  if(isQris)checkChanges(results[1],"Pembaruan QRIS tidak berhasil. Status pembayaran tidak dapat disahkan.");
  return getOrderD1(db,id);
}

async function rejectPaymentD1(db,id,actor="admin") {
  await requireReady(db);
  const o=await getOrderD1(db,id);
  if(!o)throw new Error("Pesanan tidak ditemukan.");
  const at=nowJakarta();
  const sourceKey = "reject:" + at;
  const results=await db.batch([
    db.prepare(`UPDATE orders SET payment_confirmation_status='DITOLAK',updated_at=?
      WHERE order_id=? AND payment_confirmation_status='MENUNGGU_VERIFIKASI'
        AND status NOT IN ('DIBATALKAN','CANCELLED','CANCELED')`).bind(at,id),
    db.prepare(`INSERT INTO order_events(order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at)
      SELECT order_id,'PAYMENT_REJECTED','MENUNGGU_VERIFIKASI','DITOLAK',?,?, '{}',?
      FROM orders WHERE order_id=? AND payment_confirmation_status='DITOLAK' AND updated_at=?`)
      .bind(clean(actor,128),sourceKey,at,id,at),
    adminActivityAuditStatement(db,actor,"PAYMENT_REJECTED",id,{from_status:"MENUNGGU_VERIFIKASI",to_status:"DITOLAK",transition_type:"payment_confirmation"},at,sourceKey),
    sheetMirrorStatement(db,id,at)
  ].filter(Boolean));
  checkChanges(results[0],"Permintaan pembayaran sudah diproses.");
  return getOrderD1(db,id);
}
async function setOrderStatusD1(db,id,status,actor="admin") {
  await requireReady(db);
  const o=await getOrderD1(db,id);
  if(!o)throw new Error("Pesanan tidak ditemukan.");
  const current=String(o.status).toUpperCase();
  if (CANCELLED_STATUSES.has(current)) {
    throw new Error("Pesanan yang sudah dibatalkan tidak dapat dibuka kembali. Buat pesanan baru.");
  }
  if (current === String(status).toUpperCase()) return { ...o, noStatusChange: true };
  const progress = ["MENUNGGU_PEMBAYARAN","MENUNGGU_VERIFIKASI","DITOLAK","DIBAYAR","DIPROSES","DIKIRIM","SELESAI"];
  const currentRank = progress.indexOf(current);
  const nextRank = progress.indexOf(String(status).toUpperCase());
  if (currentRank >= 3 && nextRank >= 0 && nextRank < currentRank) {
    throw new Error("Status pesanan yang sudah dibayar tidak boleh dimundurkan.");
  }
  if(status==="DIBATALKAN" && PAID_STATUSES.has(current)) {
    throw new Error("Pesanan yang sudah dibayar tidak dapat dibatalkan. Refund perlu dicatat terpisah.");
  }
  if(["DIBAYAR","DIPROSES","DIKIRIM","SELESAI"].includes(status) &&
    ONLINE_METHODS.has(String(o.payment_method).toUpperCase()) &&
    String(o.payment_confirmation_status).toUpperCase()!=="DISETUJUI") {
    throw new Error("Pembayaran QRIS/transfer harus disetujui melalui menu Verifikasi Pembayaran.");
  }
  const at=nowJakarta();
  const stmts=[
    db.prepare("UPDATE orders SET status=?,updated_at=? WHERE order_id=? AND status=?")
      .bind(status,at,id,o.status)
  ];
  if(status==="DIBATALKAN") {
    stmts.push(db.prepare(`INSERT OR IGNORE INTO inventory_movements(order_id,sku,movement_type,quantity,created_at)
      SELECT order_id,sku,'RELEASE',quantity,? FROM orders
      WHERE order_id=? AND status='DIBATALKAN' AND stock_reserved=1`).bind(at,id));
    stmts.push(db.prepare(`UPDATE orders SET stock_reserved=0,updated_at=?
      WHERE order_id=? AND status='DIBATALKAN' AND stock_reserved=1
        AND EXISTS(SELECT 1 FROM inventory_movements WHERE order_id=? AND movement_type='RELEASE')`).bind(at,id,id));
  }
  const sourceKey = "status:" + crypto.randomUUID();
  stmts.push(db.prepare(`INSERT INTO order_events(order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at)
    SELECT order_id,'STATUS_CHANGED',?,?,?,?,?,? FROM orders
    WHERE order_id=? AND status=? AND updated_at=?`)
    .bind(o.status,status,clean(actor,128),sourceKey,"{}",at,id,status,at));
  stmts.push(adminActivityAuditStatement(db,actor,"STATUS_CHANGED",id,{
    from_status:String(o.status||""),to_status:String(status).toUpperCase(),transition_type:"order_status"
  },at,sourceKey));
  stmts.push(sheetMirrorStatement(db,id,at));
  const results=await db.batch(stmts.filter(Boolean));
  checkChanges(results[0],"Status pesanan berubah di proses lain. Muat ulang data terlebih dahulu.");
  return getOrderD1(db,id);
}
async function markPickedUpD1(db,id,actor="admin") {
  await requireReady(db);
  const before = await getOrderD1(db,id);
  if (!before) throw new Error("Pesanan tidak ditemukan.");
  const at=nowJakarta();
  const sourceKey = "pickup:" + at;
  const results=await db.batch([
    db.prepare(`UPDATE orders SET status='SELESAI',pickup_status='DIAMBIL',updated_at=?
      WHERE order_id=? AND payment_confirmation_status='DISETUJUI'
        AND receipt_code IS NOT NULL AND receipt_code<>''
        AND status IN ('DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED')
        AND pickup_status<>'DIAMBIL'`).bind(at,id),
    db.prepare(`INSERT INTO order_events(order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at)
      SELECT order_id,'PICKED_UP',?,'SELESAI',?,?, '{}',? FROM orders
      WHERE order_id=? AND pickup_status='DIAMBIL' AND updated_at=?`).bind(String(before.status||""),clean(actor,128),sourceKey,at,id,at),
    adminActivityAuditStatement(db,actor,"PICKED_UP",id,{
      from_status:String(before.status||""),to_status:"SELESAI",pickup_status:"DIAMBIL",transition_type:"order_status"
    },at,sourceKey),
    sheetMirrorStatement(db,id,at)
  ].filter(Boolean));
  checkChanges(results[0],"Resi tidak valid, pembayaran belum disetujui, atau pesanan sudah diambil.");
  return getOrderD1(db,id);
}

export async function bootstrapTransactions(db,catalogRows,orderRows) {
  if (!db) throw new Error("Binding D1 DB belum tersedia.");
  const state=await db.prepare("SELECT value FROM app_meta WHERE key='transaction_store_state'").first();
  if(state?.value==="READY")return {alreadyReady:true,catalog:0,orders:0};
  const previous=String(state?.value||"");
  const leaseAt=previous.startsWith("IMPORTING:")?Number(previous.slice(10)):0;
  if(leaseAt && Date.now()-leaseAt<30*60*1000) {
    throw new Error("Migrasi D1 sedang berjalan. Jangan jalankan perintah dua kali; coba lagi setelah proses sebelumnya selesai.");
  }
  const importing="IMPORTING:"+Date.now();
  const claim=state
    ? await db.prepare("UPDATE app_meta SET value=?,updated_at=? WHERE key='transaction_store_state' AND value=?")
        .bind(importing,nowJakarta(),previous).run()
    : await db.prepare("INSERT OR IGNORE INTO app_meta(key,value,updated_at) VALUES('transaction_store_state',?,?)")
        .bind(importing,nowJakarta()).run();
  if(Number(claim.meta?.changes)!==1) {
    const latest=await db.prepare("SELECT value FROM app_meta WHERE key='transaction_store_state'").first();
    if(latest?.value==="READY")return {alreadyReady:true,catalog:0,orders:0};
    throw new Error("Migrasi D1 sedang dikerjakan oleh proses lain.");
  }

  const productStatements=[];
  const seen=new Set();
  for(const r of catalogRows||[]){
    const sku=clean(r[0],40).toUpperCase(); if(!sku||seen.has(sku))continue; seen.add(sku);
    const name=clean(r[1]||sku,100);
    const price=Number(r[2]);
    const stockText=r[3]==null?"":String(r[3]).trim();
    const stock=stockText===""?null:Number(stockText);
    const validPrice=r[2]!=null&&String(r[2]).trim()!==""&&Number.isSafeInteger(price)&&price>=0;
    const validStock=stock===null||(Number.isSafeInteger(stock)&&stock>=0);
    const activeText=String(r[4]??"TRUE").trim().toUpperCase();
    const active=["","TRUE","1","YA","YES","AKTIF"].includes(activeText)&&validPrice&&validStock;
    productStatements.push(db.prepare(`INSERT OR IGNORE INTO catalog_products
      (sku,name,price,stock,active,photo_url,description,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(sku,name,validPrice?price:0,validStock?stock:0,active?1:0,clean(r[5],1000),clean(r[6],500),nowJakarta()));
  }
  const importOrderStatements=[];
  for(let i=0;i<(orderRows||[]).length;i++){
    const r=orderRows[i]; const id=clean(r[0],60);
    if(!id)continue;
    const qty=Number(r[6]||0), unit=Number(r[7]||0), subtotal=Number(r[8]||0), shipping=Number(r[9]||0), total=Number(r[10]||0);
    if(!Number.isInteger(qty)||qty<1||qty>1000||![unit,subtotal,shipping,total].every(v=>Number.isSafeInteger(v)&&v>=0))continue;
    const productText=clean(r[5],150);
    const split=productText.indexOf(" - ");
    const sku=split>0?productText.slice(0,split).trim().toUpperCase():"LEGACY";
    const name=split>0?productText.slice(split+3).trim():productText||"Produk historis";
    const time=clean(r[1],40)||nowJakarta();
    const stamp=Date.parse(time); const createdMs=Number.isFinite(stamp)?stamp:Date.now();
    importOrderStatements.push(db.prepare(`INSERT OR IGNORE INTO orders (
      order_id,created_at,created_ms,channel,customer_id,customer_name,sku,product_name,
      quantity,unit_price,subtotal,shipping,total,payment_method,status,
      payment_confirmation_status,payment_proof_file_id,payment_proof_type,
      payment_requested_at,payment_confirmed_at,receipt_code,pickup_status,
      stock_reserved,legacy_sheet_row,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id,time,createdMs,clean(r[2],24)||"legacy",clean(r[3],128),clean(r[4]||"Pelanggan",100),
      sku,name,qty,unit,subtotal,shipping,total,clean(r[11],20)||"UNKNOWN",
      clean(r[12],40)||"MENUNGGU_PEMBAYARAN",clean(r[13],40),clean(r[14],300),
      clean(r[15],30),clean(r[16],40),clean(r[17],40),clean(r[18],100)||null,
      clean(r[19],40),0,i+2,nowJakarta()
    ));
  }
  const runChunks=async(items,size=60)=>{
    let count=0;
    for(let i=0;i<items.length;i+=size){
      const results=await db.batch(items.slice(i,i+size));
      count+=results.reduce((n,x)=>n+Number(x.meta?.changes||0),0);
    }
    return count;
  };
  const catalogImported=await runChunks(productStatements);
  const ordersImported=await runChunks(importOrderStatements);
  await db.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES('legacy_import_v1',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(JSON.stringify({catalog:catalogImported,orders:ordersImported}),nowJakarta()).run();
  const finished=await db.prepare("UPDATE app_meta SET value='READY',updated_at=? WHERE key='transaction_store_state' AND value=?")
    .bind(nowJakarta(),importing).run();
  if(Number(finished.meta?.changes)!==1)throw new Error("Migrasi D1 kehilangan kepemilikan lock. Periksa status sebelum mencoba ulang.");
  return {alreadyReady:false,catalog:catalogImported,orders:ordersImported};
}

export async function createOrderTransactional(env,input) {
  if(!env.ORDER_COORDINATOR)throw new Error("Durable Object ORDER_COORDINATOR belum dikonfigurasi.");
  const sku=clean(input.sku,40).toUpperCase();
  const stub=env.ORDER_COORDINATOR.getByName("sku:"+sku);
  const o=await stub.createOrder({...input,sku});
  return {orderId:o.order_id,createdAt:o.created_at,createdMs:o.created_ms,
    channel:o.channel,customerId:o.customer_id,customerName:o.customer_name,
    product:o.product_name,sku:o.sku,quantity:o.quantity,unitPrice:o.unit_price,
    subtotal:o.subtotal,shipping:o.shipping,total:o.total,paymentMethod:o.payment_method,
    status:o.status,duplicate:Boolean(o.duplicate)};
}
export async function orderOperation(env,id,method,...args) {
  if(!env.ORDER_COORDINATOR)throw new Error("Durable Object ORDER_COORDINATOR belum dikonfigurasi.");
  const stub=env.ORDER_COORDINATOR.getByName("order:"+String(id));
  return stub[method](String(id),...args);
}
export async function findOrderTransactional(env,id) {
  await requireReady(env.DB);
  return getOrderD1(env.DB,id);
}
export async function findOrderByLegacyRow(env,row) {
  await requireReady(env.DB);
  return getOrderByLegacyRowD1(env.DB,row);
}
export async function listOrdersTransactional(env,options) {
  return listOrdersD1(env.DB,options);
}
export async function listProductsTransactional(env,includeInactive=true) {
  return listProductsD1(env.DB,includeInactive);
}
export async function findProductTransactional(env,sku) {
  return getProductD1(env.DB,sku);
}
export async function saveProductTransactional(env,product,originalSku="") {
  return saveProductD1(env.DB,product,originalSku);
}
export async function deleteProductTransactional(env,sku) {
  return deleteProductD1(env.DB,sku);
}
export async function setLegacyRowTransactional(env,id,row) {
  return setLegacySheetRowD1(env.DB,id,row);
}
export async function updateProofTransactional(env,id,userId,fileId,fileType) {
  return orderOperation(env,id,"savePaymentProof",userId,fileId,fileType);
}
export async function requestVerificationTransactional(env,id,userId) {
  return orderOperation(env,id,"requestVerification",userId);
}
export async function approvePaymentTransactional(env,id,actor) {
  return orderOperation(env,id,"approvePayment",actor);
}
export async function rejectPaymentTransactional(env,id,actor) {
  return orderOperation(env,id,"rejectPayment",actor);
}
export async function setOrderStatusTransactional(env,id,status,actor) {
  return orderOperation(env,id,"setOrderStatus",status,actor);
}
export async function markPickedUpTransactional(env,id,actor) {
  return orderOperation(env,id,"markPickedUp",actor);
}

export async function claimSheetMirrorOutbox(env, limit = 20) {
  await requireReady(env.DB);
  const now=nowJakarta();
  const leaseUntil=new Date(Date.now()+120000+TZ_OFFSET_MS).toISOString().replace("Z","+07:00");
  const result=await env.DB.prepare(`UPDATE outbox
    SET status='PROCESSING',attempts=attempts+1,available_at=?
    WHERE id IN (
      SELECT id FROM outbox
      WHERE event_type IN ('SHEET_MIRROR','CATALOG_MIRROR')
        AND ((status='PENDING' AND available_at<=?)
          OR (status='PROCESSING' AND available_at<=?))
      ORDER BY id LIMIT ?
    )
    RETURNING id,aggregate_id,payload_json,attempts`)
    .bind(leaseUntil,now,now,Math.min(50,Math.max(1,Number(limit)||20))).all();
  return result.results || [];
}
export async function completeSheetMirrorOutbox(env,event) {
  const at=nowJakarta();
  const result=await env.DB.prepare(`UPDATE outbox SET status='DONE',processed_at=?,available_at=?
    WHERE id=? AND status='PROCESSING' AND attempts=?`)
    .bind(at,at,Number(event.id),Number(event.attempts)).run();
  return Number(result.meta?.changes)===1;
}
export async function failSheetMirrorOutbox(env,event,error) {
  const attempts=Number(event.attempts)||1;
  const delaySeconds=Math.min(3600,15*Math.pow(2,Math.min(8,attempts-1)));
  const nextAt=new Date(Date.now()+delaySeconds*1000+TZ_OFFSET_MS).toISOString().replace("Z","+07:00");
  const status=attempts>=8?"FAILED":"PENDING";
  const result=await env.DB.prepare(`UPDATE outbox SET status=?,available_at=?,processed_at=NULL
    WHERE id=? AND status='PROCESSING' AND attempts=?`)
    .bind(status,nextAt,Number(event.id),attempts).run();
  if (Number(result.meta?.changes)!==1) return false;
  console.warn(JSON.stringify({
    level:"warn",event:"sheet_mirror_retry",outbox_id:event.id,
    aggregate_id:event.aggregate_id,attempts,status,
    message:String(error?.message||error||"Unknown error").slice(0,300)
  }));
  return true;
}

export async function listDashboardDataTransactional(env) {
  const [orders,products]=await Promise.all([
    listOrdersD1(env.DB,{limit:5000}),listProductsD1(env.DB,true)
  ]);
  return {
    generated_at:new Date().toISOString(),
    orders:orders.map(orderToDashboard),
    products:products.map(productToDashboard)
  };
}
export async function toSheetRowTransactional(env,id) {
  const o=await findOrderTransactional(env,id);
  return o?orderToSheetRow(o):null;
}

export class OrderCoordinator extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.serial=Promise.resolve();
    ctx.blockConcurrencyWhile(()=>{
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS coordinator_audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        aggregate_key TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
    });
  }
  enqueue(fn) {
    const next=this.serial.then(fn,fn);
    this.serial=next.then(()=>undefined,()=>undefined);
    return next;
  }
  audit(operation,key,result) {
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO coordinator_audit(operation,aggregate_key,result,created_at) VALUES(?,?,?,?)",
        operation,String(key),String(result||"OK"),nowJakarta()
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM coordinator_audit WHERE id < COALESCE(" +
        "(SELECT id FROM coordinator_audit ORDER BY id DESC LIMIT 1 OFFSET 999),0)"
      );
    } catch (error) {
      // Transaction state is authoritative in D1; audit failure must not mask a committed operation.
      console.warn(JSON.stringify({level:"warn",event:"coordinator_audit",operation,message:error?.message||String(error)}));
    }
  }
  async createOrder(input) {
    return this.enqueue(async()=>{
      const result=await createOrderD1(this.env.DB,input);
      this.audit("CREATE_ORDER",input.sku,result.order_id);
      return result;
    });
  }
  async requestVerification(id,customerId) {
    return this.enqueue(async()=>{
      const result=await requestVerificationD1(this.env.DB,id,customerId);
      this.audit("REQUEST_PAYMENT",id,result.payment_confirmation_status);
      return result;
    });
  }
  async savePaymentProof(id,customerId,fileId,fileType) {
    return this.enqueue(async()=>{
      const result=await savePaymentProofD1(this.env.DB,id,customerId,fileId,fileType);
      this.audit("SAVE_PAYMENT_PROOF",id,fileType);
      return result;
    });
  }
  async approvePayment(id,actor) {
    return this.enqueue(async()=>{
      const result=await approvePaymentD1(this.env.DB,id,actor);
      this.audit("APPROVE_PAYMENT",id,result.receipt_code);
      return result;
    });
  }
  async rejectPayment(id,actor) {
    return this.enqueue(async()=>{
      const result=await rejectPaymentD1(this.env.DB,id,actor);
      this.audit("REJECT_PAYMENT",id,"DITOLAK");
      return result;
    });
  }
  async setOrderStatus(id,status,actor) {
    return this.enqueue(async()=>{
      const result=await setOrderStatusD1(this.env.DB,id,status,actor);
      this.audit("SET_STATUS",id,status);
      return result;
    });
  }
  async markPickedUp(id,actor) {
    return this.enqueue(async()=>{
      const result=await markPickedUpD1(this.env.DB,id,actor);
      this.audit("PICKUP",id,"DIAMBIL");
      return result;
    });
  }
  async addDigitalStock(category, input, actor) {
    return this.enqueue(async () => {
      const added = await addDigitalStockD1(this.env, category, input, actor);
      const waiting = added.added
        ? await listWaitingDigitalFulfillmentsD1(this.env.DB, category, Math.min(20, added.added))
        : [];
      for (const orderId of waiting) {
        await claimDigitalStockD1(this.env, category, orderId);
      }
      return { ...added, waitingOrderIds: waiting };
    });
  }
  async deleteDigitalStock(category, email, actor) {
    return this.enqueue(() => deleteDigitalStockD1(this.env, category, email, actor));
  }
  async claimDigitalStock(category, orderId) {
    return this.enqueue(() => claimDigitalStockD1(this.env, category, orderId));
  }
}
