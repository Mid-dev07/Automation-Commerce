const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mailWorker = fs.readFileSync(path.join(root, "mail-automation", "worker.js"), "utf8");
const ownerWorker = fs.readFileSync(path.join(root, "site-admin", "worker.js"), "utf8");
const wrangler = fs.readFileSync(path.join(root, "site-admin", "wrangler.jsonc"), "utf8");

function ownerHtml() {
  const start = ownerWorker.indexOf("function page(){");
  const end = ownerWorker.indexOf("export default", start);
  assert.ok(start >= 0 && end > start, "owner page() function must exist");
  return vm.runInNewContext(ownerWorker.slice(start, end) + "\npage();");
}

test("P3 Mail Automation service binding and machine token remain server-side", () => {
  assert.match(wrangler, /"binding"\s*:\s*"MAIL_BACKEND"/);
  assert.match(wrangler, /"service"\s*:\s*"seiton-mail-automation"/);
  assert.ok(ownerWorker.includes("env.MAIL_VM_API_TOKEN"));
  assert.ok(ownerWorker.includes('Authorization:"Bearer "+env.MAIL_VM_API_TOKEN'));
  const html = ownerHtml();
  assert.equal(html.includes("MAIL_VM_API_TOKEN"), false);
  assert.equal(html.includes("Authorization:Bearer"), false);
});

test("Machine API authentication hashes the configured token and scopes requests by its hash", () => {
  const authStart = mailWorker.indexOf("async function authenticateMachine(");
  const authEnd = mailWorker.indexOf("async function handleMachineAliasCreate(", authStart);
  const auth = mailWorker.slice(authStart, authEnd);
  assert.ok(auth.includes("constantTimeEqual(supplied, env.MAIL_VM_API_TOKEN)"));
  assert.ok(auth.includes("sha256Hex(env.MAIL_VM_API_TOKEN)"));
  assert.ok(auth.includes("return { tokenHash }"));
});

test("Machine alias listing is token-hash scoped, bounded, and returns metadata only", () => {
  const start = mailWorker.indexOf("async function handleMachineAliasesGet(");
  const end = mailWorker.indexOf("async function handleMachineMessagesGet(", start);
  const handler = mailWorker.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes("WHERE token_hash=?"));
  assert.ok(handler.includes("WHERE m.token_hash=?"));
  assert.ok(handler.includes("LIMIT ? OFFSET ?"));
  assert.ok(handler.includes("Math.min(50"));
  assert.ok(handler.includes("has_more"));
  for (const forbidden of ["verification_code", "body_text", "payload_ciphertext", "payload_iv"]) {
    assert.equal(handler.includes(forbidden), false, "alias listing must not expose "+forbidden);
  }
  assert.ok(mailWorker.includes('url.pathname === "/api/v1/machine/aliases"'));
  assert.ok(mailWorker.includes("handleMachineAliasesGet(url, env, auth.tokenHash)"));
});

test("Machine alias lookup and hourly quota use token hash; global clientRef uniqueness is a known schema limitation", () => {
  assert.ok(mailWorker.includes('"WHERE m.client_ref=? AND m.token_hash=? LIMIT 1"'));
  assert.ok(mailWorker.includes(".bind(clientRef, tokenHash).first()"));
  assert.ok(mailWorker.includes('"SELECT COUNT(*) AS total FROM mail_machine_aliases WHERE token_hash=? AND created_at>?"'));
  assert.ok(mailWorker.includes(".bind(tokenHash, now - 60 * 60 * 1000).first()"));
});

test("Message list and detail require alias ownership before exposing decrypted message data", () => {
  const listStart = mailWorker.indexOf("async function handleMachineMessagesGet(");
  const detailStart = mailWorker.indexOf("async function handleMachineMessageGet(", listStart);
  const revokeStart = mailWorker.indexOf("async function handleMachineAliasRevoke(", detailStart);
  const list = mailWorker.slice(listStart, detailStart);
  const detail = mailWorker.slice(detailStart, revokeStart);
  assert.ok(list.includes("JOIN mail_machine_aliases m ON m.alias_id=a.id"));
  assert.ok(list.includes("m.token_hash=?"));
  assert.ok(detail.includes("JOIN mail_machine_aliases m ON m.alias_id=a.id"));
  assert.ok(detail.includes("m.token_hash=?"));
  assert.ok(detail.includes("decryptMessagePayload(env, aliasId"));
});

test("Owner Mail endpoints require owner session; mutations also enforce same-origin", () => {
  for (const route of [
    'if(u.pathname==="/api/control/email/health"&&req.method==="GET"){',
    'if(u.pathname==="/api/control/email/aliases"&&req.method==="GET"){',
    'if(u.pathname==="/api/control/email/aliases"&&req.method==="POST"){',
    'if(u.pathname==="/api/control/email/messages"&&req.method==="GET"){',
    'if(mailMessageMatch&&req.method==="GET"){',
    'if(mailAliasDeleteMatch&&req.method==="DELETE"){'
  ]) assert.ok(ownerWorker.includes(route), "missing route "+route);
  assert.equal((ownerWorker.match(/if\(u\.pathname===\"\/api\/control\/email\/health\"&&req\.method===\"GET\"\)\{/g)||[]).length,1);
  assert.equal((ownerWorker.match(/if\(u\.pathname===\"\/api\/control\/email\/aliases\"&&req\.method===\"GET\"\)\{/g)||[]).length,1);
  const createStart=ownerWorker.indexOf('if(u.pathname==="/api/control/email/aliases"&&req.method==="POST"){');
  const createEnd=ownerWorker.indexOf('if(u.pathname==="/api/control/email/messages"&&req.method==="GET"){',createStart);
  const revokeStart=ownerWorker.indexOf('if(mailAliasDeleteMatch&&req.method==="DELETE"){');
  const revokeEnd=ownerWorker.indexOf('if(u.pathname==="/api/admin/bot/diagnostics"',revokeStart);
  assert.ok(ownerWorker.slice(createStart,createEnd).includes("sameOriginAdmin(req)"));
  assert.ok(ownerWorker.slice(revokeStart,revokeEnd).includes("sameOriginAdmin(req)"));
});

test("Mail health keeps inbound Email Routing explicitly unverified", () => {
  const routeStart=ownerWorker.indexOf('if(u.pathname==="/api/control/email/health"&&req.method==="GET"){');
  const routeEnd=ownerWorker.indexOf('if(u.pathname==="/api/control/email/aliases"&&req.method==="GET"){',routeStart);
  const route=ownerWorker.slice(routeStart,routeEnd);
  assert.ok(route.includes('inbound_email_routing:"unverified"'));
  assert.ok(route.includes("data.database_ready===true"));
  assert.ok(ownerWorker.includes("Email Routing: belum diverifikasi"));
});

test("Mail panel only loads message bodies and OTP after an explicit message selection", () => {
  const html=ownerHtml();
  const scriptStart=html.indexOf("<script>");
  const scriptEnd=html.indexOf("</script>",scriptStart);
  const script=html.slice(scriptStart+8,scriptEnd);
  assert.ok(script.includes("function loadMailMessageDetail(aliasId,messageId)"));
  assert.ok(script.includes("loadMailMessageDetail(selectedMailAliasId,item.id)"));
  assert.ok(script.includes("mailMessageDetail"));
  assert.ok(script.includes("verification_code"));
});

test("New aliases use seiton.my.id while legacy inbox aliases remain accepted during cutover", () => {
  assert.ok(mailWorker.includes('const MAIL_DOMAIN = "seiton.my.id";'));
  assert.ok(mailWorker.includes('const LEGACY_MAIL_DOMAIN = "inbox.seiton.biz.id";'));
  assert.ok(mailWorker.includes('const recipientDomain = normalized.slice(at + 1);'));
  assert.ok(mailWorker.includes('recipientDomain !== MAIL_DOMAIN && recipientDomain !== LEGACY_MAIL_DOMAIN'));
  assert.ok(mailWorker.includes('return "receiver+" + alias.slug + "@seiton.my.id";'));
  assert.equal(mailWorker.includes('const PANEL_ORIGIN = "https://mail.seiton.biz.id";'), true);
});
