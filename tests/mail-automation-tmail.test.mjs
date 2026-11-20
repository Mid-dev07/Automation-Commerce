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
