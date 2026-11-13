import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDigitalCategory,
  parseDigitalStockLines,
  parseMuseBusinessSetupInput,
  addDigitalStockD1,
  createOtpPortalAccess
} from "../digital-products.mjs";

test("only the two documented stock categories are accepted", () => {
  assert.equal(normalizeDigitalCategory("MUSE_STARTER"), "muse_starter");
  assert.equal(normalizeDigitalCategory("muse_bisnis"), "muse_bisnis");
  assert.throws(() => normalizeDigitalCategory("otp_setup"), /DIGITAL_CATEGORY_INVALID/);
  assert.throws(() => normalizeDigitalCategory("unknown"), /DIGITAL_CATEGORY_INVALID/);
});

test("mass stock input validates domain, password and duplicates without logging credentials", () => {
  const rows = parseDigitalStockLines(
    "klien01@seiton.biz.id|SandiKuat#01|Garansi 3 hari\nklien02@usaha.biz.id|SandiKuat#02|Garansi 3 hari",
    "muse_starter"
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, "klien01@seiton.biz.id");
  assert.equal(rows[1].category, "muse_starter");
  assert.throws(() => parseDigitalStockLines("user@gmail.com|password123|note", "muse_starter"), /DIGITAL_STOCK_EMAIL_INVALID/);
  assert.throws(() => parseDigitalStockLines("user@seiton.biz.id|short|note", "muse_starter"), /DIGITAL_STOCK_PASSWORD_INVALID/);
  assert.throws(() => parseDigitalStockLines("a@seiton.biz.id|password123|x\na@seiton.biz.id|password456|y", "muse_starter"), /DIGITAL_STOCK_DUPLICATE_IN_BATCH/);
  assert.throws(() => parseDigitalStockLines("a@seiton.biz.id|password123|x", "otp_setup"), /DIGITAL_CATEGORY_INVALID/);
});

test("Muse Business onboarding accepts a token only in the documented SETUP format", () => {
  const parsed = parseMuseBusinessSetupInput("SETUP | Toko Maju | 123456:AbCdEfGhIjKlMnOpQrStUvWxYz123456789 | Jual sembako");
  assert.equal(parsed.businessName, "Toko Maju");
  assert.equal(parsed.telegramToken, "123456:AbCdEfGhIjKlMnOpQrStUvWxYz123456789");
  assert.equal(parsed.description, "Jual sembako");
  assert.throws(() => parseMuseBusinessSetupInput("SETUP | Toko | invalid-token | Jual sembako"), /DIGITAL_SETUP_TELEGRAM_TOKEN_INVALID/);
  assert.throws(() => parseMuseBusinessSetupInput("SETUP | Toko | 123456:AbCdEfGhIjKlMnOpQrStUvWxYz123456789"), /DIGITAL_SETUP_FORMAT_INVALID/);
});

test("stock insertion is blocked until Email Routing has been tested and enabled", async () => {
  await assert.rejects(
    addDigitalStockD1({}, "muse_starter", "test@seiton.biz.id|Password#123|test", "admin"),
    /OTP_EMAIL_ROUTING_NOT_READY/
  );
});

test("private mailbox links are blocked while Email Routing readiness is false", async () => {
  await assert.rejects(
    createOtpPortalAccess({ OTP_EMAIL_ROUTING_READY: "false" }, "test@seiton.biz.id", "INV-1", "123"),
    /OTP_EMAIL_ROUTING_NOT_READY/
  );
});

test("OTP portal URL must match the production private portal origin", async () => {
  const values = new Map();
  const env = {
    OTP_EMAIL_ROUTING_READY: "true",
    OTP_PORTAL_URL: "https://example.com",
    OTP_KV: { put: async (key,value,options) => values.set(key,{value,options}) }
  };
  await assert.rejects(
    createOtpPortalAccess(env, "test@seiton.biz.id", "INV-1", "123"),
    /OTP_PORTAL_URL_INVALID/
  );
});
