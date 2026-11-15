import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateProjectStatus, validateProjectAmount } from "../site-admin/owner-operations.js";

test("owner CRM accepts only known project stages", () => {
  assert.equal(validateProjectStatus("MENUNGGU_DP"), "MENUNGGU_DP");
  assert.throws(() => validateProjectStatus("PAID"), /Tahap proyek tidak dikenal/);
});
test("owner CRM amount validation rejects fractions, negatives, and oversized values", () => {
  assert.equal(validateProjectAmount(250000), 250000);
  assert.throws(() => validateProjectAmount(1.5));
  assert.throws(() => validateProjectAmount(-1));
  assert.throws(() => validateProjectAmount(1_000_000_001));
});
test("CRM schema separates clients, projects, payment entries, and append-only events", async () => {
  const sql = await readFile(new URL("../site-admin/migrations/0002_owner_project_pipeline.sql", import.meta.url), "utf8");
  for (const table of ["owner_clients","owner_projects","owner_project_payments","owner_project_events"]) assert.match(sql, new RegExp("CREATE TABLE IF NOT EXISTS " + table));
  assert.match(sql, /REFERENCES owner_clients/);
  assert.match(sql, /PENGEMBALIAN/);
  assert.match(sql, /passwords, OTPs, access tokens, bank credentials/i);
});
test("owner operations endpoints are protected by owner-session and same-origin checks", async () => {
  const worker = await readFile(new URL("../site-admin/worker.js", import.meta.url), "utf8");
  assert.match(worker, /\\/api\\/owner\\/operations/);
  assert.match(worker, /activeSession(req,env)/);
  assert.match(worker, /sameOriginAdmin(req)/);
  assert.match(worker, /ownerOperationsPage()/);
});
