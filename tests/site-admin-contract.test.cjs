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

test("owner admin mutating endpoints enforce the explicit same-origin allowlist", () => {
  assert.ok(worker.includes('function sameOriginAdmin(req){const origin=req.headers.get("Origin");return origin==="https://admin.seiton.biz.id"||origin==="https://owner.seiton.biz.id";}'));
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
  const html=new vm.Script(pageFn+"\npage();",{filename:"owner-page.js"}).runInNewContext();
  const scriptStart=html.indexOf("<script>");
  const scriptEnd=html.indexOf("</script>",scriptStart);
  assert.ok(scriptStart>=0&&scriptEnd>scriptStart);
  const inlineScript=html.slice(scriptStart+8,scriptEnd);
  new vm.Script(inlineScript,{filename:"site-admin-inline.js"});
});

test("owner admin session revocation is propagated to bot D1 registry before local revocation", () => {
  assert.ok(worker.includes("/api/admin/session/revoke"));
  assert.ok(worker.includes("async function revokeBackendWebSession"));
  assert.ok(worker.includes('JSON.stringify({token_hash:targetTokenHash})'));
  assert.ok(worker.includes("revokeBackendWebSession(env,session.token,target.token_hash)"));
  assert.ok(worker.includes("revokeBackendWebSession(env,token,tokenHash)"));
});

test("owner admin revokes orphaned backend sessions when its local registry write fails", () => {
  assert.ok(worker.includes("owner_admin_orphan_session_revoke_failed"));
  assert.ok(worker.includes("revokeBackendWebSession(env,result.token,tokenHash)"));
});

test("owner admin reconciles locally registered sessions after backend invalidation", () => {
  assert.ok(worker.includes('reason:"backend_session_invalid"'));
  assert.ok(worker.includes("UPDATE site_admin_sessions SET revoked_at_ms=? WHERE session_id=? AND revoked_at_ms IS NULL"));
});

test("owner admin merges backend operational audit with local panel audit", () => {
  assert.match(worker, /\/api\/admin\/activity-audit\?limit=/);
  assert.match(worker, /Authorization:\"Bearer \"\+session\.token/);
  assert.match(worker, /localItems\.concat\(operationalItems\)/);
  assert.match(worker, /activity_available:activityAvailable/);
});

test("owner admin audit UI labels order-state and Telegram actions", () => {
  assert.match(worker, /PAYMENT_APPROVED:'Pembayaran disetujui'/);
  assert.match(worker, /STATUS_CHANGED:'Status pesanan diubah'/);
  assert.match(worker, /HANDOFF_REPLY_QUEUED:'Balasan admin masuk antrean'/);
  assert.match(worker, /ADMIN_MENU_OPENED:'Menu admin Telegram dibuka'/);
  assert.match(worker, /transitionLabel=s\.transition_type==='payment_confirmation'\?'Verifikasi pembayaran':'Status pesanan'/);
  assert.match(worker, /Produk diarsipkan/);
  assert.match(worker, /Isi tidak disimpan|isi tidak disimpan/);
});


test("owner panel integrates bot health, Telegram webhook, catalog and recent orders", () => {
  assert.ok(worker.includes("id='bot-console'"));
  assert.ok(worker.includes("id='botMetrics'"));
  assert.ok(worker.includes("id='botProducts'"));
  assert.ok(worker.includes("id='botOrders'"));
  assert.ok(worker.includes("loadBotConsole()"));
  assert.ok(worker.includes("/api/admin/bot/diagnostics"));
  assert.ok(worker.includes("/api/admin/bot/data"));
});

test("owner panel uses the existing authenticated service binding for bot catalog CRUD", () => {
  assert.ok(worker.includes('if(u.pathname==="/api/admin/bot/data"&&req.method==="GET")'));
  assert.ok(worker.includes('if(u.pathname==="/api/admin/bot/diagnostics"&&req.method==="GET")'));
  assert.ok(worker.includes('if(u.pathname==="/api/admin/bot/products"&&req.method==="POST")'));
  assert.ok(worker.includes("Authorization:\"Bearer \"+session.token"));
  assert.ok(worker.includes("https://internal/api/admin/data"));
  assert.ok(worker.includes("https://internal/api/admin/products"));
  assert.ok(worker.includes("if(!sameOriginAdmin(req))return secure(j"));
  assert.ok(worker.includes("const session=await activeSession(req,env)"));
});

test("owner panel exposes a guided add/edit product form and archives instead of hard deleting", () => {
  assert.ok(worker.includes("id='botProductForm'"));
  assert.ok(worker.includes("id='botSku'"));
  assert.ok(worker.includes("id='botPhoto'"));
  assert.ok(worker.includes("original_sku:editingBotSku"));
  assert.ok(worker.includes("action:'delete'"));
  assert.ok(worker.includes("Arsipkan"));
});

test("bot inline dashboard JavaScript parses with product-management handlers", () => {
  const start=worker.indexOf("function page(){");
  const end=worker.indexOf("export default",start);
  const html=vm.runInNewContext(worker.slice(start,end)+"\npage();");
  const scriptStart=html.indexOf("<script>");
  const scriptEnd=html.indexOf("</script>",scriptStart);
  assert.ok(scriptStart>=0&&scriptEnd>scriptStart);
  new vm.Script(html.slice(scriptStart+8,scriptEnd),{filename:"site-admin-bot-console.js"});
});
