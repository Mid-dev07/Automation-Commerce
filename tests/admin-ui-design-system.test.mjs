import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  renderAdminCatalogItemScreen,
  renderAdminDashboardLinkScreen,
  renderAdminDeleteConfirmScreen,
  renderAdminExportsScreen,
  renderAdminHomeScreen,
  renderAdminOrderDetailScreen,
  renderAdminPaymentDetailScreen,
  renderAdminPaymentQueueScreen,
  renderAdminPickupDetailScreen,
  renderAdminPickupQueueScreen,
  renderAdminRecentOrdersScreen,
  renderAdminSalesReportHtml,
  renderAdminSubmenuScreen
} from "../src/order-bot/ui/admin-screens.mjs";
import { renderPanel } from "../mail-automation/owner-ui.mjs";
import { renderPublicPage } from "../mail-automation/public-page.mjs";

function collectCallbackButtons(replyMarkup) {
  return (replyMarkup?.inline_keyboard || []).flat().filter((b) => typeof b?.callback_data === "string");
}

test("Telegram admin UI screens escape dynamic values, respect 64B callback limit, and enforce QRIS mismatch guard", () => {
  const screens = [
    renderAdminHomeScreen(),
    renderAdminSubmenuScreen("orders"),
    renderAdminSubmenuScreen("products"),
    renderAdminSubmenuScreen("reports"),
    renderAdminSubmenuScreen("support"),
    renderAdminRecentOrdersScreen([], "recent"),
    renderAdminRecentOrdersScreen([
      { reference: "ORD-1", r: ["ORD-20261122-001", "", "", "123", "<Admin>", "Produk <A>", 2, 0, 0, 0, 150000, "QRIS", "DIBAYAR"] }
    ], "recent"),
    renderAdminOrderDetailScreen(["ORD-1", "", "", "123", "<Budi>", "Paket <Pro>", 1, 0, 0, 0, 99000, "QRIS", "MENUNGGU_VERIFIKASI"], "ORD-1"),
    renderAdminPaymentQueueScreen({ subset: [], current: 0, pages: 1, total: 0 }),
    renderAdminPaymentQueueScreen({
      subset: [{ reference: "ORD-2", r: ["ORD-2", "", "", "123", "<Siti>", "Item", 1, 0, 0, 0, 50000, "QRIS", "MENUNGGU_VERIFIKASI", "MENUNGGU_VERIFIKASI", "file_123", "PHOTO"] }],
      current: 0, pages: 1, total: 1
    }),
    renderAdminPickupQueueScreen({ subset: [], current: 0, pages: 1, total: 0 }),
    renderAdminPickupDetailScreen({
      row: ["ORD-3", "", "", "123", "<Tono>", "Item", 1, 0, 0, 0, 50000, "QRIS", "DIBAYAR", "DISETUJUI", "", "", "", "", "RCP-1234", ""],
      reference: "ORD-3",
      ticketUrl: "https://automate-bot.seiton.biz.id/pickup?ticket=abc",
      picked: false
    }),
    renderAdminCatalogItemScreen({ row: ["SEI-001", "Produk <Test>", 75000, 10, "TRUE", "", "Deskripsi <aman>"], current: 0, total: 2 }),
    renderAdminDeleteConfirmScreen("SEI-001"),
    renderAdminDashboardLinkScreen("https://admin.seiton.biz.id/#access=tok"),
    renderAdminExportsScreen()
  ];

  for (const screen of screens) {
    assert.equal(screen.parseMode, "HTML");
    assert.ok(!screen.text.includes("undefined") && !screen.text.includes("NaN"), "Found undefined/NaN in admin screen");
    assert.ok(!/<(Admin|Budi|Siti|Tono|Test|Pro|A|aman)>/.test(screen.text), "Unescaped dynamic HTML tag found");
    for (const btn of collectCallbackButtons(screen.replyMarkup)) {
      assert.ok(Buffer.byteLength(btn.callback_data, "utf8") < 64, "Callback exceeds 64B: " + btn.callback_data);
    }
  }

  // QRIS mismatch MUST hide approval button and display mismatch warning
  const mismatch = renderAdminPaymentDetailScreen({
    row: ["ORD-9", "", "", "123", "Pembeli", "Produk", 1, 0, 0, 0, 50000, "QRIS", "MENUNGGU_VERIFIKASI", "MENUNGGU_VERIFIKASI", "f1", "PHOTO"],
    reference: "ORD-9",
    qrisPayment: { expected_amount: 50123, unique_code: 123, ocr_status: "MISMATCH", ocr_amount: 40000 },
    qrisMismatch: true
  });
  const mismatchCbs = collectCallbackButtons(mismatch.replyMarkup).map((b) => b.callback_data);
  assert.ok(!mismatchCbs.some((c) => c.startsWith("payapprove:")), "Mismatch must suppress payapprove button");
  assert.ok(mismatchCbs.includes("payreject:ORD-9"));
  assert.match(mismatch.text, /BUKTI \/ NOMINAL.*TIDAK COCOK/);

  // Sales report HTML renders clean table without raw Markdown asterisks
  const report = renderAdminSalesReportHtml({
    dateLabel: "Minggu, 22 November 2026",
    revenue: 450000,
    paidCount: 3,
    todayRevenue: 150000,
    todayCount: 1,
    bestProduct: ["Produk <Unggulan>", 2],
    paymentTotals: { QRIS: 300000, TRANSFER: 150000 },
    target: 300000
  });
  assert.match(report, /<b>REKAP PENJUALAN SEITON\.ID<\/b>/);
  assert.match(report, /<blockquote>/);
  assert.doesNotMatch(report, /<pre>/);
  assert.ok(!report.includes("<Unggulan>"));
  assert.ok(!report.includes("*Total Omset:*"));
});

test("all Seiton web admin and portal UIs enforce unified Swiss Operations design tokens and WCAG/CSP guardrails", async () => {
  const root = new URL("../", import.meta.url);

  // 1. Owner Control Center
  const ownerSrc = readFileSync(new URL("site-admin/owner-page.mjs", root), "utf8");
  const ownerHtml = vm.runInNewContext(ownerSrc.slice(ownerSrc.indexOf("function page(){"), ownerSrc.indexOf("export { page }")) + "\npage();");

  // 2. Order Bot Admin Dashboard
  const dashSrc = readFileSync(new URL("src/order-bot/dashboard-html.mjs", root), "utf8");
  const dashLine = dashSrc.split("\n").find((l) => l.startsWith("const ADMIN_DASHBOARD_HTML = "));
  const dashHtml = JSON.parse(dashLine.slice("const ADMIN_DASHBOARD_HTML = ".length, -1));

  // 3. SeitonMail Owner & Public
  const mailOwnerHtml = await renderPanel("deadbeef", true).text();
  const mailPublicHtml = await renderPublicPage("deadbeef").text();

  // 4. OTP Portal
  const otpSrc = readFileSync(new URL("otp-portal/index.js", root), "utf8");
  const otpHtml = otpSrc.slice(otpSrc.indexOf("function html() {"), otpSrc.indexOf("async function ensureLegacyMailbox"));

  // 5. Pickup Verification
  const pickupSrc = readFileSync(new URL("src/order-bot/pickup.mjs", root), "utf8");

  for (const [name, html] of [
    ["site-admin/owner-page.mjs", ownerHtml],
    ["src/order-bot/dashboard-html.mjs", dashHtml],
    ["mail-automation/owner-ui.mjs", mailOwnerHtml],
    ["mail-automation/public-page.mjs", mailPublicHtml],
    ["otp-portal/index.js", otpHtml]
  ]) {
    assert.match(html, /#F7F5EF/i, `${name} must use Seiton Bone background #F7F5EF`);
    assert.match(html, /#1F2937/i, `${name} must use Seiton Ink #1F2937`);
    assert.match(html, /#B94A22/i, `${name} must use accessible Seiton Deep Orange #B94A22 for primary CTA`);
    assert.match(html, /prefers-reduced-motion/, `${name} must honor prefers-reduced-motion`);
    assert.match(html, /:focus-visible/, `${name} must provide visible keyboard focus ring`);
    assert.match(html, /tabular-nums/, `${name} must apply tabular-nums to numeric/code readouts`);
    assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com/, `${name} must not load external font/CSS CDNs`);
  }

  // Ensure web admin sidebars/cards no longer use structural emojis
  assert.doesNotMatch(dashHtml, /👋|💳|📋|💰|📅|📦/);
  assert.doesNotMatch(ownerHtml, /<span class='nav-icon'>[⌂▦▤↗▣▥▧◇✉≋◉]<\/span>/);
  assert.match(ownerHtml, /class='skip-link'/);
  assert.match(dashHtml, /class="skip-link"/);
  assert.match(pickupSrc, /#F7F5EF/);
  assert.match(pickupSrc, /tabular-nums/);
});
