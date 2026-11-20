import test from "node:test";
import assert from "node:assert/strict";
import { mailboxAddress, parseAliasRecipient, randomHex } from "../mail-automation/worker.js";

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

test("rejects malformed, wrong-domain, and unsupported local parts", () => {
  assert.equal(parseAliasRecipient("not-an-address"), null);
  assert.equal(parseAliasRecipient(tmailLocalPart + "@example.com"), null);
  assert.equal(parseAliasRecipient("receiver+" + tmailLocalPart + "@seiton.my.id"), null);
  assert.equal(parseAliasRecipient("g".repeat(32) + "@seiton.my.id"), null);
});

test("formats new TMail and legacy mailbox records without changing old addresses", () => {
  assert.equal(mailboxAddress(tmailLocalPart), tmailLocalPart + "@seiton.my.id");
  assert.equal(mailboxAddress(legacySlug), "receiver+" + legacySlug + "@seiton.my.id");
});

test("rejects invalid mailbox slugs before formatting an address", () => {
  assert.throws(() => mailboxAddress("invalid"), /MAILBOX_SLUG_INVALID/);
});
