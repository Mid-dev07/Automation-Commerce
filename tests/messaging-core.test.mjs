import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInboundEvent,
  parseMessagingCommand,
  routeMessagingCommand
} from "../messaging-core.mjs";

const event = {
  tenantId: "seiton",
  channel: "telegram",
  eventId: "telegram:101",
  externalMessageId: "msg-77",
  conversationId: "chat-99",
  senderId: "user-99",
  customerName: "Pelanggan",
  text: "MENU",
  fromMe: false,
  isDirect: true
};

test("normalizes a direct customer message without changing its identity", () => {
  const normalized = normalizeInboundEvent(event);
  assert.equal(normalized.channel, "telegram");
  assert.equal(normalized.senderId, "user-99");
  assert.equal(normalized.text, "MENU");
});

test("rejects unsupported channels and non-customer events", () => {
  assert.throws(() => normalizeInboundEvent({ ...event, channel: "baileys" }), /UNSUPPORTED_CHANNEL/);
  assert.throws(() => normalizeInboundEvent({ ...event, fromMe: true }), /NON_CUSTOMER_EVENT/);
  assert.throws(() => normalizeInboundEvent({ ...event, conversationId: "" }), /MISSING_IDENTITY/);
});

test("parses supported user commands case-insensitively", () => {
  assert.deepEqual(parseMessagingCommand("katalog"), { kind: "CATALOG" });
  assert.deepEqual(parseMessagingCommand("PESANAN"), { kind: "ORDERS" });
  assert.deepEqual(parseMessagingCommand("STATUS SEI-20261108-ABCD1234"), {
    kind: "STATUS",
    orderId: "SEI-20261108-ABCD1234"
  });
  assert.deepEqual(parseMessagingCommand("beli sei-001 2 qris"), {
    kind: "BUY",
    sku: "SEI-001",
    quantity: 2,
    paymentMethod: "QRIS"
  });
});

test("does not parse invalid quantities or unsupported payment methods", () => {
  assert.deepEqual(parseMessagingCommand("BELI SEI-001 0 QRIS"), { kind: "UNKNOWN" });
  assert.deepEqual(parseMessagingCommand("BELI SEI-001 2 GOPAY"), { kind: "UNKNOWN" });
  assert.deepEqual(parseMessagingCommand("BELI SEI-001 1001 COD"), { kind: "UNKNOWN" });
});

test("STOP disables automation and START explicitly re-enables it", async () => {
  const stop = await routeMessagingCommand(event, parseMessagingCommand("STOP"), "BOT", {});
  assert.equal(stop.mode, "OPTED_OUT");
  assert.match(stop.actions[0].text, /dinonaktifkan/);

  const start = await routeMessagingCommand(event, parseMessagingCommand("START"), "OPTED_OUT", {});
  assert.equal(start.mode, "BOT");
  assert.match(start.actions[0].text, /diaktifkan kembali/);
});

test("human handoff pauses the bot and creates admin notifications", async () => {
  const result = await routeMessagingCommand(
    event,
    parseMessagingCommand("ADMIN"),
    "BOT",
    { getAdminTargets: async () => ["admin-chat-1"] }
  );
  assert.equal(result.mode, "HUMAN");
  assert.equal(result.handoff.sourceEventId, event.eventId);
  assert.equal(result.actions.length, 2);
  assert.equal(result.actions[0].channel, "telegram");
  assert.equal(result.actions[0].recipientId, "admin-chat-1");
});

test("human mode does not emit automatic replies for ordinary messages", async () => {
  const result = await routeMessagingCommand(
    { ...event, text: "MENU" },
    parseMessagingCommand("MENU"),
    "HUMAN",
    {}
  );
  assert.equal(result.actions.length, 0);
  assert.equal(result.mode, "HUMAN");
});

test("routes catalog requests through the provider-independent product service", async () => {
  const result = await routeMessagingCommand(
    event,
    parseMessagingCommand("KATALOG"),
    "BOT",
    { listProducts: async () => [
      { sku: "SEI-001", name: "Produk A", price: 25000, stock: 4, active: true },
      { sku: "SEI-002", name: "Produk B", price: 30000, stock: 0, active: false }
    ] }
  );
  assert.equal(result.actions.length, 1);
  assert.match(result.actions[0].text, /SEI-001/);
  assert.doesNotMatch(result.actions[0].text, /SEI-002/);
});

test("order creation forwards channel-scoped identity and stable idempotency key", async () => {
  let received;
  const result = await routeMessagingCommand(
    { ...event, text: "BELI SEI-001 2 QRIS" },
    parseMessagingCommand("BELI SEI-001 2 QRIS"),
    "BOT",
    {
      createOrder: async input => {
        received = input;
        return {
          orderId: "SEI-20261108-ABCD1234",
          product: "Produk A",
          sku: "SEI-001",
          quantity: 2,
          unitPrice: 25000,
          shipping: 0,
          total: 50000,
          paymentMethod: "QRIS",
          status: "MENUNGGU_PEMBAYARAN"
        };
      },
      getPaymentInstructions: () => "Instruksi QRIS tersedia."
    }
  );
  assert.equal(received.channel, "telegram");
  assert.equal(received.customerId, "user-99");
  assert.equal(received.idempotencyKey, event.eventId);
  assert.match(result.actions[0].text, /Rp50.000/);
  assert.equal(result.actions[0].buttons[0].value, "orders");
});

test("status lookup rejects an order from another channel or sender", async () => {
  const result = await routeMessagingCommand(
    event,
    parseMessagingCommand("STATUS SEI-20261108-ABCD1234"),
    "BOT",
    {
      findOrder: async () => ({
        orderId: "SEI-20261108-ABCD1234",
        customerId: "user-else",
        channel: "whatsapp",
        product: "Produk A",
        quantity: 1,
        total: 25000,
        paymentMethod: "COD",
        status: "MENUNGGU_PEMBAYARAN"
      })
    }
  );
  assert.match(result.actions[0].text, /tidak ditemukan/);
});

test("BANTUAN ADMIN is parsed as handoff rather than general help", () => {
  assert.deepEqual(parseMessagingCommand("BANTUAN ADMIN"), { kind: "HANDOFF" });
});
