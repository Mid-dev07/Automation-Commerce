import test from "node:test";
import assert from "node:assert/strict";
import { mailboxAddress, parseAliasRecipient, parseBearerToken } from "../mail-automation/worker.js";

test("accepts only safe custom local parts on the configured primary TMail domain", () => {
  for (const name of ["temakuro", "my.signup", "seiton_otp", "my-mailbox-01"]) {
    assert.equal(parseAliasRecipient(name + "@seiton.my.id")?.slug, name);
    assert.equal(mailboxAddress(name), name + "@seiton.my.id");
  }
  for (const name of ["ab", ".start", "end.", "two..dots", "bad+tag", "-start", "has space"]) {
    assert.equal(parseAliasRecipient(name + "@seiton.my.id"), null);
  }
});

test("keeps legacy plus aliases and random TMail addresses compatible", () => {
  const legacy = "receiver+0123456789abcdef01234567@seiton.my.id";
  const random = "0123456789abcdef0123456789abcdef@seiton.my.id";
  assert.equal(parseAliasRecipient(legacy)?.format, "legacy-alias");
  assert.equal(parseAliasRecipient(random)?.format, "tmail");
  assert.equal(mailboxAddress("0123456789abcdef01234567"), legacy);
});

test("rejects custom local parts on unconfigured domains", () => {
  assert.equal(parseAliasRecipient("temakuro@seiton.biz.id"), null);
  assert.equal(parseAliasRecipient("temakuro@inbox.seiton.biz.id"), null);
});

test("reserved machine API token parsing remains unchanged", () => {
  assert.equal(parseBearerToken(new Request("https://example.test", {
    headers: { Authorization: "Bearer " + "x".repeat(48) }
  })), "x".repeat(48));
});
