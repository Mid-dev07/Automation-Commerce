import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import migration0001 from "../migrations/0001_transaction_core.sql?raw";
import migration0002 from "../migrations/0002_multi_item_cart.sql?raw";
import migration0004 from "../migrations/0004_messaging_core.sql?raw";
import migration0005 from "../migrations/0005_messaging_handoff_audit.sql?raw";
import migration0006 from "../migrations/0006_messaging_handoff_resolution.sql?raw";
import migration0007 from "../migrations/0007_admin_login_security.sql?raw";
import migration0008 from "../migrations/0008_admin_web_sessions.sql?raw";
import migration0009 from "../migrations/0009_admin_activity_audit.sql?raw";

const migrations = [
  migration0001, migration0002, migration0004, migration0005,
  migration0006, migration0007, migration0008, migration0009
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
    "SELECT DISTINCT order_id FROM order_items WHERE sku=?"
  ).bind(sku).all<{ order_id: string }>();
  return (result.results || []).map(row => row.order_id);
}

async function cleanupSku(sku: string) {
  const ids = await orderIdsForSku(sku);
  for (const id of ids) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox WHERE aggregate_id=?").bind(id),
      env.DB.prepare("DELETE FROM admin_activity_audit WHERE resource_id=?").bind(id),
      env.DB.prepare("DELETE FROM order_events WHERE order_id=?").bind(id),
      env.DB.prepare("DELETE FROM order_item_inventory_movements WHERE order_id=?").bind(id),
      env.DB.prepare("DELETE FROM order_items WHERE order_id=?").bind(id),
      env.DB.prepare("DELETE FROM orders WHERE order_id=?").bind(id)
    ]);
  }
  await env.DB.prepare("DELETE FROM catalog_products WHERE sku=?").bind(sku).run();
}

describe("Seiton cart Durable Object runtime", () => {
  beforeAll(async () => {
    for (const migration of migrations) await env.DB.exec(migration);
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
