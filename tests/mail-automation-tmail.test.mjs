import test from "node:test";
import assert from "node:assert/strict";
import {
  mailboxAddress,
  parseAliasRecipient,
  randomHex,
  isAllowedMailboxTtl,
  isMailboxActive,
  MAILBOX_TTL_OPTIONS_SECONDS
} from "../mail-automation/worker.js";

const tmailLocalPart = "a".repeat(32);
const legacySlug = "b".repeat(24);

test("generates a 32-character lowercase hexadecimal TMail local part", () => {
  assert.match(randomHex(32), /^[a-f0-9]{32}$/);
});

test("parses standalone TMail addresses on the primary Seiton mail domain", () => {
  const address = tmailLocalPart + "@seiton.my.id";
  assert.deepEqual(parseAliasRecipient(address), {
    slug: tmailLocalPart,
    address,
    format: "tmail"
  });
});

test("preserves existing plus-address mailboxes during migration", () => {
  const address = "receiver+" + legacySlug + "@seiton.my.id";
  assert.deepEqual(parseAliasRecipient(address), {
    slug: legacySlug,
    address,
    format: "legacy-alias"
  });
});

test("continues accepting the configured legacy inbox subdomain", () => {
  const address = "receiver+" + legacySlug + "@inbox.seiton.biz.id";
  assert.deepEqual(parseAliasRecipient(address), {
    slug: legacySlug,
    address,
    format: "legacy-alias"
  });
});

test("rejects prefixless TMail addresses on the legacy inbox subdomain", () => {
  assert.equal(parseAliasRecipient(tmailLocalPart + "@inbox.seiton.biz.id"), null);
});

test("accepts valid custom addresses and rejects malformed or wrong-domain local parts", () => {
  const custom = "temakuro@seiton.my.id";
  assert.deepEqual(parseAliasRecipient(custom), {
    slug: "temakuro",
    address: custom,
    format: "custom-tmail"
  });
  assert.equal(parseAliasRecipient("not-an-address"), null);
  assert.equal(parseAliasRecipient(tmailLocalPart + "@example.com"), null);
  assert.equal(parseAliasRecipient("receiver+" + tmailLocalPart + "@seiton.my.id"), null);
  assert.equal(parseAliasRecipient("two..dots@seiton.my.id"), null);
  assert.equal(parseAliasRecipient("bad$name@seiton.my.id"), null);
});

test("formats new TMail and legacy mailbox records without changing old addresses", () => {
  assert.equal(mailboxAddress(tmailLocalPart), tmailLocalPart + "@seiton.my.id");
  assert.equal(mailboxAddress(legacySlug), "receiver+" + legacySlug + "@seiton.my.id");
});

test("formats custom mailboxes and rejects invalid mailbox slugs", () => {
  assert.equal(mailboxAddress("temakuro"), "temakuro@seiton.my.id");
  assert.throws(() => mailboxAddress("ab"), /MAILBOX_SLUG_INVALID/);
  assert.throws(() => mailboxAddress("bad$name"), /MAILBOX_SLUG_INVALID/);
});


test("supports configured mailbox lifetime options through 30 days", () => {
  assert.deepEqual(MAILBOX_TTL_OPTIONS_SECONDS, [
    600, 3600, 21600, 43200, 86400, 259200, 604800, 1209600, 2592000
  ]);
  for (const ttl of MAILBOX_TTL_OPTIONS_SECONDS) assert.equal(isAllowedMailboxTtl(ttl), true);
  assert.equal(isAllowedMailboxTtl("2592000"), true);
  for (const ttl of [0, 300, 900, 2592001, -600, "30 days", null]) {
    assert.equal(isAllowedMailboxTtl(ttl), false);
  }
});

test("mailbox active state respects status and expiry timestamp", () => {
  const now = 1_800_000_000_000;
  assert.equal(isMailboxActive({ status: "ACTIVE", expires_at: now + 1000 }, now), true);
  assert.equal(isMailboxActive({ status: "ACTIVE", expires_at: now }, now), false);
  assert.equal(isMailboxActive({ status: "ACTIVE", expires_at: now - 1 }, now), false);
  assert.equal(isMailboxActive({ status: "EXPIRED", expires_at: now + 1000 }, now), false);
  assert.equal(isMailboxActive({ status: "REVOKED", expires_at: now + 1000 }, now), false);
});

test("mail-automation migrations 0001 through 0003 bootstrap all 14 tables cleanly", async () => {
  const { readFileSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  for (const file of [
    "../mail-automation/migrations/0001_initial.sql",
    "../mail-automation/migrations/0002_owner_2fa_machine_tokens.sql",
    "../mail-automation/migrations/0003_public_tmail_inboxes.sql"
  ]) {
    db.exec(readFileSync(new URL(file, import.meta.url), "utf8"));
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.equal(tables.length, 14);
  assert.ok(tables.includes("mail_admin"));
  assert.ok(tables.includes("mail_aliases"));
  assert.ok(tables.includes("mail_messages"));
  assert.ok(tables.includes("mail_public_mailboxes"));
});
