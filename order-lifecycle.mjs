import { cartInventoryReleaseStatements } from "./cart-layer.mjs";

const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
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
async function isReady(db) {
  if (!db) return false;
  try {
    const row = await db.prepare("SELECT value FROM app_meta WHERE key = 'transaction_store_state'").first();
    return row?.value === "READY";
  } catch {
    return false;
  }
}
async function requireReady(db) {
  if (!(await isReady(db))) throw new Error("Lapisan transaksi D1 belum diaktifkan.");
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
async function getOrderD1(db, id) {
  await requireReady(db);
  const order = await db.prepare("SELECT * FROM orders WHERE order_id = ?").bind(String(id)).first();
  return order || null;
}

export async function requestVerificationD1(db, id, customerId) {
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
  const sourceKey = "request:" + crypto.randomUUID();
  const results = await db.batch([
    db.prepare("UPDATE orders SET payment_confirmation_status='MENUNGGU_VERIFIKASI',payment_proof_file_id='',payment_proof_type='',payment_requested_at=?,updated_at=? WHERE order_id=? AND status=? AND payment_confirmation_status IN ('','DITOLAK')").bind(at,at,id,o.status),
    db.prepare("INSERT INTO order_events(order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at) SELECT order_id,'PAYMENT_REQUESTED',?,?,?,?,'{}',? FROM orders WHERE order_id=? AND payment_confirmation_status='MENUNGGU_VERIFIKASI' AND updated_at=?").bind(o.payment_confirmation_status||"","MENUNGGU_VERIFIKASI",clean(customerId,128),sourceKey,at,id,at),
    sheetMirrorStatement(db,id,at)
  ]);
  if (Number(results[0].meta?.changes) !== 1) {
    const latest = await getOrderD1(db,id);
    if (latest?.payment_confirmation_status === "MENUNGGU_VERIFIKASI") return latest;
    throw new Error("Permintaan verifikasi sudah berubah. Muat ulang pesanan.");
  }
  return getOrderD1(db,id);
}
export async function savePaymentProofD1(db,id,customerId,fileId,fileType) {
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
export async function approvePaymentD1(db,id,actor="admin") {
  await requireReady(db);
  const o=await getOrderD1(db,id);
  if(!o)throw new Error("Pesanan tidak ditemukan.");
  if(!ONLINE_METHODS.has(String(o.payment_method).toUpperCase()))throw new Error("Hanya pembayaran QRIS/transfer yang dapat diverifikasi.");
  if(CANCELLED_STATUSES.has(String(o.status).toUpperCase()))throw new Error("Pesanan sudah dibatalkan.");
  if (String(o.payment_confirmation_status).toUpperCase() === "DISETUJUI" && o.receipt_code) {
    return { ...o, alreadyApproved: true };
  }
  const at=nowJakarta(), code="SEI-"+dateStamp(at)+"-"+crypto.randomUUID().slice(0,6).toUpperCase();
  const sourceKey = "approve:" + code;
  const results=await db.batch([
    db.prepare(`UPDATE orders SET status='DIBAYAR',payment_confirmation_status='DISETUJUI',
      payment_confirmed_at=?,receipt_code=?,pickup_status='BELUM_DIAMBIL',updated_at=?
      WHERE order_id=? AND payment_confirmation_status='MENUNGGU_VERIFIKASI'
        AND status NOT IN ('DIBATALKAN','CANCELLED','CANCELED')`).bind(at,code,at,id),
    db.prepare(`INSERT INTO order_events(order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at)
      SELECT order_id,'PAYMENT_APPROVED',?,'DIBAYAR',?,?, '{}',? FROM orders
      WHERE order_id=? AND receipt_code=?`).bind(o.status,clean(actor,128),sourceKey,at,id,code),
    adminActivityAuditStatement(db,actor,"PAYMENT_APPROVED",id,{from_status:String(o.status||""),to_status:"DIBAYAR",transition_type:"order_status"},at,sourceKey),
    sheetMirrorStatement(db,id,at)
  ].filter(Boolean));
  checkChanges(results[0],"Permintaan pembayaran sudah diproses atau status pesanan tidak memenuhi syarat.");
  return getOrderD1(db,id);
}
export async function rejectPaymentD1(db,id,actor="admin") {
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
export async function setOrderStatusD1(db,id,status,actor="admin") {
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
    if (String(o.sku || "").toUpperCase() === "MULTI") {
      const itemCount = await db.prepare(
        "SELECT COUNT(*) AS item_count FROM order_items WHERE order_id=?"
      ).bind(id).first();
      if (!Number(itemCount?.item_count)) {
        throw new Error("Detail item pesanan multi-produk tidak ditemukan; stok tidak dapat dilepas dengan aman.");
      }
      stmts.push(...cartInventoryReleaseStatements(db,id,at));
    } else {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO inventory_movements(order_id,sku,movement_type,quantity,created_at)
        SELECT order_id,sku,'RELEASE',quantity,? FROM orders
        WHERE order_id=? AND status='DIBATALKAN' AND stock_reserved=1`).bind(at,id));
      stmts.push(db.prepare(`UPDATE orders SET stock_reserved=0,updated_at=?
        WHERE order_id=? AND status='DIBATALKAN' AND stock_reserved=1
          AND EXISTS(SELECT 1 FROM inventory_movements WHERE order_id=? AND movement_type='RELEASE')`).bind(at,id,id));
    }
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
