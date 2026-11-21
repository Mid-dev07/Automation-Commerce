const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const ownerWorker = ["auth.mjs", "pricing.mjs", "otp-proxy.mjs", "owner-page.mjs", "order-proxy.mjs", "worker.js"].map((file) => fs.readFileSync(path.join(root, "site-admin", file), "utf8")).join("\n");
const orderWorker = ["worker.js", "src/order-bot/reports.mjs"]
  .map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");

function ownerHtml() {
  const pageSource = fs.readFileSync(path.join(root, "site-admin", "owner-page.mjs"), "utf8");
  const start = pageSource.indexOf("function page(){");
  const end = pageSource.indexOf("export { page }", start);
  assert.ok(start >= 0 && end > start, "owner page() function must exist");
  return vm.runInNewContext(pageSource.slice(start, end) + "\npage();");
}
function ownerInlineScript() {
  const html = ownerHtml();
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "owner inline script must exist");
  return { html, script: html.slice(start + 8, end), end };
}

test("P1 interactive handlers execute inside the owner app script and before initial session check", () => {
  const { html, script, end } = ownerInlineScript();
  for (const handler of ["function loadControlData()", "function controlPaymentAction(", "function changeControlOrderStatus(", "function renderControlPayments("]) {
    assert.ok(script.includes(handler), "inline script missing "+handler);
    assert.ok(html.indexOf(handler) < end, handler+" must be inside the script element");
  }
  assert.ok(script.indexOf("function controlMoney(") < script.indexOf("check();})();"));
  assert.equal(html.indexOf("function controlMoney(") > end, false);
});

test("P2 reports module, date filters, four export options, and audit filters are part of the rendered owner UI", () => {
  const { html, script } = ownerInlineScript();
  for (const item of [
    "data-view-panel='reports'",
    "data-view-target='reports'",
    "id='reportFrom'",
    "id='reportTo'",
    "id='reportSummary'",
    "id='reportDailyTrend'",
    "id='reportTopProducts'",
    "id='reportPaymentMethods'",
    "id='reportOrderStatuses'",
    "data-report-export='orders'",
    "data-report-export='finance'",
    "data-report-export='daily'",
    "data-report-export='inventory'",
    "id='auditSearch'",
    "id='auditSource'"
  ]) assert.ok(html.includes(item), "missing UI item "+item);
  assert.ok(script.includes("function renderReports()"));
  assert.ok(script.includes("function filterAuditRows()"));
  assert.ok(script.includes("timeZone:'Asia/Jakarta'"));
  assert.ok(html.includes("GA4 Data API belum diintegrasikan"));
});

test("P2 analytics count only paid order statuses as confirmed revenue", () => {
  const { script } = ownerInlineScript();
  assert.ok(script.includes("const reportPaidStatuses=new Set(['DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED'])"));
  assert.ok(script.includes("const reportCancelledStatuses=new Set(['DIBATALKAN','CANCELLED','CANCELED'])"));
  assert.ok(script.includes("const revenue=paid.reduce"));
  assert.ok(script.includes("outstanding=pending.reduce"));
  assert.ok(script.includes("const rejected=rows.filter"));
  assert.ok(script.includes("average=paid.length?Math.round(revenue/paid.length):0"));
});

test("P2 owner export facade requires an owner session, a bounded type/date allowlist, and a successful audit write", () => {
  const route = ownerWorker.slice(
    ownerWorker.indexOf('if(u.pathname==="/api/control/export"&&req.method==="GET"){'),
    ownerWorker.indexOf('if(u.pathname==="/api/admin/audit"&&req.method==="GET"){')
  );
  assert.ok(route.includes("activeSession(req,env)"));
  assert.ok(route.includes('["orders","finance","daily","inventory"].includes(type)'));
  assert.ok(route.includes("/^\\d{4}-\\d{2}-\\d{2}$/.test(value)"));
  assert.ok(route.includes("from&&to&&from>to"));
  assert.ok(route.includes("newAuditStatement(env,{action:\"REPORT_EXPORT_SENT\""));
  assert.ok(route.includes("}).run()"));
});

test("P2 owner export streams CSV without exposing the upstream endpoint or caching the file", () => {
  const route = ownerWorker.slice(
    ownerWorker.indexOf('if(u.pathname==="/api/control/export"&&req.method==="GET"){'),
    ownerWorker.indexOf('if(u.pathname==="/api/admin/audit"&&req.method==="GET"){')
  );
  assert.ok(route.includes('fetchOrderAdmin(env,session.token,"/api/admin/export?"+query.toString())'));
  assert.ok(route.includes("new Response(upstream.body"));
  assert.ok(route.includes('"Cache-Control":"private, no-store"'));
  assert.ok(route.includes('"X-Content-Type-Options":"nosniff"'));
  assert.ok(route.includes('"Content-Disposition"'));
});

test("P2 order Worker validates and applies inclusive Asia/Jakarta date ranges to transaction exports", () => {
  assert.ok(orderWorker.includes("function isValidReportDate(value)"));
  assert.ok(orderWorker.includes("async function buildReportExports(env, range = {})"));
  assert.ok(orderWorker.includes("const day = localDateKey(order.created_at)"));
  assert.ok(orderWorker.includes("(!from || day >= from) && (!to || day <= to)"));
  assert.ok(orderWorker.includes("if (!isValidReportDate(from) || !isValidReportDate(to) || (from && to && from > to))"));
  assert.ok(orderWorker.includes('url.searchParams.get("from")'));
  assert.ok(orderWorker.includes('url.searchParams.get("to")'));
});

test("P2 inventory export remains a current catalogue snapshot, not a time-series claim", () => {
  const { html } = ownerInlineScript();
  assert.ok(html.includes("inventaris adalah snapshot katalog saat ini"));
  assert.ok(orderWorker.includes("...products.map(p => [p.sku,p.name,p.price,p.stock"));
});

test("P2 audit search filters the already-merged local and operational activity metadata", () => {
  assert.ok(ownerWorker.includes('const items=localItems.concat(operationalItems)'));
  assert.ok(ownerWorker.includes('data-audit-source='));
  const { script } = ownerInlineScript();
  assert.ok(script.includes("document.querySelectorAll('#auditList .audit-item')"));
  assert.ok(script.includes("filterAuditRows();"));
});

test("P2 report exports never include secrets, email contents, OTP values, or payment proof bytes in the audit summary", () => {
  const route = ownerWorker.slice(
    ownerWorker.indexOf('if(u.pathname==="/api/control/export"&&req.method==="GET"){'),
    ownerWorker.indexOf('if(u.pathname==="/api/admin/audit"&&req.method==="GET"){')
  );
  assert.ok(route.includes("summary:{type,from:from||null,to:to||null}"));
  assert.equal(route.includes("payment_proof"), false);
  assert.equal(route.includes("mailbox"), false);
  assert.equal(route.includes("otp"), false);
});
