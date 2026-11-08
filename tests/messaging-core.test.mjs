import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInboundEvent,
  parseMessagingChoice,
  parseMessagingCommand,
  parseMessagingAdminCommand,
  listMessagingHandoffs,
  claimMessagingHandoff,
  closeMessagingHandoff,
  queueMessagingHandoffReply,
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


function createHandoffEnv(initialHandoff, initialMode = "HUMAN", otherActive = false) {
  const state = {
    handoff: { ...initialHandoff },
    mode: initialMode,
    otherActive,
    outbox: []
  };

  function execute(sql, args) {
    if (sql.includes("UPDATE messaging_handoff_requests SET status='CLAIMED'")) {
      if (state.handoff.status === "OPEN" && state.handoff.handoff_id === args[3]) {
        state.handoff.status = "CLAIMED";
        state.handoff.claimed_by = args[0];
        state.handoff.claimed_at = args[1];
        state.handoff.updated_at = args[2];
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("UPDATE messaging_handoff_requests SET status='CLOSED'")) {
      if (
        state.handoff.handoff_id === args[3] &&
        ["OPEN", "CLAIMED"].includes(state.handoff.status) &&
        (!state.handoff.claimed_by || state.handoff.claimed_by === args[4])
      ) {
        state.handoff.status = "CLOSED";
        state.handoff.closed_by = args[0];
        state.handoff.closed_at = args[1];
        state.handoff.updated_at = args[2];
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("UPDATE messaging_conversations SET mode='BOT'")) {
      if (
        state.mode === "HUMAN" &&
        state.handoff.status === "CLOSED" &&
        state.handoff.closed_by === args[5] &&
        !state.otherActive
      ) {
        state.mode = "BOT";
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO messaging_outbox")) {
      state.outbox.push({
        action_id: args[0],
        tenant_id: args[1],
        channel: args[2],
        conversation_id: args[3],
        recipient_id: args[4],
        source_event_id: args[5],
        payload_json: args[6]
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql,
            args,
            first: async () => {
              if (sql.includes("FROM messaging_handoff_requests")) {
                return state.handoff.handoff_id === args[0] ? { ...state.handoff } : null;
              }
              if (sql.includes("FROM messaging_conversations")) return { mode: state.mode };
              return null;
            },
            all: async () => ({
              results: sql.includes("WHERE status IN ('OPEN','CLAIMED')") &&
                ["OPEN", "CLAIMED"].includes(state.handoff.status) ? [{ ...state.handoff }] : []
            }),
            run: async () => execute(sql, args)
          };
        }
      };
    },
    async batch(statements) {
      return statements.map(statement => execute(statement.sql, statement.args));
    }
  };
  return { DB, state };
}

const handoffRow = {
  handoff_id: "telegram:telegram:101:handoff",
  tenant_id: "seiton",
  source_channel: "telegram",
  conversation_id: "chat-99",
  customer_id: "user-99",
  customer_name: "Pelanggan",
  source_event_id: "telegram:101",
  status: "OPEN",
  claimed_by: null,
  claimed_at: null,
  closed_by: null,
  closed_at: null,
  created_at: "2026-11-08T00:00:00.000Z",
  updated_at: "2026-11-08T00:00:00.000Z"
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


test("parses admin handoff list, claim, reply, and close commands safely", () => {
  assert.deepEqual(parseMessagingAdminCommand("/handoff"), { kind: "HANDOFF_LIST" });
  assert.deepEqual(parseMessagingAdminCommand("/handoff@SeitonBot"), { kind: "HANDOFF_LIST" });
  assert.deepEqual(
    parseMessagingAdminCommand("/handoff_claim telegram:telegram:101:handoff"),
    { kind: "HANDOFF_CLAIM", handoffId: handoffRow.handoff_id }
  );
  assert.deepEqual(
    parseMessagingAdminCommand("/handoff_reply telegram:telegram:101:handoff Pesanan sedang kami periksa."),
    {
      kind: "HANDOFF_REPLY",
      handoffId: handoffRow.handoff_id,
      message: "Pesanan sedang kami periksa."
    }
  );
  assert.deepEqual(
    parseMessagingAdminCommand("/handoff_close telegram:telegram:101:handoff"),
    { kind: "HANDOFF_CLOSE", handoffId: handoffRow.handoff_id }
  );
  assert.equal(parseMessagingAdminCommand("/handoff_reply broken-id").kind, "INVALID");
  assert.equal(parseMessagingAdminCommand("/handoff_claim id with spaces").kind, "INVALID");
  assert.equal(parseMessagingAdminCommand("handoff").kind, "UNKNOWN");
});

test("lists current open and claimed handoffs", async () => {
  const env = createHandoffEnv(handoffRow);
  const items = await listMessagingHandoffs(env, 5);
  assert.equal(items.length, 1);
  assert.equal(items[0].handoff_id, handoffRow.handoff_id);
});

test("handoff claim is exclusive and idempotent for its assigned admin", async () => {
  const env = createHandoffEnv(handoffRow);
  const claimed = await claimMessagingHandoff(env, handoffRow.handoff_id, "admin-1");
  assert.equal(claimed.ok, true);
  assert.equal(claimed.handoff.status, "CLAIMED");
  assert.equal(claimed.handoff.claimed_by, "admin-1");

  const repeat = await claimMessagingHandoff(env, handoffRow.handoff_id, "admin-1");
  assert.equal(repeat.ok, true);
  assert.equal(repeat.alreadyClaimed, true);

  const other = await claimMessagingHandoff(env, handoffRow.handoff_id, "admin-2");
  assert.equal(other.ok, false);
  assert.equal(other.reason, "CLAIMED_BY_OTHER");
});

test("closing a handoff resumes BOT mode but preserves customer opt-out", async () => {
  const env = createHandoffEnv({ ...handoffRow, status: "CLAIMED", claimed_by: "admin-1" });
  const result = await closeMessagingHandoff(env, handoffRow.handoff_id, "admin-1");
  assert.equal(result.ok, true);
  assert.equal(result.automationResumed, true);
  assert.equal(env.state.handoff.status, "CLOSED");
  assert.equal(env.state.mode, "BOT");

  const optedOut = createHandoffEnv(
    { ...handoffRow, status: "CLAIMED", claimed_by: "admin-1" },
    "OPTED_OUT"
  );
  const optedOutResult = await closeMessagingHandoff(optedOut, handoffRow.handoff_id, "admin-1");
  assert.equal(optedOutResult.ok, true);
  assert.equal(optedOutResult.automationResumed, false);
  assert.equal(optedOut.state.mode, "OPTED_OUT");
});

test("a claimed handoff reply is queued only for its owning admin", async () => {
  const env = createHandoffEnv({
    ...handoffRow,
    status: "CLAIMED",
    claimed_by: "admin-1"
  });
  const denied = await queueMessagingHandoffReply(
    env, handoffRow.handoff_id, "admin-2", "Mohon tunggu sebentar."
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "CLAIMED_BY_OTHER");
  assert.equal(env.state.outbox.length, 0);

  const queued = await queueMessagingHandoffReply(
    env, handoffRow.handoff_id, "admin-1", "Mohon tunggu sebentar."
  );
  assert.equal(queued.ok, true);
  assert.equal(env.state.outbox.length, 1);
  const payload = JSON.parse(env.state.outbox[0].payload_json);
  assert.match(payload.text, /Mohon tunggu sebentar/);
  assert.equal(env.state.outbox[0].recipient_id, "chat-99");
});

test("closing one handoff does not resume BOT while another active case remains", async () => {
  const env = createHandoffEnv(
    { ...handoffRow, status: "CLAIMED", claimed_by: "admin-1" },
    "HUMAN",
    true
  );
  const result = await closeMessagingHandoff(env, handoffRow.handoff_id, "admin-1");
  assert.equal(result.ok, true);
  assert.equal(result.automationResumed, false);
  assert.equal(env.state.mode, "HUMAN");
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
  assert.match(result.actions[0].text, /Rp\s50\.000/);
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

test("maps provider button choices to channel-neutral commands", () => {
  assert.deepEqual(parseMessagingChoice("catalog"), { kind: "CATALOG" });
  assert.deepEqual(parseMessagingChoice("orders"), { kind: "ORDERS" });
  assert.deepEqual(parseMessagingChoice("help"), { kind: "MENU" });
  assert.deepEqual(parseMessagingChoice("admin"), { kind: "HANDOFF" });
  assert.deepEqual(parseMessagingChoice("unknown-button"), { kind: "UNKNOWN" });
});

test("a help choice returns the menu instead of an empty response", async () => {
  const result = await routeMessagingCommand(
    event,
    parseMessagingChoice("help"),
    "BOT",
    {}
  );
  assert.equal(result.actions.length, 1);
  assert.match(result.actions[0].text, /SELAMAT DATANG DI SEITON.ID/);
});
