import { TZ, PAID_ORDER_STATUSES, CANCELLED_ORDER_STATUSES, parseCatalogProduct, rupiah } from "./utils.mjs";
import { readSheet } from "./sheets-client.mjs";
import { renderAdminSalesReportHtml } from "./ui/admin-screens.mjs";

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
function isValidReportDate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}

async function buildAdminReport(env, d1Orders = null) {
  let orders;
  if (Array.isArray(d1Orders)) {
    orders = d1Orders.map((row) => ({
      orderId: String(row.order_id || ""),
      createdAt: String(row.created_at || ""),
      product: String(row.product || "Tidak diketahui"),
      quantity: Number(row.quantity || 0),
      total: Number(row.total || 0),
      payment: String(row.payment_method || "Lainnya"),
      status: String(row.status || "")
    })).filter((row) => row.orderId);
  } else {
    const rows = await readSheet(env, "Pesanan!A2:M");
    orders = rows.map(row => ({
      orderId: String(row[0] || ""),
      createdAt: String(row[1] || ""),
      product: String(row[5] || "Tidak diketahui"),
      quantity: Number(row[6] || 0),
      total: Number(row[10] || 0),
      payment: String(row[11] || "Lainnya"),
      status: String(row[12] || "")
    })).filter(row => row.orderId);
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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
  const paymentTotals = {};
  for (const o of paid) paymentTotals[o.payment] = (paymentTotals[o.payment] || 0) + o.total;
  return renderAdminSalesReportHtml({
    dateLabel: new Intl.DateTimeFormat("id-ID", { dateStyle: "full", timeZone: TZ }).format(new Date()),
    revenue,
    paidCount: paid.length,
    todayRevenue,
    todayCount: todays.length,
    bestProduct: best || null,
    paymentTotals,
    target
  });
}


export {
  orderRowsToObjects, productRowsToObjects, localDateKey,
  csvCell, csvText, buildReportExportsFromData, isValidReportDate, buildAdminReport
};
