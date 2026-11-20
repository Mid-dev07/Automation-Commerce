import test from "node:test";
import assert from "node:assert/strict";
import { SeitonMailApiError, SeitonMailClient, TMailApiError, TMailClient } from "../mail-automation/agent-client.mjs";

const token = "t".repeat(48);
const mailboxId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const result = await handler({ url, init, calls });
    return new Response(JSON.stringify(result.payload ?? result), {
      status: result.status ?? 200,
      headers: {
        "Content-Type": "application/json",
        ...(result.retryAfter ? { "Retry-After": result.retryAfter } : {})
      }
    });
  };
  return { fetchImpl, calls };
}

test("requires a URL-safe machine token and HTTPS base URL", () => {
  assert.throws(() => new TMailClient({ token: "short" }), /Bearer token/i);
  assert.throws(() => new TMailClient({ token: "x".repeat(48), baseUrl: "http://mail.seiton.biz.id" }), /HTTPS/i);
});

test("creates a 10-minute mailbox with an idempotent client reference", async () => {
  const { fetchImpl, calls } = fakeFetch(async ({ url, init }) => {
    assert.equal(url.pathname, "/api/v1/machine/mailboxes");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.headers.Cookie, undefined);
    assert.deepEqual(JSON.parse(init.body), {
      label: "signup",
      ttlSeconds: 600,
      clientRef: "task-4821"
    });
    return { payload: { ok: true, reused: false, mailbox: { id: mailboxId } }, status: 201 };
  });

  const client = new TMailClient({ token, fetchImpl });
  const result = await client.createMailbox({ label: "signup", clientRef: "task-4821" });
  assert.equal(result.mailbox.id, mailboxId);
  assert.equal(calls.length, 1);
});

test("lists mailboxes with bounded pagination", async () => {
  const { fetchImpl, calls } = fakeFetch(async ({ init }) => {
    assert.equal(init.method, "GET");
    return { payload: { ok: true, mailboxes: [] } };
  });
  const client = new TMailClient({ token, fetchImpl });
  await client.listMailboxes({ limit: 50, offset: 100 });
  assert.equal(calls[0].url.pathname, "/api/v1/machine/mailboxes");
  assert.equal(calls[0].url.searchParams.get("limit"), "50");
  assert.equal(calls[0].url.searchParams.get("offset"), "100");
  assert.throws(() => client.listMailboxes({ limit: 51 }), /limit/i);
});

test("lists summaries with mailbox ownership and message cursor", async () => {
  const { fetchImpl, calls } = fakeFetch(async () => ({ payload: { ok: true, messages: [] } }));
  const client = new TMailClient({ token, fetchImpl });
  await client.listMessages({ mailboxId, after: 123, afterId: messageId });
  assert.equal(calls[0].url.pathname, "/api/v1/machine/messages");
  assert.equal(calls[0].url.searchParams.get("mailboxId"), mailboxId);
  assert.equal(calls[0].url.searchParams.get("after"), "123");
  assert.equal(calls[0].url.searchParams.get("afterId"), messageId);
});

test("reads one message body only within the requested mailbox", async () => {
  const { fetchImpl, calls } = fakeFetch(async () => ({
    payload: { ok: true, message: { id: messageId, body_text: "verification code" } }
  }));
  const client = new TMailClient({ token, fetchImpl });
  const result = await client.getMessage({ mailboxId, messageId });
  assert.equal(result.message.body_text, "verification code");
  assert.equal(calls[0].url.pathname, `/api/v1/machine/messages/${messageId}`);
  assert.equal(calls[0].url.searchParams.get("mailboxId"), mailboxId);
});

test("revokes only the requested mailbox endpoint", async () => {
  const { fetchImpl, calls } = fakeFetch(async () => ({ payload: { ok: true } }));
  const client = new TMailClient({ token, fetchImpl });
  await client.revokeMailbox(mailboxId);
  assert.equal(calls[0].url.pathname, `/api/v1/machine/mailboxes/${mailboxId}`);
  assert.equal(calls[0].init.method, "DELETE");
});

test("surfaces HTTP errors and Retry-After without exposing the token", async () => {
  const { fetchImpl } = fakeFetch(async () => ({
    payload: { ok: false, error: "Rate limited" },
    status: 429,
    retryAfter: "60"
  }));
  const client = new TMailClient({ token, fetchImpl });
  await assert.rejects(
    client.health(),
    (error) => error instanceof TMailApiError &&
      error.status === 429 &&
      error.retryAfter === "60" &&
      !error.message.includes(token)
  );
});

test("requires clientRef and valid mailbox IDs", () => {
  const { fetchImpl } = fakeFetch(async () => ({ payload: { ok: true } }));
  const client = new TMailClient({ token, fetchImpl });
  assert.throws(() => client.createMailbox({}), /clientRef/i);
  assert.throws(() => client.listMessages({ mailboxId: "bad" }), /mailboxId/i);
});


test("creates a mailbox with a configurable 30-day lifetime", async () => {
  const { fetchImpl, calls } = fakeFetch(async ({ init }) => {
    assert.equal(JSON.parse(init.body).ttlSeconds, 2592000);
    return { payload: { ok: true, reused: false, mailbox: { id: mailboxId } }, status: 201 };
  });
  const client = new TMailClient({ token, fetchImpl });
  const result = await client.createMailbox({
    label: "long-task",
    clientRef: "task-30d",
    ttlSeconds: 2592000
  });
  assert.equal(result.mailbox.id, mailboxId);
  assert.equal(calls.length, 1);
});

test("rejects unsupported TTL values before making an API request", async () => {
  const { fetchImpl, calls } = fakeFetch(async () => ({ payload: { ok: true } }));
  const client = new TMailClient({ token, fetchImpl });
  assert.throws(
    () => client.createMailbox({ clientRef: "invalid-ttl", ttlSeconds: 2592001 }),
    /supported durations/i
  );
  assert.equal(calls.length, 0);
});


test("exposes SeitonMail brand names and retains legacy TMail aliases", () => {
  assert.equal(TMailClient, SeitonMailClient);
  assert.equal(TMailApiError, SeitonMailApiError);
  const client = new SeitonMailClient({ token, fetchImpl: async () => new Response("{}") });
  assert.ok(client instanceof TMailClient);
  const error = new SeitonMailApiError("test");
  assert.ok(error instanceof TMailApiError);
  assert.equal(error.name, "SeitonMailApiError");
});
