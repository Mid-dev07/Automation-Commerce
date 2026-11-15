import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../mail-automation/worker.js", import.meta.url), "utf8");

test("owner bridge rejects requests without its dedicated secret", () => {
  const start = worker.indexOf("async function handleOwnerBridge");
  assert.notEqual(start, -1);
  const end = worker.indexOf("async function api(", start);
  const source = worker.slice(start, end);
  assert.match(source, /MAIL_OWNER_BRIDGE_SECRET/);
  assert.match(source, /constantTimeEqual\(supplied, env\.MAIL_OWNER_BRIDGE_SECRET\)/);
  assert.ok(source.indexOf("constantTimeEqual") < source.indexOf("handleAliasesGet"));
});

test("owner bridge exposes bounded mailbox and message actions", () => {
  assert.match(worker, /\/api\/internal\/owner\/aliases/);
  assert.match(worker, /\/api\/internal\/owner\/messages/);
  assert.match(worker, /Batas 100 mailbox aktif/);
  assert.match(worker, /ALLOWED_TTLS\.has\(ttlSeconds\)/);
});

test("machine API remains separate from owner bridge", () => {
  assert.match(worker, /handleMachineApi\(request, env, url\)/);
  assert.match(worker, /handleOwnerBridge\(request, env, url\)/);
});
