import { env, exports } from "cloudflare:workers";
import { createExecutionContext, evictDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtimeSchema = [
  "CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS catalog_products(sku TEXT PRIMARY KEY COLLATE NOCASE,name TEXT NOT NULL,price INTEGER NOT NULL CHECK(price>=0),stock INTEGER CHECK(stock IS NULL OR stock>=0),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),photo_url TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS orders(order_id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,created_at TEXT NOT NULL,created_ms INTEGER NOT NULL,channel TEXT NOT NULL,customer_id TEXT NOT NULL,customer_name TEXT NOT NULL,sku TEXT NOT NULL,product_name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),unit_price INTEGER NOT NULL CHECK(unit_price>=0),subtotal INTEGER NOT NULL CHECK(subtotal>=0),shipping INTEGER NOT NULL CHECK(shipping>=0),total INTEGER NOT NULL CHECK(total>=0),payment_method TEXT NOT NULL,status TEXT NOT NULL,payment_confirmation_status TEXT NOT NULL DEFAULT '',payment_proof_file_id TEXT NOT NULL DEFAULT '',payment_proof_type TEXT NOT NULL DEFAULT '',payment_requested_at TEXT NOT NULL DEFAULT '',payment_confirmed_at TEXT NOT NULL DEFAULT '',receipt_code TEXT UNIQUE,pickup_status TEXT NOT NULL DEFAULT '',stock_reserved INTEGER NOT NULL DEFAULT 0 CHECK(stock_reserved IN (0,1)),legacy_sheet_row INTEGER UNIQUE,updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS inventory_movements(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,sku TEXT NOT NULL,movement_type TEXT NOT NULL CHECK(movement_type IN ('RESERVE','RELEASE')),quantity INTEGER NOT NULL CHECK(quantity>0),created_at TEXT NOT NULL,UNIQUE(order_id,movement_type),FOREIGN KEY(order_id) REFERENCES orders(order_id),FOREIGN KEY(sku) REFERENCES catalog_products(sku))",
  "CREATE TABLE IF NOT EXISTS order_items(order_id TEXT NOT NULL,sku TEXT NOT NULL COLLATE NOCASE,product_name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),unit_price INTEGER NOT NULL CHECK(unit_price>=0),subtotal INTEGER NOT NULL CHECK(subtotal>=0),created_at TEXT NOT NULL,PRIMARY KEY(order_id,sku),FOREIGN KEY(order_id) REFERENCES orders(order_id),FOREIGN KEY(sku) REFERENCES catalog_products(sku))",
  "CREATE TABLE IF NOT EXISTS order_item_inventory_movements(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,sku TEXT NOT NULL COLLATE NOCASE,movement_type TEXT NOT NULL CHECK(movement_type IN ('RESERVE','RELEASE')),quantity INTEGER NOT NULL CHECK(quantity>0),created_at TEXT NOT NULL,UNIQUE(order_id,sku,movement_type),FOREIGN KEY(order_id,sku) REFERENCES order_items(order_id,sku),FOREIGN KEY(sku) REFERENCES catalog_products(sku))",
  "CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,event_type TEXT NOT NULL,from_status TEXT NOT NULL DEFAULT '',to_status TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',source_key TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,UNIQUE(order_id,event_type,source_key),FOREIGN KEY(order_id) REFERENCES orders(order_id))",
  "CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,aggregate_id TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,created_at TEXT NOT NULL,processed_at TEXT,UNIQUE(event_type,aggregate_id))",
  "CREATE TABLE IF NOT EXISTS admin_activity_audit(audit_id TEXT PRIMARY KEY,actor_channel TEXT NOT NULL CHECK(actor_channel IN ('telegram','web')),actor_id TEXT NOT NULL,action TEXT NOT NULL,resource_type TEXT NOT NULL,resource_id TEXT,summary_json TEXT NOT NULL DEFAULT '{}',created_at_ms INTEGER NOT NULL)",
  "CREATE TRIGGER IF NOT EXISTS inventory_reserve_guard BEFORE INSERT ON inventory_movements WHEN NEW.movement_type='RESERVE' BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM catalog_products WHERE sku=NEW.sku AND active=1) THEN RAISE(ABORT,'PRODUCT_UNAVAILABLE') WHEN (SELECT stock FROM catalog_products WHERE sku=NEW.sku) IS NOT NULL AND (SELECT stock FROM catalog_products WHERE sku=NEW.sku)<NEW.quantity THEN RAISE(ABORT,'INSUFFICIENT_STOCK') END; END",
  "CREATE TRIGGER IF NOT EXISTS inventory_reserve_apply AFTER INSERT ON inventory_movements WHEN NEW.movement_type='RESERVE' BEGIN UPDATE catalog_products SET stock=stock-NEW.quantity,updated_at=NEW.created_at WHERE sku=NEW.sku AND stock IS NOT NULL; END",
  "CREATE TRIGGER IF NOT EXISTS inventory_release_apply AFTER INSERT ON inventory_movements WHEN NEW.movement_type='RELEASE' BEGIN UPDATE catalog_products SET stock=stock+NEW.quantity,updated_at=NEW.created_at WHERE sku=NEW.sku AND stock IS NOT NULL; END",
  "CREATE TRIGGER IF NOT EXISTS order_item_inventory_guard BEFORE INSERT ON order_item_inventory_movements WHEN NEW.movement_type='RESERVE' BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM order_items i JOIN catalog_products p ON p.sku=i.sku JOIN orders o ON o.order_id=i.order_id WHERE i.order_id=NEW.order_id AND i.sku=NEW.sku AND i.quantity=NEW.quantity AND p.active=1 AND o.sku='MULTI' AND o.stock_reserved=1) THEN RAISE(ABORT,'PRODUCT_UNAVAILABLE') WHEN (SELECT stock FROM catalog_products WHERE sku=NEW.sku) IS NOT NULL AND (SELECT stock FROM catalog_products WHERE sku=NEW.sku)<NEW.quantity THEN RAISE(ABORT,'INSUFFICIENT_STOCK') END; END",
  "CREATE TRIGGER IF NOT EXISTS order_item_inventory_reserve_apply AFTER INSERT ON order_item_inventory_movements WHEN NEW.movement_type='RESERVE' BEGIN UPDATE catalog_products SET stock=stock-NEW.quantity,updated_at=NEW.created_at WHERE sku=NEW.sku AND stock IS NOT NULL; END",
  "CREATE TRIGGER IF NOT EXISTS order_item_inventory_release_apply AFTER INSERT ON order_item_inventory_movements WHEN NEW.movement_type='RELEASE' BEGIN UPDATE catalog_products SET stock=stock+NEW.quantity,updated_at=NEW.created_at WHERE sku=NEW.sku AND stock IS NOT NULL; END"
];

const stamp = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
const createdSkus: string[] = [];

async function seedProduct(sku: string, stock: number, price = 12000) {
  await env.DB.prepare(
    "INSERT INTO catalog_products(sku,name,price,stock,active,photo_url,description,updated_at) " +
    "VALUES(?,?,?, ?,1,'','',?)"
  ).bind(sku, "Runtime " + sku, price, stock, new Date().toISOString()).run();
  createdSkus.push(sku);
}

async function readStock(sku: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT stock FROM catalog_products WHERE sku=?"
  ).bind(sku).first<{ stock: number }>();
  if (!row) throw new Error("Runtime test SKU not found: " + sku);
  return Number(row.stock);
}

async function orderIdsForSku(sku: string): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT DISTINCT order_id FROM order_items WHERE sku=? UNION SELECT order_id FROM orders WHERE sku=?"
  ).bind(sku,sku).all<{ order_id: string }>();
  return (result.results || []).map(row => row.order_id);
}

async function cleanupSku(sku: string) {
  const ids = await orderIdsForSku(sku);
  for (const id of ids) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox WHERE aggregate_id=?").bind(id),
      env.DB.prepare("DELETE FROM admin_activity_audit WHERE resource_id=?").bind(id),
      env.DB.prepare("DELETE FROM order_events WHERE order_id=?").bind(id),
      env.DB.prepare("DELETE FROM inventory_movements WHERE order_id=?").bind(id),
      env.DB.prepare("DELETE FROM order_item_inventory_movements WHERE order_id=?").bind(id),
      env.DB.prepare("DELETE FROM order_items WHERE order_id=?").bind(id),
      env.DB.prepare("DELETE FROM orders WHERE order_id=?").bind(id)
    ]);
  }
  await env.DB.prepare("DELETE FROM catalog_products WHERE sku=?").bind(sku).run();
}

describe("Seiton cart Durable Object runtime", () => {
  beforeAll(async () => {
    await env.DB.batch(runtimeSchema.map(sql => env.DB.prepare(sql)));
    await env.DB.prepare(
      "INSERT INTO app_meta(key,value,updated_at) VALUES('transaction_store_state','READY',?) " +
      "ON CONFLICT(key) DO UPDATE SET value='READY',updated_at=excluded.updated_at"
    ).bind(new Date().toISOString()).run();
  });

  afterAll(async () => {
    for (const sku of createdSkus) await cleanupSku(sku);
  });

  it("persists add/update/remove RPC state and de-duplicates retried mutations", async () => {
    const id = stamp();
    const sku = "RT-CART-" + id;
    const customerId = "runtime-cart-" + id;
    await seedProduct(sku, 10);
    const stub = env.ORDER_COORDINATOR.getByName("cart:telegram:" + customerId);

    const added = await stub.addCartItem(sku, 2, "add-" + id);
    expect(added).toMatchObject({ sku, quantity: 2 });

    const retriedAdd = await stub.addCartItem(sku, 2, "add-" + id);
    expect(retriedAdd).toMatchObject({ sku, quantity: 2, duplicate: true });

    const cart = await stub.getCart();
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({
      sku, quantity: 2, unitPrice: 12000, subtotal: 24000, stock: 10, available: true
    });

    const updated = await stub.updateCartItem(sku, 4, "update-" + id);
    expect(updated).toMatchObject({ sku, quantity: 4 });
    expect((await stub.getCart())[0].quantity).toBe(4);

    const removed = await stub.removeCartItem(sku, "remove-" + id);
    expect(removed).toMatchObject({ sku, removed: true });
    expect(await stub.getCart()).toHaveLength(0);

    await stub.addCartItem(sku, 1, "add-again-" + id);
    const cleared = await stub.clearCart("clear-" + id);
    expect(cleared).toMatchObject({ cleared: true });
    expect(await stub.getCart()).toHaveLength(0);
  });

  it("retains cart state after an object eviction and recreation", async () => {
    const id = stamp();
    const sku = "RT-EVICT-" + id;
    const customerId = "runtime-evict-" + id;
    await seedProduct(sku, 6);
    const stub = env.ORDER_COORDINATOR.getByName("cart:telegram:" + customerId);

    await stub.addCartItem(sku, 3, "persist-" + id);
    await evictDurableObject(stub);

    const restored = await stub.getCart();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ sku, quantity: 3, available: true });
  });

  it("checks out multi-item cart once, persists order rows, and releases the cart", async () => {
    const id = stamp();
    const skuA = "RT-CHK-A-" + id;
    const skuB = "RT-CHK-B-" + id;
    const customerId = "runtime-checkout-" + id;
    await seedProduct(skuA, 8, 12000);
    await seedProduct(skuB, 5, 25000);
    const stub = env.ORDER_COORDINATOR.getByName("cart:telegram:" + customerId);

    await stub.addCartItem(skuA, 2, "add-a-" + id);
    await stub.addCartItem(skuB, 1, "add-b-" + id);
    const checkoutInput = {
      operationId: "checkout-" + id,
      channel: "telegram",
      customerId,
      customerName: "Preview Runtime Customer",
      paymentMethod: "QRIS",
      shipping: 5000
    };
    const order = await stub.checkoutCart(checkoutInput);

    expect(order).toMatchObject({
      sku: "MULTI",
      quantity: 3,
      subtotal: 49000,
      shipping: 5000,
      total: 54000,
      status: "MENUNGGU_PEMBAYARAN",
      duplicate: false
    });
    expect(order.orderId).toBeTruthy();
    expect(order.items).toHaveLength(2);
    expect(await readStock(skuA)).toBe(6);
    expect(await readStock(skuB)).toBe(4);
    expect(await stub.getCart()).toHaveLength(0);

    const retried = await stub.checkoutCart(checkoutInput);
    expect(retried).toMatchObject({ orderId: order.orderId, duplicate: true });
    const freshRetry = await stub.checkoutCart({
      ...checkoutInput,
      operationId: "checkout-retry-" + id
    });
    expect(freshRetry).toMatchObject({ orderId: order.orderId, duplicate: true });

    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS item_count FROM order_items WHERE order_id=?"
    ).bind(order.orderId).first<{ item_count: number }>();
    expect(Number(stored?.item_count)).toBe(2);
  });

  it("serializes concurrent customer checkouts so the final stock unit is reserved once", async () => {
    const id = stamp();
    const sku = "RT-RACE-" + id;
    const customerA = "runtime-race-a-" + id;
    const customerB = "runtime-race-b-" + id;
    await seedProduct(sku, 1, 15000);

    const stubA = env.ORDER_COORDINATOR.getByName("cart:telegram:" + customerA);
    const stubB = env.ORDER_COORDINATOR.getByName("cart:telegram:" + customerB);
    await Promise.all([
      stubA.addCartItem(sku, 1, "race-add-a-" + id),
      stubB.addCartItem(sku, 1, "race-add-b-" + id)
    ]);

    const attempts = await Promise.allSettled([
      stubA.checkoutCart({
        operationId: "race-checkout-a-" + id, channel: "telegram",
        customerId: customerA, customerName: "Runtime A", paymentMethod: "QRIS", shipping: 0
      }),
      stubB.checkoutCart({
        operationId: "race-checkout-b-" + id, channel: "telegram",
        customerId: customerB, customerName: "Runtime B", paymentMethod: "QRIS", shipping: 0
      })
    ]);

    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await readStock(sku)).toBe(0);

    const orderCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE order_id IN " +
      "(SELECT order_id FROM order_items WHERE sku=?)"
    ).bind(sku).first<{ n: number }>();
    expect(Number(orderCount?.n)).toBe(1);

    const reserveCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM order_item_inventory_movements " +
      "WHERE sku=? AND movement_type='RESERVE'"
    ).bind(sku).first<{ n: number }>();
    expect(Number(reserveCount?.n)).toBe(1);
  });

  it("serves health from the Worker runtime with the D1 and DO bindings ready", async () => {
    const response = await exports.default.fetch(new Request("http://runtime.test/health"));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      service: string;
      transaction_store: string;
    };
    expect(body).toMatchObject({
      ok: true,
      service: "seiton-order-bot",
      transaction_store: "READY"
    });
  });
});
