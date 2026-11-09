const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");
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
  assert.ok(worker.includes("if(upstream.status===429)return secure(j"));
  assert.ok(worker.includes("if(!upstream.ok){console.error"));
  assert.ok(worker.includes("owner_admin_login_upstream_unavailable"));
  assert.equal(
    worker.includes("if(!upstream.ok||!result.ok||!result.token){await failLogin(env,g.id)"),
    false
  );
});

test("owner admin stores hashed session tokens and checks expiry/revocation", () => {
  assert.ok(worker.includes('digest("site-owner-session:"+token)'));
  assert.ok(worker.includes("FROM site_admin_sessions WHERE token_hash=?"));
  assert.ok(worker.includes("revoked_at_ms"));
  assert.ok(worker.includes("expires_at_ms"));
  assert.ok(worker.includes("UPDATE site_admin_sessions SET last_seen_at_ms=?"));
  assert.ok(worker.includes("INSERT INTO site_admin_sessions"));
});

test("owner admin mutating endpoints enforce exact same-origin checks", () => {
  assert.ok(worker.includes('function sameOriginAdmin(req){return req.headers.get("Origin")==="https://admin.seiton.biz.id";}'));
  assert.ok(worker.includes('if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));'));
  assert.ok(worker.includes("/api/admin/sessions/revoke"));
});

test("pricing audit is committed atomically with the catalog replacement", () => {
  assert.ok(worker.includes("function buildPricingAudit"));
  assert.ok(worker.includes('action:"PRICING_UPDATED",resource:"site_pricing"'));
  assert.ok(worker.includes("if(summary.changes.length)q.push(newAuditStatement"));
  assert.ok(worker.includes("await env.SITE_DB.batch(q)"));
  assert.ok(worker.includes("/api/admin/audit"));
});

test("audit snapshots avoid customer-message content and raw IP data", () => {
  assert.ok(worker.includes("function auditSnapshot(kind,row)"));
  assert.ok(worker.includes("tersedia:Boolean(row.tersedia)"));
  assert.ok(worker.includes("client_hash"));
  assert.ok(!worker.includes("ip_address"));
});

test("audit and active-session endpoints require an authenticated session", () => {
  assert.ok(worker.includes('if(u.pathname==="/api/admin/audit"&&req.method==="GET")'));
  assert.ok(worker.includes('if(u.pathname==="/api/admin/sessions"&&req.method==="GET")'));
  assert.ok(worker.includes("const session=await activeSession(req,env)"));
});

test("owner admin audit and session controls are visible in the panel", () => {
  assert.ok(worker.includes("id='auditList'"));
  assert.ok(worker.includes("id='sessionList'"));
  assert.ok(worker.includes("data-revoke-session"));
  assert.ok(worker.includes("loadAudit()"));
  assert.ok(worker.includes("loadSessions()"));
});

test("owner admin inline dashboard JavaScript parses", () => {
  const start=worker.indexOf("function page(){");
  const end=worker.indexOf("export default",start);
  assert.ok(start>=0&&end>start);
  const pageFn=worker.slice(start,end);
  const html=vm.runInNewContext(pageFn+"\npage();");
  const scriptStart=html.indexOf("<script>");
  const scriptEnd=html.indexOf("</script>",scriptStart);
  assert.ok(scriptStart>=0&&scriptEnd>scriptStart);
  const inlineScript=html.slice(scriptStart+8,scriptEnd);
  new vm.Script(inlineScript,{filename:"site-admin-inline.js"});
});
