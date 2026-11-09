const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const workerPath = path.join(root, "site-admin", "worker.js");
const worker = fs.readFileSync(workerPath, "utf8");

test("owner admin Worker parses", () => {
  execFileSync(process.execPath, ["--check", workerPath], { stdio: "pipe" });
});

test("owner admin signs the per-client identity before service-binding login", () => {
  assert.ok(worker.includes('"CF-Connecting-IP":g.clientIp'));
  assert.ok(worker.includes('"X-Real-IP":g.clientIp'));
  assert.ok(worker.includes("async function loginGate"));
  assert.ok(worker.includes("reason:\"CLIENT_IP_UNAVAILABLE\""));
});

test("owner admin does not merge missing client IPs into an unknown shared identity", () => {
  assert.ok(worker.includes('if(!clientIp)return {ok:false,id:"",reason:"CLIENT_IP_UNAVAILABLE"}'));
});

test("only an upstream credential rejection counts as a failed password", () => {
  assert.ok(worker.includes("if(upstream.status===401){await failLogin(env,g.id)"));
  assert.ok(worker.includes("if(upstream.status===429){return secure(j"));
  assert.ok(worker.includes("if(!upstream.ok){console.error"));
  assert.ok(worker.includes("owner_admin_login_upstream_unavailable"));
  assert.equal(
    worker.includes("if(!upstream.ok||!result.ok||!result.token){await failLogin(env,g.id)"),
    false
  );
});
