const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const worker = ["auth.mjs", "pricing.mjs", "otp-proxy.mjs", "owner-page.mjs", "order-proxy.mjs", "worker.js"].map((file) => fs.readFileSync(path.join(root, "site-admin", file), "utf8")).join("\n");



test("owner Control Center P1 exposes only the intended authenticated order and payment facade", () => {
  assert.match(worker, /\/api\/control\/data/);
  assert.match(worker, /\/api\/control\/payment-methods/);
  assert.match(worker, /\/api\/control\/payment/);
  assert.match(worker, /\/api\/control\/order-status/);
  assert.match(worker, /\/api\/control\/proof/);
  assert.ok(worker.includes("async function fetchOrderAdmin(env,token,path,method=\"GET\",body)"));
  assert.ok(worker.includes("async function proxyOrderJson(env,token,path,method=\"GET\",body)"));
  assert.ok(worker.includes("https://internal\"+path"));
});

test("P1 order and payment reads require a valid owner session", () => {
  for (const route of [
    'if(u.pathname==="/api/control/data"&&req.method==="GET")',
    'if(u.pathname==="/api/control/payment-methods"&&req.method==="GET")',
    'if(u.pathname==="/api/control/proof"&&req.method==="GET")'
  ]) {
    const i=worker.indexOf(route);
    assert.ok(i>=0, "missing route "+route);
    const section=worker.slice(i,i+900);
    assert.ok(section.includes("activeSession(req,env)"), "missing owner-session check in "+route);
  }
});

test("P1 mutations enforce same-origin, owner session, bounded JSON, and explicit action allowlists", () => {
  for (const route of [
    'if(u.pathname==="/api/control/payment-methods"&&req.method==="POST")',
    'if(u.pathname==="/api/control/payment"&&req.method==="POST")',
    'if(u.pathname==="/api/control/order-status"&&req.method==="POST")'
  ]) {
    const i=worker.indexOf(route);
    assert.ok(i>=0, "missing route "+route);
    const section=worker.slice(i,i+2600);
    assert.ok(section.includes("sameOriginAdmin(req)"), "missing origin check in "+route);
    assert.ok(section.includes("activeSession(req,env)"), "missing owner-session check in "+route);
    assert.ok(section.includes("parseControlJson(req"), "missing bounded JSON parser in "+route);
  }
  assert.ok(worker.includes('["approve","reject"].includes(action)'));
  assert.ok(worker.includes('["MENUNGGU_PEMBAYARAN","MENUNGGU_VERIFIKASI","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"]'));
  assert.ok(worker.includes('["QRIS","TRANSFER","COD"].includes(method)'));
  assert.ok(worker.includes('action==="save_bank"'));
  assert.ok(worker.includes('action==="toggle_bank"'));
});

test("P1 forwards payment proof as a private no-store stream and constrains content types", () => {
  const i=worker.indexOf('if(u.pathname==="/api/control/proof"&&req.method==="GET")');
  assert.ok(i>=0);
  const section=worker.slice(i,i+2600);
  assert.ok(section.includes("upstream.body"));
  assert.ok(section.includes('"Cache-Control":"private, no-store"'));
  assert.ok(section.includes('"X-Content-Type-Options":"nosniff"'));
  assert.ok(section.includes('["image/jpeg","image/png","image/webp","application/pdf","application/octet-stream"].includes(contentType)'));
});

test("P1 owner UI contains order, payment verification, and payment-method modules", () => {
  for (const value of [
    "data-view-panel='orders'",
    "data-view-panel='payments'",
    "data-view-panel='payment-methods'",
    "id='controlOrdersList'",
    "id='controlPaymentQueue'",
    "id='controlMethodCards'",
    "id='controlBankAccounts'"
  ]) assert.ok(worker.includes(value), "missing UI element "+value);
  assert.ok(worker.includes("Pastikan dana benar-benar masuk ke akun merchant"));
  assert.ok(worker.includes("OCR hanya membantu membaca bukti"));
});

test("P1 payment actions preserve the backend idempotency result in the owner UI", () => {
  assert.ok(worker.includes("result.already_approved||result.status==='ALREADY_APPROVED'"));
  assert.ok(worker.includes("Tidak ada persetujuan atau resi kedua"));
  assert.ok(worker.includes("isQrisMismatch(order)"));
  assert.ok(worker.includes("Persetujuan QRIS ditahan"));
});
