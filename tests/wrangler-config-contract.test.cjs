const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

test("Worker deployment configuration has one canonical JSONC source", () => {
  const configPath = path.join(root, "wrangler.jsonc");
  const legacyTomlPath = path.join(root, "wrangler.toml");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(fs.existsSync(legacyTomlPath), false, "duplicate TOML config must stay removed");
  assert.equal(config.name, "seiton-order-bot");
  assert.equal(config.main, "worker.js");

  const database = config.d1_databases?.find(binding => binding.binding === "DB");
  assert.ok(database, "transaction D1 binding must exist");
  assert.equal(database.database_name, "seiton-transactions-prod");
  assert.equal(database.migrations_dir, "migrations");

  assert.ok(
    typeof config.vars?.GOOGLE_SHEETS_ID === "string" && config.vars.GOOGLE_SHEETS_ID.trim(),
    "the existing non-secret Sheets identifier must remain configured"
  );

  const media = config.r2_buckets?.find(binding => binding.binding === "PRODUCT_MEDIA");
  assert.equal(media?.bucket_name, "seiton-product-media");

  const coordinator = config.durable_objects?.bindings?.find(binding => binding.name === "ORDER_COORDINATOR");
  assert.equal(coordinator?.class_name, "OrderCoordinator");
});
