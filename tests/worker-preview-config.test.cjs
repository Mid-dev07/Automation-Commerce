const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

test("Worker Preview binds only isolated D1 and R2 resources", () => {
  const workerConfig = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
  const migrationConfig = JSON.parse(fs.readFileSync(path.join(root, "wrangler.preview-migrations.jsonc"), "utf8"));
  const preview = workerConfig.previews;

  assert.ok(preview, "a dedicated Previews block must be configured");

  const productionDb = workerConfig.d1_databases?.find(binding => binding.binding === "DB");
  const previewDb = preview.d1_databases?.find(binding => binding.binding === "DB");
  assert.equal(productionDb?.database_name, "seiton-transactions-prod");
  assert.equal(previewDb?.database_name, "seiton-preview-transactions-20261109");
  assert.notEqual(previewDb?.database_id, productionDb?.database_id);

  const migrationDb = migrationConfig.d1_databases?.find(binding => binding.binding === "DB");
  assert.equal(migrationDb?.database_id, previewDb?.database_id);
  assert.equal(migrationDb?.database_name, previewDb?.database_name);
  assert.equal(migrationDb?.migrations_dir, "migrations");
  assert.notEqual(migrationDb?.database_id, productionDb?.database_id);

  const productionR2 = workerConfig.r2_buckets?.find(binding => binding.binding === "PRODUCT_MEDIA");
  const previewR2 = preview.r2_buckets?.find(binding => binding.binding === "PRODUCT_MEDIA");
  assert.equal(productionR2?.bucket_name, "seiton-product-media");
  assert.equal(previewR2?.bucket_name, "seiton-preview-product-media-20261109");
  assert.notEqual(previewR2?.bucket_name, productionR2?.bucket_name);

  const doBinding = preview.durable_objects?.bindings?.find(binding => binding.name === "ORDER_COORDINATOR");
  assert.equal(doBinding?.class_name, "OrderCoordinator");

  assert.equal(preview.triggers, undefined, "cron triggers must not run for Preview deployments");
  assert.equal(preview.routes, undefined, "Preview must not attach production routes");
  assert.equal(preview.services, undefined, "Preview must not call production service bindings");

  assert.notEqual(workerConfig.preview_urls, true, "Preview URLs must not be enabled from source before Access is ready");
});

test("Preview config contains no production secrets or Google Sheets target", () => {
  const workerConfig = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
  const preview = workerConfig.previews;
  const serialized = JSON.stringify(preview);
  for (const secretName of [
    "TELEGRAM_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "ADMIN_WEB_PASSWORD",
    "ADMIN_CHAT_ID",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "GOOGLE_SHEETS_ID"
  ]) {
    assert.equal(serialized.includes(secretName), false, secretName + " must not be inherited by Preview");
  }
});
