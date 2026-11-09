const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function clean(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function nowJakarta() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().replace("Z", "+07:00");
}

function safeMoney(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(label + " tidak valid.");
  }
  return amount;
}

function makeOrderId() {
  const stamp = nowJakarta().slice(0, 10).replace(/-/g, "");
  return "SEI-" + stamp + "-" + crypto.randomUUID().slice(0, 8).toUpperCase();
}

function makeIdempotencyKey(input) {
  const raw = clean(input.idempotencyKey, 128);
  if (!raw) throw new Error("Kunci checkout tidak valid.");
  return "update:" + clean(input.channel || "telegram", 24) + ":" + raw;
}

async function requireReady(db) {
  if (!db) throw new Error("Binding D1 DB belum tersedia.");
  const row = await db.prepare(
    "SELECT value FROM app_meta WHERE key='transaction_store_state'"
  ).first();
  if (row?.value !== "READY") {
    throw new Error("Lapisan transaksi D1 belum diaktifkan.");
  }
}

function sheetMirrorStatement(db, id, at) {
  return db.prepare(
    "INSERT INTO outbox (event_type,aggregate_id,payload_json,status,attempts,available_at,created_at) " +
    "SELECT 'SHEET_MIRROR',order_id,json_object('order_id',order_id),'PENDING',0,?,? " +
    "FROM orders WHERE order_id=? " +
    "ON CONFLICT(event_type,aggregate_id) DO UPDATE SET " +
    "payload_json=excluded.payload_json,status='PENDING',attempts=0," +
    "available_at=excluded.available_at,processed_at=NULL"
  ).bind(at, at, id);
}

function adminActivityStatement(db, actor, id, at, sourceKey, itemCount) {
  const actorValue = clean(actor || "telegram:unknown", 128);
  const actorChannel = actorValue.startsWith("telegram") ? "telegram" : "web";
  const actorId = actorValue.startsWith("telegram:")
    ? actorValue.slice("telegram:".length)
    : actorValue;
  const createdAtMs = Date.parse(at);
  if (!actorId || !Number.isFinite(createdAtMs)) return null;
  return db.prepare(
    "INSERT INTO admin_activity_audit(" +
      "audit_id,actor_channel,actor_id,action,resource_type,resource_id,summary_json,created_at_ms" +
    ") SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (" +
      "SELECT 1 FROM order_events WHERE order_id=? AND event_type='ORDER_CREATED' AND source_key=?" +
    ")"
  ).bind(
    crypto.randomUUID(), actorChannel, actorId, "ORDER_CREATED", "order", id,
    JSON.stringify({ sku: "MULTI", item_count: Number(itemCount) }), createdAtMs, id, sourceKey
  );
}

export async function listCartProductsD1(db, rawItems) {
  await requireReady(db);
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length) return [];
  if (items.length > 30) throw new Error("Keranjang maksimal 30 jenis produk.");

  const normalized = items.map((item) => ({
    sku: clean(item.sku, 40).toUpperCase(),
    quantity: Number(item.quantity)
  }));
  for (const item of normalized) {
    if (!/^[A-Z0-9._-]{1,40}$/.test(item.sku) ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000) {
      throw new Error("Data keranjang tidak valid.");
    }
  }

  const placeholders = normalized.map(() => "?").join(",");
  const result = await db.prepare(
    "SELECT sku,name,price,stock,active FROM catalog_products " +
    "WHERE sku IN (" + placeholders + ")"
  ).bind(...normalized.map((item) => item.sku)).all();
  const products = new Map((result.results || []).map((product) => [
    String(product.sku).toUpperCase(), product
  ]));

  return normalized.map((item) => {
    const product = products.get(item.sku);
    const active = Boolean(product?.active);
    const price = product ? Number(product.price) : null;
    const stock = product?.stock == null ? null : Number(product.stock);
    const priceValid = Number.isSafeInteger(price) && price >= 0;
    return {
      sku: item.sku,
      name: product?.name || "Produk tidak tersedia",
      quantity: item.quantity,
      unitPrice: priceValid ? price : null,
      subtotal: priceValid && Number.isSafeInteger(price * item.quantity)
        ? price * item.quantity
        : null,
      stock,
      available: Boolean(
        active && priceValid && Number.isSafeInteger(price * item.quantity) &&
        (stock == null || stock >= item.quantity)
      )
    };
  });
}

export async function listCartOrderItemsD1(db, orderId) {
  const result = await db.prepare(
    "SELECT sku,product_name,quantity,unit_price,subtotal " +
    "FROM order_items WHERE order_id=? ORDER BY product_name COLLATE NOCASE,sku"
  ).bind(String(orderId)).all();
  return (result.results || []).map((item) => ({
    sku: String(item.sku),
    name: String(item.product_name),
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    subtotal: Number(item.subtotal)
  }));
}

async function findByIdempotencyKey(db, key) {
  return db.prepare("SELECT * FROM orders WHERE idempotency_key=?").bind(key).first();
}

export async function createCartOrderD1(db, input) {
  await requireReady(db);
  const channel = clean(input.channel || "telegram", 24);
  const customerId = clean(input.customerId, 128);
  const customerName = clean(input.customerName || "Pelanggan", 100);
  if (!customerId) throw new Error("Identitas pelanggan tidak valid.");

  const method = clean(input.paymentMethod, 20).toUpperCase();
  if (!["QRIS", "TRANSFER", "COD"].includes(method)) {
    throw new Error("Metode pembayaran tidak valid.");
  }

  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (!rawItems.length) throw new Error("Keranjang masih kosong.");
  if (rawItems.length > 30) throw new Error("Keranjang maksimal 30 jenis produk.");

  const combined = new Map();
  for (const raw of rawItems) {
    const sku = clean(raw.sku, 40).toUpperCase();
    const quantity = Number(raw.quantity);
    if (!/^[A-Z0-9._-]{1,40}$/.test(sku) ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      throw new Error("Data keranjang tidak valid.");
    }
    const totalQuantity = (combined.get(sku) || 0) + quantity;
    if (totalQuantity > 1000) throw new Error("Jumlah produk melebihi batas.");
    combined.set(sku, totalQuantity);
  }

  const items = [...combined.entries()]
    .map(([sku, quantity]) => ({ sku, quantity }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  if (totalQuantity > 1000) throw new Error("Total jumlah produk melebihi batas.");

  const dedupe = makeIdempotencyKey({ ...input, channel });
  const prior = await findByIdempotencyKey(db, dedupe);
  if (prior) {
    return {
      ...prior,
      duplicate: true,
      created: false,
      stock_reserved: Boolean(prior.stock_reserved),
      items: await listCartOrderItemsD1(db, prior.order_id)
    };
  }

  const productRows = await Promise.all(items.map((item) =>
    db.prepare(
      "SELECT sku,name,price,stock,active FROM catalog_products WHERE sku=? COLLATE NOCASE"
    ).bind(item.sku).first()
  ));

  let subtotal = 0;
  const pricedItems = items.map((item, index) => {
    const product = productRows[index];
    if (!product || !product.active) {
      throw new Error("Produk " + item.sku + " tidak ditemukan atau sedang nonaktif.");
    }
    const unitPrice = safeMoney(product.price, "Harga produk " + item.sku);
    if (unitPrice > Math.floor(SAFE_INTEGER / item.quantity)) {
      throw new Error("Subtotal produk " + item.sku + " melebihi batas angka aman.");
    }
    const lineSubtotal = unitPrice * item.quantity;
    if (!Number.isSafeInteger(subtotal + lineSubtotal)) {
      throw new Error("Subtotal keranjang melebihi batas angka aman.");
    }
    if (product.stock != null && Number(product.stock) < item.quantity) {
      throw new Error(
        "Stok " + item.sku + " tidak mencukupi. Stok tersedia: " + product.stock
      );
    }
    subtotal += lineSubtotal;
    return {
      sku: item.sku,
      name: clean(product.name, 100),
      quantity: item.quantity,
      unitPrice,
      subtotal: lineSubtotal
    };
  });

  const shipping = safeMoney(input.shipping ?? 0, "Ongkir");
  if (!Number.isSafeInteger(subtotal + shipping)) {
    throw new Error("Total pesanan melebihi batas angka aman.");
  }

  const at = nowJakarta();
  const atMs = Date.now();
  const id = makeOrderId();
  const productLabel = "Keranjang (" + pricedItems.length + " produk)";
  const statements = [
    db.prepare(
      "INSERT OR IGNORE INTO orders (" +
        "order_id,idempotency_key,created_at,created_ms,channel,customer_id,customer_name," +
        "sku,product_name,quantity,unit_price,subtotal,shipping,total,payment_method,status," +
        "stock_reserved,updated_at" +
      ") VALUES (?,?,?,?,?,?,?,'MULTI',?,?,0,?,?,?,?,'MENUNGGU_PEMBAYARAN',1,?)"
    ).bind(
      id, dedupe, at, atMs, channel, customerId, customerName,
      productLabel, totalQuantity, subtotal, shipping, subtotal + shipping, method, at
    )
  ];

  for (const item of pricedItems) {
    statements.push(db.prepare(
      "INSERT INTO order_items(" +
        "order_id,sku,product_name,quantity,unit_price,subtotal,created_at" +
      ") VALUES(?,?,?,?,?,?,?)"
    ).bind(id, item.sku, item.name, item.quantity, item.unitPrice, item.subtotal, at));
  }

  for (const item of pricedItems) {
    statements.push(db.prepare(
      "INSERT INTO order_item_inventory_movements(" +
        "order_id,sku,movement_type,quantity,created_at" +
      ") VALUES(?,?,'RESERVE',?,?)"
    ).bind(id, item.sku, item.quantity, at));
  }

  const sourceKey = dedupe;
  statements.push(db.prepare(
    "INSERT INTO order_events(" +
      "order_id,event_type,from_status,to_status,actor,source_key,payload_json,created_at" +
    ") VALUES(?,'ORDER_CREATED','','MENUNGGU_PEMBAYARAN',?,?,?,?)"
  ).bind(
    id, clean(input.actor || ("telegram:" + customerId), 128), sourceKey,
    JSON.stringify({ sku: "MULTI", item_count: pricedItems.length }), at
  ));

  const audit = adminActivityStatement(
    db, input.actor || ("telegram:" + customerId), id, at, sourceKey, pricedItems.length
  );
  if (audit) statements.push(audit);
  statements.push(sheetMirrorStatement(db, id, at));

  try {
    await db.batch(statements);
  } catch (error) {
    const duplicate = await findByIdempotencyKey(db, dedupe).catch(() => null);
    if (duplicate) {
      return {
        ...duplicate,
        duplicate: true,
        created: false,
        stock_reserved: Boolean(duplicate.stock_reserved),
        items: await listCartOrderItemsD1(db, duplicate.order_id)
      };
    }
    throw error;
  }

  const current = await findByIdempotencyKey(db, dedupe);
  if (!current) throw new Error("Checkout gagal dicatat. Silakan coba kembali.");
  const created = current.order_id === id;
  return {
    ...current,
    duplicate: !created,
    created,
    stock_reserved: Boolean(current.stock_reserved),
    items: await listCartOrderItemsD1(db, current.order_id)
  };
}

export function cartInventoryReleaseStatements(db, orderId, at) {
  const id = String(orderId);
  return [
    db.prepare(
      "INSERT OR IGNORE INTO order_item_inventory_movements(" +
        "order_id,sku,movement_type,quantity,created_at" +
      ") SELECT i.order_id,i.sku,'RELEASE',i.quantity,? " +
      "FROM order_items i JOIN orders o ON o.order_id=i.order_id " +
      "WHERE i.order_id=? AND o.sku='MULTI' AND o.status='DIBATALKAN' AND o.stock_reserved=1"
    ).bind(at, id),
    db.prepare(
      "UPDATE orders SET stock_reserved=0,updated_at=? " +
      "WHERE order_id=? AND sku='MULTI' AND status='DIBATALKAN' AND stock_reserved=1 " +
      "AND EXISTS(SELECT 1 FROM order_items WHERE order_id=?) " +
      "AND NOT EXISTS(" +
        "SELECT 1 FROM order_items i " +
        "LEFT JOIN order_item_inventory_movements m " +
          "ON m.order_id=i.order_id AND m.sku=i.sku AND m.movement_type='RELEASE' " +
        "WHERE i.order_id=? AND m.id IS NULL" +
      ")"
    ).bind(at, id, id, id)
  ];
}
