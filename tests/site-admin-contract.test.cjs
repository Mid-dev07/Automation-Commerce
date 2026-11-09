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
  assert.match(worker, /async function signLoginClientId/);
  assert.match(worker, /SITE_ADMIN_LOGIN_SHARED_SECRET/);
  assert.match(worker, /X-Seiton-Login-Client/);
  assert.match(worker, /X-Seiton-Login-Signature/);
  assert.match(worker, /SEITON_SITE_ADMIN_LOGIN_V1\\./);
});

test("owner admin does not merge missing client IPs into an unknown shared identity", () => {
  assert.match(worker, /if\(!clientIp\)return \{ok:false,id:"",reason:"CLIENT_IP_UNAVAILABLE"\}/);
});

test("only an upstream credential rejection counts as a failed password", () => {
  assert.match(worker, /if\(upstream\.status===401\)\{await failLogin\(env,g\.id\)/);
  assert.match(worker, /if\(upstream\.status===429\)\{return secure\(j/);
  assert.match(worker, /if\(!upstream\.ok\)\{console\.error/);
  assert.match(worker, /owner_admin_login_upstream_unavailable/);
  assert.doesNotMatch(worker, /if\(!upstream\.ok\|\|!result\.ok\|\|!result\.token\)\{await failLogin/);
});
