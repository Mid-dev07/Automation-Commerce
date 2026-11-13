import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDigitalCategory,
  parseDigitalStockLines
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
