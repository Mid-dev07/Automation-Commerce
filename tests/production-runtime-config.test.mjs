import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("order bot deploy config includes production bindings and safe feature flags", () => {
  const config = readJson(new URL("../wrangler.jsonc", import.meta.url));
  assert.equal(config.name, "seiton-order-bot");
  assert.equal(config.main, "worker.js");
  assert.ok(config.r2_buckets?.some((binding) =>
    binding.binding === "PRODUCT_MEDIA" && binding.bucket_name === "seiton-product-media"
  ));
  assert.equal(config.ai?.binding, "AI");
  assert.ok(config.vars?.GOOGLE_SHEETS_ID, "GOOGLE_SHEETS_ID must be preserved in wrangler.jsonc");
  assert.equal(config.vars?.OTP_EMAIL_ROUTING_READY, "false");
  assert.equal(config.vars?.QRIS_INTERNAL_ENABLED, "true");
  assert.equal(config.vars?.QRIS_STATIC_FALLBACK_ENABLED, "true");
  assert.equal(existsSync(new URL("../wrangler.toml", import.meta.url)), false, "legacy wrangler.toml should be removed");
});

test("OTP portal config matches deployed entrypoint and bindings", () => {
  const config = readJson(new URL("../otp-portal/wrangler.jsonc", import.meta.url));
  assert.equal(config.name, "seiton-otp-portal");
  assert.equal(config.main, "index.js");
  assert.ok(config.compatibility_flags?.includes("nodejs_compat"));
  assert.ok(config.kv_namespaces?.some((binding) => binding.binding === "MUSE_KV"));
  assert.ok(config.kv_namespaces?.some((binding) => binding.binding === "OTP_KV"));
  assert.ok(config.durable_objects?.bindings?.some((binding) =>
    binding.name === "MAILBOX_INDEX" && binding.class_name === "MailboxIndex"
  ));
  assert.equal(config.vars?.OTP_ALLOWED_DOMAINS, "seiton.biz.id");
  assert.equal(config.vars?.OTP_PORTAL_URL, "https://otp.seiton.biz.id");
  assert.ok(existsSync(new URL("../otp-portal/index.js", import.meta.url)));
  assert.ok(existsSync(new URL("../otp-portal/email-parser.js", import.meta.url)));
  assert.equal(existsSync(new URL("../otp-portal/worker.js", import.meta.url)), false, "legacy otp-portal/worker.js should be removed");
});

test("site admin config declares both production service bindings", () => {
  const config = readJson(new URL("../site-admin/wrangler.jsonc", import.meta.url));
  assert.equal(config.name, "seiton-site-admin");
  assert.ok(config.services?.some((binding) =>
    binding.binding === "ORDER_BACKEND" && binding.service === "seiton-order-bot"
  ));
  assert.ok(config.services?.some((binding) =>
    binding.binding === "OTP_BACKEND" && binding.service === "seiton-otp-portal"
  ));
  assert.ok(config.services?.some((binding) =>
    binding.binding === "MAIL_BACKEND" && binding.service === "seiton-mail-automation"
  ));
  assert.ok(config.d1_databases?.some((binding) =>
    binding.binding === "SITE_DB" && binding.database_name === "seiton-site-content-prod"
  ));
  assert.ok(existsSync(new URL("../site-admin/worker.js", import.meta.url)));
});
