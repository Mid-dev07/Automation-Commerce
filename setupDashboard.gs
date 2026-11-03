/**
 * ============================================================================
 * SEITON.ID - EXECUTIVE SALES DASHBOARD GENERATOR
 * Google Apps Script | Google Sheets Analytics
 * Official Web : https://seiton.biz.id
 * Copyright (c) 2026 Seiton.id. All rights reserved.
 * ============================================================================
 *
 * LICENSE NOTICE
 * Proprietary Seiton.id source. All rights reserved. Do not redistribute,
 * resell, sublicense, or remove this attribution without written permission.
 *
 * Jalankan setupDashboard() satu kali dari Apps Script yang terikat ke
 * spreadsheet transaksi. Struktur sumber: Pesanan!A:M dan Katalog_Produk!A:E.
 */

const SEITON_THEME = {
  slate: "#0F172A",
  slate2: "#1E293B",
  emerald: "#10B981",
  emeraldDark: "#047857",
  mint: "#D1FAE5",
  canvas: "#F1F5F9",
  white: "#FFFFFF",
  muted: "#64748B",
  line: "#CBD5E1",
  amber: "#F59E0B",
  red: "#EF4444"
};

function setupDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSourceSheets_(ss);
  const dashboard = getOrCreateSheet_(ss, "Dashboard");
  dashboard.getRange("A1:L37").breakApart();
  dashboard.clear();
  dashboard.clearConditionalFormatRules();
  dashboard.setHiddenGridlines(true);
  dashboard.setTabColor(SEITON_THEME.emerald);
  dashboard.setFrozenRows(4);
  dashboard.setColumnWidths(1, 12, 110);
  dashboard.setRowHeights(1, 1, 38);
  dashboard.setRowHeights(2, 1, 28);
  dashboard.setRowHeights(4, 1, 24);
  dashboard.getRange("A1:L37").setBackground(SEITON_THEME.canvas)
    .setFontFamily("Arial").setFontColor(SEITON_THEME.slate);

  dashboard.getRange("A1:L1").merge().setValue("SEITON.ID  /  EXECUTIVE SALES INTELLIGENCE")
    .setBackground(SEITON_THEME.slate).setFontColor(SEITON_THEME.white)
    .setFontSize(16).setFontWeight("bold").setVerticalAlignment("middle");
  dashboard.getRange("A2:L2").merge()
    .setFormula('="LIVE BUSINESS OVERVIEW  •  Last refreshed: "&TEXT(NOW(),"dd mmm yyyy, hh:mm")')
    .setBackground(SEITON_THEME.slate2).setFontColor("#CBD5E1")
    .setFontSize(9).setVerticalAlignment("middle");
  dashboard.getRange("A4:L4").merge().setValue("EXECUTIVE SNAPSHOT")
    .setFontColor(SEITON_THEME.emeraldDark).setFontWeight("bold").setFontSize(10);

  createKpiCard_(dashboard, "A5:C5", "A6:C8", "TOTAL OMSET", '=IFERROR(SUMIFS(Pesanan!K:K,Pesanan!M:M,"DIBAYAR")+SUMIFS(Pesanan!K:K,Pesanan!M:M,"SELESAI")+SUMIFS(Pesanan!K:K,Pesanan!M:M,"PAID")+SUMIFS(Pesanan!K:K,Pesanan!M:M,"COMPLETED"),0)', '"Rp" #,##0');
  createKpiCard_(dashboard, "D5:F5", "D6:F8", "JUMLAH PESANAN", '=COUNTIF(Pesanan!A2:A,"<>")', '#,##0');
  createKpiCard_(dashboard, "G5:I5", "G6:I8", "AVERAGE PAID ORDER VALUE", '=IFERROR((SUMIFS(Pesanan!K2:K,Pesanan!M2:M,"DIBAYAR")+SUMIFS(Pesanan!K2:K,Pesanan!M2:M,"SELESAI")+SUMIFS(Pesanan!K2:K,Pesanan!M2:M,"PAID")+SUMIFS(Pesanan!K2:K,Pesanan!M2:M,"COMPLETED"))/(COUNTIF(Pesanan!M2:M,"DIBAYAR")+COUNTIF(Pesanan!M2:M,"SELESAI")+COUNTIF(Pesanan!M2:M,"PAID")+COUNTIF(Pesanan!M2:M,"COMPLETED")),0)', '"Rp" #,##0');
  createKpiCard_(dashboard, "J5:L5", "J6:L8", "OMSET HARI INI", '=SUMIFS(Pesanan!K$2:K,Pesanan!B$2:B,TEXT(TODAY(),"yyyy-mm-dd")&"*",Pesanan!M$2:M,"DIBAYAR")+SUMIFS(Pesanan!K$2:K,Pesanan!B$2:B,TEXT(TODAY(),"yyyy-mm-dd")&"*",Pesanan!M$2:M,"SELESAI")+SUMIFS(Pesanan!K$2:K,Pesanan!B$2:B,TEXT(TODAY(),"yyyy-mm-dd")&"*",Pesanan!M$2:M,"PAID")+SUMIFS(Pesanan!K$2:K,Pesanan!B$2:B,TEXT(TODAY(),"yyyy-mm-dd")&"*",Pesanan!M$2:M,"COMPLETED")', '"Rp" #,##0');

  dashboard.getRange("A10:F10").merge().setValue("REVENUE MOMENTUM  /  14 HARI")
    .setBackground(SEITON_THEME.slate2).setFontColor(SEITON_THEME.white).setFontWeight("bold");
  dashboard.getRange("A11:B11").setValues([["Tanggal", "Omset"]]);
  dashboard.getRange("A12").setFormula('=SEQUENCE(14,1,TODAY()-13,1)');
  const dailyFormulas = Array.from({length: 14}, (_, i) => {
    const row = 12 + i;
    const criteria = `Pesanan!B$2:B,TEXT(A${row},"yyyy-mm-dd")&"*",Pesanan!M$2:M,`;
    return [`=IFERROR(SUMIFS(Pesanan!K$2:K,${criteria}"DIBAYAR")+SUMIFS(Pesanan!K$2:K,${criteria}"SELESAI")+SUMIFS(Pesanan!K$2:K,${criteria}"PAID")+SUMIFS(Pesanan!K$2:K,${criteria}"COMPLETED"),0)`];
  });
  dashboard.getRange("B12:B25").setFormulas(dailyFormulas);
  dashboard.getRange("C11:F11").merge().setValue("TREND LINE");
  dashboard.getRange("C12:F15").merge()
    .setFormula('=SPARKLINE(B12:B25,{"charttype","line";"linewidth",2;"color","' + SEITON_THEME.emerald + '";"empty","zero"})')
    .setBackground(SEITON_THEME.white).setVerticalAlignment("middle");
  dashboard.getRange("A12:A25").setNumberFormat("dd mmm");
  dashboard.getRange("B12:B25").setNumberFormat('"Rp" #,##0');
  dashboard.getRange("A11:F11").setBackground("#E2E8F0").setFontWeight("bold").setFontColor(SEITON_THEME.slate);
  dashboard.getRange("A12:B25").setBackground(SEITON_THEME.white);

  dashboard.getRange("G10:L10").merge().setValue("PAYMENT MIX")
    .setBackground(SEITON_THEME.slate2).setFontColor(SEITON_THEME.white).setFontWeight("bold");
  dashboard.getRange("G11:H11").setValues([["Metode", "Omset"]]);
  dashboard.getRange("G12").setFormula('=IFERROR(QUERY({Pesanan!L2:L,Pesanan!K2:K,Pesanan!M2:M},"select Col1,sum(Col2) where Col1 is not null and (Col3 = \'DIBAYAR\' or Col3 = \'SELESAI\' or Col3 = \'PAID\' or Col3 = \'COMPLETED\') group by Col1 label sum(Col2) \'\'",0),{"Belum ada data",0})');
  dashboard.getRange("G11:H11").setBackground("#E2E8F0").setFontWeight("bold");
  dashboard.getRange("H12:H20").setNumberFormat('"Rp" #,##0');
  dashboard.getRange("G12:H20").setBackground(SEITON_THEME.white);

  dashboard.getRange("A27:F27").merge().setValue("TOP 5 PRODUK TERLARIS")
    .setBackground(SEITON_THEME.slate2).setFontColor(SEITON_THEME.white).setFontWeight("bold");
  dashboard.getRange("A28:B28").setValues([["Produk", "Unit Terjual"]])
    .setBackground("#E2E8F0").setFontWeight("bold");
  dashboard.getRange("A29").setFormula('=IFERROR(QUERY({Pesanan!F2:F,Pesanan!G2:G,Pesanan!M2:M},"select Col1,sum(Col2) where Col1 is not null and (Col3 = \'DIBAYAR\' or Col3 = \'SELESAI\' or Col3 = \'PAID\' or Col3 = \'COMPLETED\') group by Col1 order by sum(Col2) desc limit 5 label sum(Col2) \'\'",0),{"Belum ada data",0})');
  dashboard.getRange("A29:B34").setBackground(SEITON_THEME.white);

  dashboard.getRange("G27:L27").merge().setValue("TRANSACTION STATUS")
    .setBackground(SEITON_THEME.slate2).setFontColor(SEITON_THEME.white).setFontWeight("bold");
  dashboard.getRange("G28:H28").setValues([["Status", "Jumlah"]])
    .setBackground("#E2E8F0").setFontWeight("bold");
  dashboard.getRange("G29").setFormula('=IFERROR(QUERY(Pesanan!M2:M,"select Col1,count(Col1) where Col1 is not null group by Col1 label count(Col1) \'\'",0),{"Belum ada data",0})');
  dashboard.getRange("G29:H35").setBackground(SEITON_THEME.white);

  dashboard.getRange("A37:L37").merge().setValue("Powered by Seiton.id  •  https://seiton.biz.id")
    .setBackground(SEITON_THEME.slate).setFontColor(SEITON_THEME.white)
    .setFontSize(9).setHorizontalAlignment("center").setVerticalAlignment("middle");
  dashboard.setRowHeight(37, 28);
  dashboard.getRange("A1:L37").setVerticalAlignment("middle");
  dashboard.getRange("A5:L8").setBorder(true, true, true, true, true, true, SEITON_THEME.line, SpreadsheetApp.BorderStyle.SOLID);
  dashboard.getRange("A10:L25").setBorder(true, true, true, true, true, true, SEITON_THEME.line, SpreadsheetApp.BorderStyle.SOLID);
  dashboard.getRange("A27:L35").setBorder(true, true, true, true, true, true, SEITON_THEME.line, SpreadsheetApp.BorderStyle.SOLID);
  dashboard.setColumnWidth(1, 180);
  dashboard.setColumnWidth(2, 115);
  dashboard.setColumnWidths(3, 10, 105);
  applyDashboardRules_(dashboard);
  dashboard.getRange("A1:L35").setWrap(true);
  ss.setActiveSheet(dashboard);
  ss.toast("Executive Dashboard Seiton.id berhasil dibuat.", "Seiton.id", 5);
}

function createKpiCard_(sheet, titleRange, valueRange, title, formula, numberFormat) {
  sheet.getRange(titleRange).merge().setValue(title)
    .setBackground(SEITON_THEME.slate2).setFontColor("#CBD5E1")
    .setFontSize(9).setFontWeight("bold").setHorizontalAlignment("center");
  sheet.getRange(valueRange).merge().setFormula(formula)
    .setBackground(SEITON_THEME.white).setFontColor(SEITON_THEME.emeraldDark)
    .setFontSize(18).setFontWeight("bold").setHorizontalAlignment("center")
    .setNumberFormat(numberFormat);
}

function applyDashboardRules_(sheet) {
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0)
      .setFontColor(SEITON_THEME.emeraldDark).setRanges([sheet.getRange("B12:B25"), sheet.getRange("H12:H20")]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains("MENUNGGU")
      .setBackground("#FEF3C7").setFontColor("#92400E").setRanges([sheet.getRange("G29:G35")]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains("SELESAI")
      .setBackground(SEITON_THEME.mint).setFontColor(SEITON_THEME.emeraldDark).setRanges([sheet.getRange("G29:G35")]).build()
  ];
  sheet.setConditionalFormatRules(rules);
}

function ensureSourceSheets_(ss) {
  const orderHeaders = [
    "order_id", "created_at", "channel", "customer_id", "customer_name",
    "product", "quantity", "unit_price", "subtotal", "shipping", "total",
    "payment_method", "status"
  ];
  const catalogHeaders = ["sku", "nama_produk", "harga", "stok", "aktif"];

  let orders = ss.getSheetByName("Pesanan");
  if (!orders) orders = ss.insertSheet("Pesanan");
  if (orders.getLastRow() === 0) {
    orders.getRange(1, 1, 1, orderHeaders.length).setValues([orderHeaders]);
    orders.setFrozenRows(1);
    orders.getRange("A1:M1").setBackground(SEITON_THEME.slate)
      .setFontColor(SEITON_THEME.white).setFontWeight("bold");
  } else {
    const headers = orders.getRange(1, 1, 1, orderHeaders.length).getDisplayValues()[0];
    if (orderHeaders.some((name, i) => headers[i] !== name)) {
      throw new Error("Header Pesanan!A:M tidak sesuai. Dashboard dibatalkan agar data tidak salah dihitung.");
    }
  }

  let catalog = ss.getSheetByName("Katalog_Produk");
  if (!catalog) catalog = ss.insertSheet("Katalog_Produk");
  if (catalog.getLastRow() === 0) {
    catalog.getRange(1, 1, 1, catalogHeaders.length).setValues([catalogHeaders]);
    catalog.getRange("A1:E1").setBackground(SEITON_THEME.slate)
      .setFontColor(SEITON_THEME.white).setFontWeight("bold");
    catalog.setFrozenRows(1);
  } else {
    const headers = catalog.getRange(1, 1, 1, catalogHeaders.length).getDisplayValues()[0];
    if (catalogHeaders.some((name, i) => headers[i] !== name)) {
      throw new Error("Header Katalog_Produk!A:E tidak sesuai. Dashboard dibatalkan agar data katalog tidak salah dibaca.");
    }
  }
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/**
 * Optional scheduled refresh. Formula results recalculate automatically;
 * this function updates the visible timestamp when run by a time trigger.
 */
function refreshDashboardTimestamp() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Dashboard");
  if (sheet) sheet.getRange("A2").setFormula('="LIVE BUSINESS OVERVIEW  •  Last refreshed: "&TEXT(NOW(),"dd mmm yyyy, hh:mm")');
}

/**
 * Run once if desired to install a 15-minute refresh trigger.
 */
function installDashboardRefreshTrigger() {
  const handler = "refreshDashboardTimestamp";
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(15).create();
}