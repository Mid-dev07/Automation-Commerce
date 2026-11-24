import {
  bootstrapTransactions, createOrderTransactional, transactionReadiness,
  findOrderTransactional, findOrderByLegacyRow, listOrdersTransactional,
  listProductsTransactional, findProductTransactional, saveProductTransactional,
  deleteProductTransactional, setLegacyRowTransactional, updateProofTransactional,
  requestVerificationTransactional, approvePaymentTransactional, approvePaymentByMutationTransactional, rejectPaymentTransactional,
  setOrderStatusTransactional, markPickedUpTransactional, listDashboardDataTransactional,
  orderToSheetRow, OrderCoordinator, claimSheetMirrorOutbox,
  completeSheetMirrorOutbox, failSheetMirrorOutbox
} from "../../transaction-layer.js";
import {
  isQrisCheckoutAvailable,
  getQrisCheckoutMode,
  buildDynamicQrisPayload,
  extractQrisMerchantProfile,
  generateQrisUniqueCode,
  parseQrisPayload,
  MAX_QRIS_TRANSACTION_AMOUNT,
  evaluateQrisReceipt
} from "../../qris.mjs";
import {
  listDigitalStockD1,
  markDigitalDeliveredD1,
  getDigitalOrderD1,
  createOtpPortalAccess,
  parseMuseBusinessSetupInput,
  storeMuseBusinessSetupD1,
  getMuseBusinessSetupD1
} from "../../digital-products.mjs";
import { resolveCatalogMirrorAction } from "../../catalog-mirror.js";
import {
  processMessagingEvent,
  claimMessagingOutbox,
  completeMessagingOutbox,
  failMessagingOutbox,
  parseMessagingAdminCommand,
  listMessagingHandoffs,
  claimMessagingHandoff,
  closeMessagingHandoff,
  resolveMessagingHandoff,
  declineMessagingHandoff,
  queueMessagingHandoffReply
} from "../../messaging-core.mjs";
import {
  parseMutationNotification,
  buildMutationDedupeKey,
  verifyMutationDeviceToken,
  sha256Hex
} from "./payment-mutations.mjs";
import {
  validateWebhookTargetUrl,
  buildPaymentWebhookPayload,
  enqueuePaymentWebhookDeliveries,
  dispatchPaymentWebhookDeliveries,
  deliverSingleWebhook
} from "./payment-webhooks.mjs";
import {
  SHEETS_BASE, GOOGLE_TOKEN_URL, TELEGRAM_API, SEITON_LOGO_URL, TZ, HEADERS,
  PAID_ORDER_STATUSES, CANCELLED_ORDER_STATUSES, PAYMENT_WORKFLOW_HEADERS,
  parseCatalogProduct, base64url, base64urlBytes, rupiah, json, constantTimeEqual
} from "./utils.mjs";
import { ADMIN_DASHBOARD_HTML } from "./dashboard-html.mjs";
import {
  customerMenuText, adminMenuText, customerMenuKeyboard, adminMenuKeyboard,
  adminOrdersKeyboard, adminProductsKeyboard, adminReportsKeyboard,
  adminSupportKeyboard, adminCatalogKeyboard, customerCategoryForProduct,
  customerCategoryTitle, customerCatalogProducts, customerProductCanBeOrdered,
  orderConfirmation, helpText
} from "./keyboards.mjs";
import {
  sendTelegramPhoto, sendSeitonWelcome, sendTelegramPhotoBlob, telegramApiRequest,
  deleteTelegramMessage, updateTelegramMessage, answerTelegramCallback,
  sendTelegramDocument, sendTelegramDocumentById, sendTelegram
} from "./telegram-api.mjs";
import {
  ensurePaymentWorkflowHeaders, updateSheetRange, findOrderById,
  appendSheetRows, appendOrder, readSheet, getGoogleAccessToken, importPrivateKey
} from "./sheets-client.mjs";
import {
  handleCustomerHybridMessage,
  handleCustomerHybridCallback,
  cleanupStoredQrisMessage
} from "./ui/controller.mjs";
import {
  setQrisMessageRef,
  invalidateStoreUiCaches,
  runBackground,
  getUserLang,
  getPendingProofOrder,
  setPendingProofOrder,
  clearPendingProofOrder
} from "./ui/state.mjs";
import {
  loadIntlPaymentConfig,
  saveIntlPaymentConfig,
  normalizeLang,
  convertIdrToUsdt,
  convertIdrToStars,
  buildAdminClaimUrl,
  renderIntlPaymentInstructionsScreen,
  renderVerifiedClaimScreen
} from "./ui/i18n.mjs";
import {
  renderAdminHomeScreen,
  renderAdminSubmenuScreen,
  renderAdminRecentOrdersScreen,
  renderAdminOrderDetailScreen,
  renderAdminPaymentQueueScreen,
  renderAdminPaymentDetailScreen,
  renderAdminPickupQueueScreen,
  renderAdminPickupDetailScreen,
  renderAdminCatalogItemScreen,
  renderAdminDeleteConfirmScreen,
  renderAdminDashboardLinkScreen,
  renderAdminExportsScreen,
  parseQuickQrisCommand,
  renderQuickQrisCaptionHtml
} from "./ui/admin-screens.mjs";
import {
  orderRowsToObjects, productRowsToObjects, localDateKey,
  csvCell, csvText, buildReportExportsFromData, isValidReportDate, buildAdminReport
} from "./reports.mjs";
import {
  createPickupTicketToken, verifyPickupTicketToken, createPickupTicketUrl,
  escapeHtml, handlePickupVerificationPage, pickupQrImageUrl,
  pickupReceiptCaption, sendPickupReceipt
} from "./pickup.mjs";

/**
 * ============================================================================
 * SEITON.ID - HIGH-PERFORMANCE BOT & INTERACTIVE DASHBOARD ENGINE
 * Stack: Cloudflare Workers + Google Sheets API + Telegram Webhook
 * Official Web : https://seiton.biz.id
 * Copyright (c) 2026 Seiton.id. All rights reserved.
 * ============================================================================
 *
 * LICENSE NOTICE
 * This source is proprietary to Seiton.id. All rights reserved.
 * No redistribution, resale, sublicensing, public reposting, or removal of
 * attribution without prior written permission from Seiton.id.
 *
 * Runtime: Cloudflare Workers ES Modules. No third-party runtime dependency.
 * Data contract:
 *   Pesanan: order_id, created_at, channel, customer_id, customer_name,
 *            product, quantity, unit_price, subtotal, shipping, total,
 *            payment_method, status
 *   Katalog_Produk: sku, nama_produk, harga, stok, aktif
 *
 * Source of truth: Cloudflare D1. Durable Objects serialize per-SKU checkout
 * and per-order state transitions; Google Sheets is a retryable reporting mirror.
 */



async function readCatalogRows(env, range = "Katalog_Produk!A2:G") {
  const state = await transactionReadiness(env);
  if (state.ready) {
    const products = await listProductsTransactional(env, true);
    return products.map(p => [
      p.sku, p.name, p.price, p.stock == null ? "" : p.stock,
      p.active ? "TRUE" : "FALSE", p.photo_url || "", p.description || ""
    ]);
  }
  return readSheet(env, range);
}
async function resolveOrderReference(env, reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) return null;
  const state = await transactionReadiness(env);
  if (state.ready) {
    const order = /^\d+$/.test(ref)
      ? await findOrderByLegacyRow(env, Number(ref))
      : await findOrderTransactional(env, ref);
    return order ? {
      order,
      rowNumber: order.legacy_sheet_row == null ? null : Number(order.legacy_sheet_row),
      row: orderToSheetRow(order)
    } : null;
  }
  if (/^\d+$/.test(ref)) {
    const rowNumber = Number(ref);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) return null;
    const rows = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
    return rows[0]?.[0] ? { rowNumber, row: rows[0], order: null } : null;
  }
  const rows = await readSheet(env, "Pesanan!A2:T");
  const index = rows.findIndex(r => String(r[0] || "").trim() === ref);
  return index < 0 ? null : { rowNumber: index + 2, row: rows[index], order: null };
}
async function mirrorTransactionalOrder(env, order, options = {}) {
  if (!order) return null;
  const row = orderToSheetRow(order);
  let rowNumber = order.legacy_sheet_row == null ? null : Number(order.legacy_sheet_row);
  try {
    if (rowNumber && rowNumber >= 2) {
      await updateSheetRange(env, "Pesanan!A" + rowNumber + ":T" + rowNumber, [row]);
      return rowNumber;
    }
    // Recovery pass: an earlier append may have succeeded before D1 stored its row number.
    if (options.recoverAppend) {
      const ids = await readSheet(env, "Pesanan!A2:A");
      const existing = ids.findIndex(r => String(r[0] || "").trim() === String(order.order_id));
      if (existing >= 0) {
        rowNumber = existing + 2;
        await setLegacyRowTransactional(env, order.order_id, rowNumber);
        await updateSheetRange(env, "Pesanan!A" + rowNumber + ":T" + rowNumber, [row]);
        return rowNumber;
      }
    }
    const result = await appendSheetRows(env, "Pesanan!A:T", [row]);
    const updatedRange = String(result?.updates?.updatedRange || "");
    const match = updatedRange.match(/!A(\d+):/);
    if (match) {
      rowNumber = Number(match[1]);
      await setLegacyRowTransactional(env, order.order_id, rowNumber);
    }
    return rowNumber;
  } catch (error) {
    console.warn(JSON.stringify({level:"warn",event:"order_sheet_mirror",order_id:order.order_id,message:error.message}));
    return null;
  }
}
async function dispatchSheetsMirrorOutbox(env, limit = 20) {
  const events = await claimSheetMirrorOutbox(env, limit);
  let delivered = 0, retried = 0, failed = 0;
  for (const event of events) {
    try {
      if (event.event_type === "CATALOG_MIRROR") {
        const product = await findProductTransactional(env, event.aggregate_id);
        if (!product || !(await mirrorTransactionalProduct(env, product))) {
          throw new Error("Katalog produk belum berhasil dicerminkan ke Google Sheets.");
        }
      } else {
        const order = await findOrderTransactional(env, event.aggregate_id);
        if (!order) throw new Error("Order untuk event mirror tidak ditemukan.");
        const rowNumber = await mirrorTransactionalOrder(env, order, { recoverAppend: true });
        if (!rowNumber || rowNumber < 2) throw new Error("Google Sheets belum mengonfirmasi lokasi baris order.");
      }
      if (!(await completeSheetMirrorOutbox(env, event))) throw new Error("Lease outbox berubah sebelum event selesai dicatat.");
      delivered++;
    } catch (error) {
      try {
        const saved = await failSheetMirrorOutbox(env, event, error);
        if (saved && Number(event.attempts) >= 8) failed++;
        else if (saved) retried++;
      } catch (retryError) {
        console.error(JSON.stringify({level:"error",event:"sheet_mirror_outbox_state",outbox_id:event.id,message:retryError.message}));
      }
    }
  }
  return {claimed:events.length,delivered,retried,failed};
}
async function dispatchOperationalAlerts(env) {
  if (String(env.OPERATIONAL_ALERTS_ENABLED || "false").toLowerCase() !== "true") {
    return { enabled:false, sent:0 };
  }
  if (!env.DB) return { enabled:true, sent:0, reason:"D1_BINDING_MISSING" };
  const checkedAt = Date.now();
  const twoHoursAgo = new Date(checkedAt - 2 * 60 * 60 * 1000).toISOString();
  const [mirrorResult, stalledMirrorResult, paymentResult] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS total FROM outbox WHERE status='FAILED' " +
      "AND event_type IN ('SHEET_MIRROR','CATALOG_MIRROR')"
    ).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS total FROM outbox WHERE status IN ('PENDING','PROCESSING') " +
      "AND event_type IN ('SHEET_MIRROR','CATALOG_MIRROR') AND attempts>=5 " +
      "AND julianday('now')-julianday(created_at)>=(1.0/24.0)"
    ).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS total FROM orders WHERE payment_confirmation_status='MENUNGGU_VERIFIKASI' " +
      "AND payment_requested_at<>'' AND julianday('now')-julianday(payment_requested_at)>=(2.0/24.0)"
    ).first()
  ]);
  const alerts = [
    { key:"failed_mirror", count:Number(mirrorResult?.total||0),
      message:"⚠️ Seiton: ada "+Number(mirrorResult?.total||0)+" pekerjaan mirror Google Sheets berstatus FAILED. D1 tetap sumber data utama; periksa antrean dan rekonsiliasi SKU sebelum retry." },
    { key:"stalled_mirror", count:Number(stalledMirrorResult?.total||0),
      message:"⚠️ Seiton: ada "+Number(stalledMirrorResult?.total||0)+" pekerjaan mirror yang masih PENDING/PROCESSING setelah ≥5 percobaan dan ≥1 jam. Periksa antrean serta cocokkan SKU dengan Sheets sebelum retry." },
    { key:"stale_payment_review", count:Number(paymentResult?.total||0),
      message:"⏳ Seiton: ada "+Number(paymentResult?.total||0)+" verifikasi pembayaran menunggu lebih dari 2 jam. Cocokkan mutasi merchant/bank sebelum mengambil tindakan." }
  ].filter(item=>item.count>0);
  const admins=String(env.ADMIN_CHAT_ID||"").split(",").map(v=>v.trim()).filter(Boolean);
  if (!admins.length || !alerts.length) return { enabled:true, sent:0, pending:alerts.length };
  const cooldownMs=6*60*60*1000;
  let sent=0;
  for (const alert of alerts) {
    const previous=await env.DB.prepare(
      "SELECT last_sent_at_ms FROM operational_alert_state WHERE alert_key=?"
    ).bind(alert.key).first();
    if (previous && checkedAt-Number(previous.last_sent_at_ms)<cooldownMs) continue;
    let failures=0;
    for (const adminId of admins) {
      try { await sendTelegram(env,adminId,alert.message); }
      catch(error) {
        failures++;
        console.warn(JSON.stringify({level:"warn",event:"operational_alert_delivery",alert_key:alert.key,
          message:String(error?.message||"TELEGRAM_DELIVERY_FAILED").slice(0,160)}));
      }
    }
    if (failures===0) {
      await env.DB.prepare(
        "INSERT INTO operational_alert_state(alert_key,last_sent_at_ms,last_value,updated_at_ms) VALUES(?,?,?,?) " +
        "ON CONFLICT(alert_key) DO UPDATE SET last_sent_at_ms=excluded.last_sent_at_ms," +
        "last_value=excluded.last_value,updated_at_ms=excluded.updated_at_ms"
      ).bind(alert.key,checkedAt,alert.count,checkedAt).run();
      sent++;
    }
  }
  return { enabled:true, sent, pending:alerts.length };
}

async function mirrorTransactionalProduct(env, product) {
  try {
    const rows = await readSheet(env, "Katalog_Produk!A2:G");
    const decision = resolveCatalogMirrorAction(rows, product?.sku);
    if (decision.action === "INVALID") {
      throw new Error("SKU katalog tidak valid; sinkronisasi dihentikan.");
    }
    if (decision.action === "DUPLICATE") {
      throw new Error("SKU duplikat ditemukan pada baris Sheets: " + decision.rowNumbers.join(", ") + ". Rekonsiliasi manual diperlukan.");
    }
    const values = [[product.sku,product.name,product.price,product.stock == null ? "" : product.stock,
      Boolean(product.active),product.photo_url || "",product.description || ""]];
    if (decision.action === "UPDATE") {
      await updateSheetRange(env,"Katalog_Produk!A"+decision.rowNumber+":G"+decision.rowNumber,values);
    } else {
      await appendSheetRows(env,"Katalog_Produk!A:G",values);
    }
    return true;
  } catch(error) {
    console.warn(JSON.stringify({level:"warn",event:"catalog_sheet_mirror",sku:product?.sku||"",message:error.message}));
    return false;
  }
}


async function handleTelegram(request, env, ctx) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: "Webhook security is not configured" }, 503);
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!constantTimeEqual(supplied, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  let update;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }
  if (update.callback_query) {
    ctx.waitUntil(handleTelegramCallback(env, update.callback_query, ctx).catch(async error => {
      console.error(JSON.stringify({ level: "error", event: "telegram_callback", message: error.message }));
      const callbackChatId = String(update.callback_query.message?.chat?.id || update.callback_query.from?.id || "");
      try {
        await updateTelegramMessage(env, update.callback_query.message, {
          text: "⚠️ Aksi gagal: " + String(error.message || "Kesalahan tidak diketahui").slice(0, 700),
          replyMarkup: null
        });
      } catch {
        try { await sendTelegram(env, callbackChatId, "⚠️ Aksi gagal: " + String(error.message || "Kesalahan tidak diketahui").slice(0, 700)); } catch {}
      }
    }));
    return json({ ok: true });
  }
  const message = update.message || update.edited_message;
  if (!message || !message.chat || !message.from) return json({ ok: true });

  const text = String(message.text || message.caption || "").trim();
  const chatId = String(message.chat.id);
  const customerId = String(message.from.id);
  const customerName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  const work = (async () => {
    if (message.reply_to_message?.text?.startsWith("🧾 BUKTI PEMBAYARAN SEITON")) {
      await handlePaymentProofUpload(env, message, chatId, customerId);
      return;
    }
    if (!isAdmin(customerId, env) && ((Array.isArray(message.photo) && message.photo.length) || message.document?.file_id)) {
      await handlePaymentProofUpload(env, message, chatId, customerId);
      return;
    }
    if (isAdmin(customerId, env) && message.reply_to_message?.text?.startsWith("📝 FORM PRODUK SEITON")) {
      try { await handleAdminProductWizardReply(env, chatId, customerId, text, message.reply_to_message.text); }
      catch (error) {
        await sendTelegram(env, chatId, "⚠️ " + error.message + "\nSilakan balas pesan formulir terbaru. Ketik /batal untuk membatalkan.");
      }
      return;
    }
    const handoffCommand = parseMessagingAdminCommand(text);
    if (handoffCommand.kind !== "UNKNOWN") {
      if (!isAdmin(customerId, env)) {
        await sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
        return;
      }
      if (handoffCommand.kind === "INVALID") {
        await sendTelegram(env, chatId,
          "⚠️ Format perintah tidak valid. Gunakan /handoff, /handoff_claim ID, /handoff_reply ID pesan, atau /handoff_close ID.");
        return;
      }
      if (!(await messagingHandoffSchemaReady(env))) {
        await sendTelegram(env, chatId,
          "⚠️ Fitur pengelolaan bantuan belum aktif. Pastikan migrasi D1 0004, 0005, dan 0006 sudah diterapkan.");
        return;
      }
      try {
        if (handoffCommand.kind === "HANDOFF_LIST") {
          await showTelegramHandoffQueue(env, { chat: { id: chatId } }, chatId);
          return;
        }
        if (handoffCommand.kind === "HANDOFF_CLAIM") {
          const result = await claimMessagingHandoff(env, handoffCommand.handoffId, chatId);
          if (result.ok && !result.alreadyClaimed) await recordAdminActivity(env, { actorId: customerId, action: "HANDOFF_CLAIMED", resourceType: "support_handoff", resourceId: handoffCommand.handoffId, summary: { handoff_id: handoffCommand.handoffId } });
          if (result.ok) {
            await sendTelegram(env, chatId,
              (result.alreadyClaimed ? "ℹ️ Kasus ini sudah diambil oleh Anda." : "✅ Kasus berhasil diambil.") +
              "\nPelanggan: " + (result.handoff?.customer_name || "-") +
              "\nBalas dengan: /handoff_reply " + handoffCommand.handoffId + " pesan Anda" +
              "\nSelesaikan dengan: /handoff_close " + handoffCommand.handoffId);
          } else {
            const messageByReason = {
              NOT_FOUND: "Kasus bantuan tidak ditemukan.",
              CLOSED: "Kasus bantuan sudah ditutup.",
              CLAIMED_BY_OTHER: "Kasus ini sedang ditangani admin lain: " + (result.handoff?.claimed_by || "-"),
              CONFLICT: "Status kasus berubah. Jalankan /handoff untuk memuat ulang antrean."
            };
            await sendTelegram(env, chatId, "⚠️ " + (messageByReason[result.reason] || "Kasus tidak dapat diambil."));
          }
          return;
        }
        if (handoffCommand.kind === "HANDOFF_REPLY") {
          const result = await queueMessagingHandoffReply(
            env, handoffCommand.handoffId, chatId, handoffCommand.message
          );
          if (!result.ok) {
            const messageByReason = {
              NOT_FOUND: "Kasus bantuan tidak ditemukan.",
              CLOSED: "Kasus sudah ditutup. Balasan tidak dikirim.",
              NOT_CLAIMED: "Ambil kasus terlebih dahulu dengan /handoff_claim ID.",
              CLAIMED_BY_OTHER: "Kasus ini sedang dipegang admin lain: " + (result.handoff?.claimed_by || "-"),
              CHANNEL_NOT_CONNECTED: "Kanal pelanggan belum memiliki pengirim aktif."
            };
            await sendTelegram(env, chatId, "⚠️ " + (messageByReason[result.reason] || "Balasan tidak dapat diantrikan."));
            return;
          }
          await recordAdminActivity(env, { actorId: customerId, action: "HANDOFF_REPLY_QUEUED", resourceType: "support_handoff", resourceId: handoffCommand.handoffId, summary: { handoff_id: handoffCommand.handoffId, message_characters: handoffCommand.message.length } });
          await dispatchTelegramMessagingOutbox(env, 50);
          await sendTelegram(env, chatId,
            "✅ Balasan admin dimasukkan ke antrean pengiriman Telegram untuk pelanggan " +
            (result.handoff?.customer_name || "") + ". Perintah pengiriman langsung sudah dijalankan; kegagalan sementara akan dicoba ulang otomatis.");
          return;
        }
        if (handoffCommand.kind === "HANDOFF_CLOSE") {
          const result = await closeMessagingHandoff(env, handoffCommand.handoffId, chatId);
          if (result.ok && !result.alreadyClosed) await recordAdminActivity(env, { actorId: customerId, action: "HANDOFF_RESOLVED", resourceType: "support_handoff", resourceId: handoffCommand.handoffId, summary: { handoff_id: handoffCommand.handoffId, resolution: "RESOLVED" } });
          if (!result.ok) {
            const messageByReason = {
              NOT_FOUND: "Kasus bantuan tidak ditemukan.",
              CLAIMED_BY_OTHER: "Kasus ini sedang dipegang admin lain: " + (result.handoff?.claimed_by || "-"),
              CONFLICT: "Status kasus berubah. Jalankan /handoff untuk memuat ulang antrean."
            };
            await sendTelegram(env, chatId, "⚠️ " + (messageByReason[result.reason] || "Kasus tidak dapat ditutup."));
          } else if (result.alreadyClosed) {
            await sendTelegram(env, chatId, "ℹ️ Kasus bantuan tersebut sudah berstatus ditutup.");
          } else if (result.automationResumed) {
            await sendTelegram(env, chatId, "✅ Kasus ditutup. Balasan otomatis BOT diaktifkan kembali untuk percakapan tersebut.");
          } else if (result.conversationMode === "OPTED_OUT") {
            await sendTelegram(env, chatId, "✅ Kasus ditutup. Pelanggan sebelumnya menonaktifkan balasan otomatis, sehingga mode STOP tetap dipertahankan.");
          } else {
            await sendTelegram(env, chatId, "✅ Kasus ditutup. Percakapan tetap dalam penanganan admin karena masih ada permintaan bantuan aktif lainnya.");
          }
          return;
        }
      } catch (error) {
        console.error(JSON.stringify({level:"error",event:"messaging_handoff_admin",message:error.message}));
        await sendTelegram(env, chatId, "⚠️ Operasi bantuan gagal. Periksa status migrasi D1 dan coba kembali.");
        return;
      }
    }
    if (text === "/migrasi_d1") {
      if (!isAdmin(customerId,env)) return sendTelegram(env,chatId,"⛔ Perintah ini khusus admin.");
      if (!env.DB || !env.ORDER_COORDINATOR) return sendTelegram(env,chatId,"⚠️ Binding D1/ORDER_COORDINATOR belum tersedia. Migrasi belum dapat dijalankan.");
      const state = await transactionReadiness(env);
      if (state.ready) return sendTelegram(env,chatId,"✅ Lapisan transaksi D1 sudah aktif. Tidak ada migrasi ulang yang diperlukan.");
      await ensurePaymentWorkflowHeaders(env);
      const [catalogRows,orderRows] = await Promise.all([
        readSheet(env,"Katalog_Produk!A2:G"),
        readSheet(env,"Pesanan!A2:T")
      ]);
      const result = await bootstrapTransactions(env.DB,catalogRows,orderRows);
      await recordAdminActivity(env, { actorId: customerId, action: "D1_MIGRATION_COMPLETED", resourceType: "transaction_store", summary: { catalog_imported: result.catalog, historical_orders_imported: result.orders } });
      await sendTelegram(env,chatId,
        "✅ Migrasi transaksi D1 selesai.\nProduk diimpor: "+result.catalog+
        "\nOrder historis diimpor: "+result.orders+
        "\n\nOrder lama tidak mengurangi stok ulang. Checkout baru kini memakai D1 dan reservasi stok atomik.");
      return;
    }
    if (text === "/cekstok") {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const stock = await listDigitalStockD1(env.DB);
      const lines = ["📦 STOK PRODUK DIGITAL"];
      for (const category of ["muse_starter","muse_bisnis"]) {
        const item = stock[category];
        lines.push("", category, "Tersedia: " + item.available, "Sudah diklaim: " + item.claimed,
          "Dicabut: " + item.revoked, "Domain: " + (item.domains.join(", ") || "-"));
      }
      await sendTelegram(env, chatId, lines.join("\n"));
      return;
    }
    if (text.startsWith("/addstock")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const match = text.match(/^\/addstock(?:@[a-z0-9_]+)?\s+(muse_starter|muse_bisnis)\s*\n([\s\S]+)$/i);
      if (!match) return sendTelegram(env,chatId,"Format: /addstock muse_starter\nemail@domain.biz.id|password|catatan");
      try {
        const category = match[1].toLowerCase();
        const stub = digitalStockCoordinator(env, category);
        const added = await stub.addDigitalStock(category, match[2], customerId);
        const waiting = added.waitingOrderIds || [];
        let delivered = 0;
        for (const orderId of waiting) {
          const result = await deliverDigitalProductAfterPayment(env, orderId);
          if (result.status === "DELIVERED") delivered += 1;
        }
        await recordAdminActivity(env,{actorChannel:"telegram",actorId:customerId,action:"DIGITAL_STOCK_ADDED",resourceType:"digital_stock",resourceId:category,summary:{added:added.added,duplicates:added.duplicate,auto_delivered:delivered}});
        await sendTelegram(env,chatId,"✅ Penambahan stok selesai.\nKategori: "+category+"\nDitambahkan: "+added.added+"\nDuplikat dilewati: "+added.duplicate+"\nStok tersedia: "+added.available+"\nOrder antrean diproses: "+delivered);
      } catch(error) {
        await sendTelegram(env,chatId,"⚠️ Stok tidak ditambahkan: "+String(error?.message||"DIGITAL_STOCK_FAILED").slice(0,180));
      }
      return;
    }
    if (text.startsWith("/delstock")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const match=text.match(/^\/delstock(?:@[a-z0-9_]+)?\s+(muse_starter|muse_bisnis)\s+(\S+)$/i);
      if(!match)return sendTelegram(env,chatId,"Format: /delstock muse_starter email@domain.biz.id");
      const category=match[1].toLowerCase();
      const stub=digitalStockCoordinator(env, category);
      const result=await stub.deleteDigitalStock(category,match[2],customerId);
      await recordAdminActivity(env,{actorChannel:"telegram",actorId:customerId,action:"DIGITAL_STOCK_REVOKED",resourceType:"digital_stock",resourceId:category,summary:{removed:result.removed,email_domain:String(match[2]).split("@")[1]||""}});
      await sendTelegram(env,chatId,result.removed?"✅ Entri stok tersedia berhasil dicabut.":"⚠️ Entri tidak ditemukan atau sudah diklaim.");
      return;
    }
    if (text.startsWith("/cekorder")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const reference=text.split(/\s+/)[1];
      if(!reference)return sendTelegram(env,chatId,"Format: /cekorder <order_ref>");
      const item=await getDigitalOrderD1(env,reference);
      if(!item)return sendTelegram(env,chatId,"Order digital tidak ditemukan.");
      const lines=["🔎 DETAIL ORDER DIGITAL","Order: "+item.order_id,"Kategori: "+item.category,"Status: "+item.status,"Order pembayaran: "+item.order_status,"Email: "+(item.credentials?.email||"-")];
      if(item.credentials?.password)lines.push("Password: "+item.credentials.password);
      lines.push("Dikirim: "+(item.delivered_at||"-"),"Catatan: gunakan informasi ini hanya untuk klaim garansi order terkait.");
      await sendTelegram(env,chatId,lines.join("\n"));
      return;
    }
    if (/^\/qris_test(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text)) {
      if (message.chat.type !== "private" || !isAdmin(customerId, env)) {
        await sendTelegram(env, chatId, "⛔ Pratinjau QRIS hanya dapat dijalankan admin melalui chat pribadi.");
        return;
      }
      const match = text.match(/^\/qris_test(?:@[a-z0-9_]+)?\s+(\d{1,8})\s*$/i);
      if (!match) {
        await sendTelegram(env, chatId, "Format: /qris_test <nominal>\nContoh: /qris_test 10000\nBatas pratinjau: Rp1–Rp10.000.000.");
        return;
      }
      const amount = Number(match[1]);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_QRIS_TRANSACTION_AMOUNT) {
        await sendTelegram(env, chatId, "⚠️ Nominal pratinjau harus berupa bilangan bulat Rp1 sampai Rp10.000.000.");
        return;
      }
      try {
        if (!env.DB) throw new Error("D1_BINDING_MISSING");
        if (!String(env.QRIS_STATIC_PAYLOAD || "").trim()) throw new Error("QRIS_STATIC_PAYLOAD_MISSING");
        const collision = await env.DB.prepare(
          "SELECT order_id FROM qris_payments WHERE expected_amount=? LIMIT 1"
        ).bind(amount).first();
        if (collision) {
          throw new Error("Nominal tersebut sudah dipakai pesanan " + String(collision.order_id) + ". Pilih nominal uji lain.");
        }
        const merchant = extractQrisMerchantProfile(env.QRIS_STATIC_PAYLOAD);
        if (!merchant.merchantName) throw new Error("QRIS_MERCHANT_NAME_MISSING");
        const payload = buildDynamicQrisPayload(env.QRIS_STATIC_PAYLOAD, amount);
        const image = await fetchInternalQrisImage(payload);
        await sendTelegramPhotoBlob(env, chatId, image, [
          "🧪 PRATINJAU QRIS DINAMIS INTERNAL",
          "Merchant: " + (merchant.merchantName || "GoPay Merchant"),
          "Nominal payload: " + rupiah(amount),
          "",
          "Ini hanya QR uji; tidak membuat pesanan atau catatan pembayaran di D1.",
          "Pindai dahulu dan pastikan nama merchant serta nominal benar. Jangan lanjutkan pembayaran sebelum keduanya cocok.",
          "Jika dilakukan pembayaran sungguhan, dana akan masuk ke merchant GoPay yang tertanam di QR. Periksa transaksi masuk secara manual.",
          "QR ini tidak dibatalkan atau dibuat sekali pakai oleh library Seiton. Gunakan hanya untuk uji terkontrol dan jangan bagikan ke pelanggan."
        ].join("\n"));
        await recordAdminActivity(env, {
          actorId: customerId,
          action: "QRIS_TEST_QR_GENERATED",
          resourceType: "qris_test",
          resourceId: "internal-preview",
          summary: { amount, merchant_name: merchant.merchantName, order_created: false }
        });
      } catch (error) {
        await sendTelegram(env, chatId, "⚠️ Pratinjau QRIS gagal dibuat: " +
          String(error?.message || "QRIS_TEST_FAILED").slice(0, 240));
      }
      return;
    }

    if (text.startsWith("/approve")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const reference=text.split(/\s+/)[1];
      if(!reference)return sendTelegram(env,chatId,"Format: /approve <order_ref>");
      try {
        const found=await resolveOrderReference(env,reference);
        if(!found)throw new Error("Pesanan tidak ditemukan.");
        const paid=String(found.order?.payment_confirmation_status||"").toUpperCase()==="DISETUJUI";
        let receiptSent=true;
        if(!paid) {
          const approved=await approvePaymentAndIssueTicket(env,reference,"telegram:"+customerId);
          try{await sendPickupReceipt(env,String(approved.row[3]),approved.row,String(approved.row[0]),approved.receiptCode);}
          catch(error){receiptSent=false;console.error(JSON.stringify({level:"error",event:"telegram_receipt_delivery",order_id:approved.row[0],message:error.message}));}
        }
        const delivered=await deliverDigitalProductAfterPayment(env,String(found.order.order_id));
        const status=delivered.status||"PAYMENT_APPROVED";
        await sendTelegram(env,chatId,"✅ Perintah /approve selesai untuk "+found.order.order_id+".\nStatus produk: "+status+(receiptSent?"":"\nResi belum terkirim."));
      } catch(error) {
        await sendTelegram(env,chatId,"⚠️ Pesanan belum dapat diproses: "+String(error?.message||"APPROVE_FAILED").slice(0,180));
      }
      return;
    }

    const quickQris = parseQuickQrisCommand(text, MAX_QRIS_TRANSACTION_AMOUNT);
    if (quickQris) {
      if (!isAdmin(customerId, env)) {
        await sendTelegram(env, chatId, "⛔ Perintah /qris khusus admin.");
        return;
      }
      if (!quickQris.ok) {
        await sendTelegram(env, chatId, quickQris.error);
        return;
      }
      try {
        const staticPayload = String(env.QRIS_STATIC_PAYLOAD || "").trim();
        if (!staticPayload) throw new Error("QRIS_STATIC_PAYLOAD belum dikonfigurasi.");
        const merchant = extractQrisMerchantProfile(staticPayload);
        if (!merchant.merchantName) throw new Error("QRIS_MERCHANT_NAME_MISSING");
        const payload = buildDynamicQrisPayload(staticPayload, quickQris.amount);
        const image = await fetchInternalQrisImage(payload);
        const caption = renderQuickQrisCaptionHtml({
          amount: quickQris.amount,
          merchantName: merchant.merchantName,
          merchantCity: merchant.merchantCity,
          note: quickQris.note
        });
        await sendTelegramPhotoBlob(env, chatId, image, caption, null, { parseMode: "HTML" });
        await recordAdminActivity(env, {
          actorId: customerId,
          action: "ADMIN_QUICK_QRIS_GENERATED",
          resourceType: "qris_quick",
          resourceId: "direct-" + quickQris.amount,
          summary: { amount: quickQris.amount, merchant_name: merchant.merchantName, has_note: Boolean(quickQris.note) }
        });
      } catch (error) {
        await sendTelegram(env, chatId, "⚠️ Gagal membuat QRIS: " + String(error?.message || "QRIS_QUICK_FAILED").slice(0, 220));
      }
      return;
    }

    if (text.startsWith("/ambilsetup")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const setupId=text.split(/\s+/)[1];
      if(!setupId)return sendTelegram(env,chatId,"Format: /ambilsetup <setup_id>");
      const setup=await getMuseBusinessSetupD1(env,setupId);
      if(!setup)return sendTelegram(env,chatId,"Form setup tidak ditemukan.");
      await sendTelegram(env,chatId,[
        "🔐 FORM SETUP MUSE BISNIS (RAHASIA)",
        "Setup: "+setup.setup_id,
        "Order: "+setup.order_id,
        "Nama usaha: "+setup.business_name,
        "Token Bot Telegram: "+setup.payload.telegramToken,
        "Deskripsi: "+setup.payload.description,
        "",
        "Jangan teruskan token kepada pihak lain. Setelah selesai, cabut/ganti token jika sudah tidak diperlukan."
      ].join("\n"));
      await recordAdminActivity(env,{actorChannel:"telegram",actorId:customerId,action:"DIGITAL_SETUP_SECRET_VIEWED",resourceType:"digital_setup",resourceId:setupId,summary:{setup_type:"muse_bisnis"}});
      return;
    }
    if (text.startsWith("/setadmin")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const rawUser = text.replace(/^\/setadmin(?:@[a-z0-9_]+)?/i, "").trim().replace(/^@+/, "");
      if (!rawUser || !/^[A-Za-z0-9_]{4,32}$/.test(rawUser)) {
        return sendTelegram(env, chatId, "Format: /setadmin @username_admin\nContoh: /setadmin @seiton_admin");
      }
      const updated = await saveIntlPaymentConfig(env, { admin_telegram_username: rawUser });
      return sendTelegram(env, chatId, `✅ Username klaim produk berhasil diatur ke @${updated.admin_telegram_username}.\nPembeli yang pembayarannya terverifikasi akan diarahkan ke https://t.me/${updated.admin_telegram_username}`);
    }
    if (text.startsWith("/setusdt")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const args = text.replace(/^\/setusdt(?:@[a-z0-9_]+)?/i, "").trim().split(/\s+/).filter(Boolean);
      if (!args.length) {
        return sendTelegram(env, chatId, "Format: /setusdt <alamat_wallet|off> [jaringan]\nContoh: /setusdt TXYZ1234567890abcdef TRC20");
      }
      if (args[0].toLowerCase() === "off") {
        await saveIntlPaymentConfig(env, { usdt_enabled: false });
        return sendTelegram(env, chatId, "✅ Metode pembayaran USDT dinonaktifkan.");
      }
      const wallet = args[0];
      const network = args.slice(1).join(" ") || "TRC20 / BEP20 (BSC)";
      const updated = await saveIntlPaymentConfig(env, { usdt_enabled: true, usdt_wallet_address: wallet, usdt_network: network });
      return sendTelegram(env, chatId, `✅ Pembayaran USDT aktif.\n• Jaringan: ${updated.usdt_network}\n• Wallet: ${updated.usdt_wallet_address}\n• Kurs: 1 USDT = ${rupiah(updated.usd_exchange_rate)}`);
    }
    if (text.startsWith("/setpaypal")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const arg = text.replace(/^\/setpaypal(?:@[a-z0-9_]+)?/i, "").trim();
      if (!arg) {
        return sendTelegram(env, chatId, "Format: /setpaypal <email_atau_link|off>\nContoh: /setpaypal paypal.me/seitonid");
      }
      if (arg.toLowerCase() === "off") {
        await saveIntlPaymentConfig(env, { paypal_enabled: false });
        return sendTelegram(env, chatId, "✅ Metode pembayaran PayPal dinonaktifkan.");
      }
      const updated = await saveIntlPaymentConfig(env, { paypal_enabled: true, paypal_address: arg });
      return sendTelegram(env, chatId, `✅ Pembayaran PayPal aktif.\n• Tujuan: ${updated.paypal_address}\n• Kurs: 1 USD = ${rupiah(updated.usd_exchange_rate)}`);
    }
    if (text.startsWith("/setrate")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const arg = Number(text.replace(/^\/setrate(?:@[a-z0-9_]+)?/i, "").trim().replace(/[.,]/g, ""));
      if (!Number.isSafeInteger(arg) || arg < 100 || arg > 1000000) {
        return sendTelegram(env, chatId, "Format: /setrate <rupiah_per_1_usd>\nContoh: /setrate 16000");
      }
      const updated = await saveIntlPaymentConfig(env, { usd_exchange_rate: arg });
      return sendTelegram(env, chatId, `✅ Kurs konversi internasional diperbarui: 1 USD / USDT = ${rupiah(updated.usd_exchange_rate)}`);
    }
    if (text.startsWith("/paymentconfig")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const cfg = await loadIntlPaymentConfig(env);
      const methods = await getAvailablePaymentMethods(env);
      return sendTelegram(env, chatId, [
        "⚙️ KONFIGURASI PEMBAYARAN & KLAIM ADMIN",
        "• Metode aktif: " + (methods.join(", ") || "-"),
        "• Admin Klaim: " + (cfg.admin_telegram_username ? "@" + cfg.admin_telegram_username : "(gunakan /setadmin @username)"),
        "• USDT: " + (cfg.usdt_enabled ? "Aktif (" + cfg.usdt_network + ") — " + (cfg.usdt_wallet_address || "wallet belum diatur") : "Nonaktif"),
        "• PayPal: " + (cfg.paypal_enabled ? "Aktif — " + (cfg.paypal_address || "-") : "Nonaktif"),
        "• Kurs USD/USDT: 1 USD = " + rupiah(cfg.usd_exchange_rate),
        "• Auto-verifikasi OCR QRIS: " + (cfg.auto_verify_qris_ocr ? "Aktif" : "Nonaktif"),
        "• Auto-verifikasi Bukti Non-QRIS: " + (cfg.auto_verify_non_qris_proof ? "Aktif" : "Nonaktif"),
        "",
        "Perintah cepat: /setadmin, /setusdt, /setpaypal, /setrate"
      ].join("\n"));
    }
    if (text.startsWith("/laporan")) {
      if (!isAdmin(customerId, env)) return sendTelegram(env, chatId, "⛔ Perintah ini khusus admin.");
      const state = await transactionReadiness(env);
      const d1Orders = state.ready ? await listOrdersTransactional(env, { limit: 5000 }) : null;
      const report = await buildAdminReport(env, d1Orders);
      await recordAdminActivity(env, { actorId: customerId, action: "REPORT_GENERATED", resourceType: "sales_report", summary: { report_type: "sales_summary" } });
      await sendTelegram(env, chatId, report, adminMenuKeyboard(), { parseMode: "HTML" });
      return;
    }
    if (/^SETUP\s*\|/i.test(text)) {
      if (message.chat.type && message.chat.type !== "private") return;
      try {
        const input=parseMuseBusinessSetupInput(text);
        const eligible=await env.DB.prepare(
          "SELECT order_id FROM orders WHERE customer_id=? AND sku='MUSE-BISNIS' " +
          "AND status IN ('DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED') " +
          "AND payment_confirmation_status='DISETUJUI' AND EXISTS (" +
          "SELECT 1 FROM digital_fulfillments f WHERE f.order_id=orders.order_id AND f.status='DELIVERED') " +
          "AND NOT EXISTS (SELECT 1 FROM digital_setup_requests s WHERE s.order_id=orders.order_id) " +
          "ORDER BY created_ms DESC LIMIT 1"
        ).bind(customerId).first();
        if(!eligible) {
          await sendTelegram(env,chatId,"⚠️ Form SETUP hanya dapat dikirim setelah paket Muse Bisnis dibayar dan akun berhasil dikirim.");
          return;
        }
        const result=await storeMuseBusinessSetupD1(env,eligible.order_id,customerId,input);
        for(const target of String(env.ADMIN_CHAT_ID||"").split(",").map(v=>v.trim()).filter(Boolean)) {
          await sendTelegram(env,target,"🛠️ FORM SETUP MUSE BISNIS BARU\nSetup ID: "+result.setupId+
            "\nOrder: "+eligible.order_id+"\nNama usaha: "+input.businessName+
            "\nDeskripsi: "+input.description+
            "\nToken tersimpan terenkripsi. Ambil melalui /ambilsetup "+result.setupId);
        }
        await sendTelegram(env,chatId,"✅ Form setup diterima. Admin Seiton.id akan menindaklanjuti. Referensi: "+result.setupId);
      } catch(error) {
        await sendTelegram(env,chatId,"⚠️ Form setup tidak diterima: "+String(error?.message||"SETUP_FAILED").slice(0,180));
      }
      return;
    }
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const admin = isAdmin(customerId, env);
      if (admin) {
        await sendSeitonWelcome(env, chatId, true);
        await recordAdminActivity(env, {
          actorId: customerId, action: "ADMIN_MENU_OPENED", resourceType: "admin_menu",
          summary: { entry_point: text.startsWith("/start") ? "start" : "help" }
        });
        return;
      }
      if (message.chat.type && message.chat.type !== "private") return;
      if (text.startsWith("/start")) {
        const handledStart = await handleCustomerHybridMessage(env, ctx, message, "/start", {
          readTelegramCatalogRows,
          getAvailablePaymentMethods
        });
        if (handledStart) return;
      }
      if (await messagingCoreReady(env)) {
        const messagingText = text.startsWith("/start") ? "START" : "MENU";
        const event = telegramMessagingEvent(update, message, messagingText);
        await processMessagingEvent(env, event, createMessagingServices(env));
        await dispatchTelegramMessagingOutbox(env, 20);
      } else {
        await sendSeitonWelcome(env, chatId, false);
      }
      return;
    }
    if (!isAdmin(customerId, env)) {
      if (message.chat.type && message.chat.type !== "private") return;
      const handledUi = await handleCustomerHybridMessage(env, ctx, message, text, {
        readTelegramCatalogRows,
        getAvailablePaymentMethods
      });
      if (handledUi) return;
      if (await messagingCoreReady(env)) {
        const event = telegramMessagingEvent(update, message, text);
        await processMessagingEvent(env, event, createMessagingServices(env));
        await dispatchTelegramMessagingOutbox(env, 20);
        return;
      }

      // Migration is additive but must be applied before Messaging Core is enabled.
      // Preserve the previous Telegram ordering flow until the messaging tables exist.
      const legacyOrderInput = parseOrderText(text);
      if (!legacyOrderInput) {
        await sendTelegram(env, chatId,
          "🛍️ *Selamat datang di Seiton.id!*\\n\\n" +
          "Format pesanan:\\n`beli SKU jumlah metode_pembayaran`\\n" +
          "Contoh: `beli SEI-001 2 QRIS`\\n\\n" +
          "Ketik /help untuk bantuan.");
        return;
      }
      const legacyResult = await createOrder(env, {
        ...legacyOrderInput, channel: "telegram", customerId, customerName,
        idempotencyKey: String(update.update_id ?? (chatId + ":" + message.message_id))
      });
      await sendTelegram(env, chatId, await orderConfirmationWithPaymentInstructions(env, legacyResult), orderConfirmationKeyboard(legacyResult));
      if (String(legacyResult.paymentMethod || "").toUpperCase() === "QRIS") await sendQrisPaymentScreen(env, chatId, legacyResult);
      return;
    }
    const orderInput = parseOrderText(text);
    if (!orderInput) {
      await sendTelegram(env, chatId,
        "🛍️ *Selamat datang di Seiton.id!*\\n\\n" +
        "Format pesanan:\\n`beli SKU jumlah metode_pembayaran`\\n" +
        "Contoh: `beli SEI-001 2 QRIS`\\n\\n" +
        "Ketik /help untuk bantuan.");
      return;
    }
    const result = await createOrder(env, {
      ...orderInput, channel: "telegram", customerId, customerName,
      idempotencyKey: String(update.update_id ?? (chatId + ":" + message.message_id))
    });
    await sendTelegram(env, chatId, await orderConfirmationWithPaymentInstructions(env, result), orderConfirmationKeyboard(result));
    if (String(result.paymentMethod || "").toUpperCase() === "QRIS") await sendQrisPaymentScreen(env, chatId, result);
  })();
  ctx.waitUntil(work.catch(async error => {
    console.error(JSON.stringify({ level: "error", event: "telegram_processing", message: error.message }));
    try {
      await sendTelegram(env, chatId, "⚠️ Pesanan belum dapat diproses. Silakan coba kembali atau hubungi admin.");
    } catch (sendError) {
      console.error(JSON.stringify({level:"error",event:"telegram_fallback_notice",message:sendError.message}));
    }
  }));
  return json({ ok: true });
}



async function ensureCatalogHeaders(env) {
  const headers = await readSheet(env, "Katalog_Produk!A1:G1");
  if (!headers[0]?.[5] || !headers[0]?.[6]) {
    const token = await getGoogleAccessToken(env);
    const range = encodeURIComponent("Katalog_Produk!F1:G1");
    const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "/values/" + range + "?valueInputOption=RAW", {
      method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [["foto_url", "deskripsi"]] })
    });
    if (!response.ok) throw new Error("Tidak dapat menyiapkan kolom foto dan deskripsi katalog.");
  }
}
const ADMIN_PRODUCT_FIELD_PROMPTS = {
  sku: ["SKU Produk", "Contoh: SEI-002. Huruf, angka, titik, _ atau -."],
  name: ["Nama Produk", "Contoh: Paket Website UMKM. Maksimal 100 karakter."],
  price: ["Harga Produk (Rupiah)", "Contoh: 25000 atau 25.000. Masukkan angka bulat rupiah."],
  stock: ["Stok Produk", "Masukkan angka. Ketik 0 jika habis, atau 'tak terbatas' untuk stok tanpa batas."],
  active: ["Status Produk", "Balas Aktif atau Nonaktif."],
  photo_url: ["URL Foto Produk (opsional)", "Kirim URL HTTPS. Ketik /skip untuk mempertahankan foto atau /hapus untuk mengosongkannya."],
  description: ["Deskripsi Produk (opsional)", "Maksimal 500 karakter. Ketik /skip untuk mempertahankan atau /hapus untuk mengosongkan."]
};

function parseProductWizardInteger(value, label) {
  const raw = String(value ?? "").trim().replace(/^rp\s*/i,"").replace(/\s/g,"");
  let normalized = raw;
  if (/^\d{1,3}(?:\.\d{3})+$/.test(raw)) normalized = raw.replace(/\./g,"");
  if (/^\d{1,3}(?:,\d{3})+$/.test(raw)) normalized = raw.replace(/,/g,"");
  if (!/^\d+$/.test(normalized)) throw new Error(label + " harus berupa bilangan bulat rupiah/angka tanpa pecahan.");
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(label + " tidak valid.");
  return number;
}

function parseProductWizardValue(field, input, currentValue, mode) {
  const value = String(input ?? "").trim();
  const command = value.toLowerCase();
  if (command === "/batal" || command === "batal") return { cancel: true };
  if (command === "/skip" || command === "skip") {
    if (field === "sku" || field === "name" || field === "price") {
      if (currentValue == null || currentValue === "") throw new Error("Bagian ini wajib diisi.");
    }
    return { value: currentValue };
  }
  if (field === "sku") {
    const sku = value.toUpperCase();
    if (!/^[A-Z0-9._-]{1,40}$/.test(sku)) throw new Error("SKU hanya boleh memakai huruf, angka, titik, garis bawah, atau tanda hubung (maksimal 40 karakter).");
    return { value: sku };
  }
  if (field === "name") {
    if (!value || value.length > 100) throw new Error("Nama produk wajib diisi dan maksimal 100 karakter.");
    return { value };
  }
  if (field === "price") return { value: parseProductWizardInteger(value,"Harga") };
  if (field === "stock") {
    if (["tak terbatas","tidak terbatas","unlimited","∞","tanpa batas"].includes(command)) return { value: null };
    return { value: parseProductWizardInteger(value,"Stok") };
  }
  if (field === "active") {
    if (["aktif","ya","yes","y","true","1"].includes(command)) return { value: true };
    if (["nonaktif","tidak","no","n","false","0"].includes(command)) return { value: false };
    throw new Error("Pilih salah satu: Aktif atau Nonaktif.");
  }
  if (field === "photo_url") {
    if (command === "/hapus" || command === "hapus") return { value: "" };
    if (value && (!/^https:\/\//i.test(value) || value.length > 1000)) throw new Error("Foto harus berupa URL HTTPS yang valid (maksimal 1.000 karakter).");
    return { value };
  }
  if (field === "description") {
    if (command === "/hapus" || command === "hapus") return { value: "" };
    if (value.length > 500) throw new Error("Deskripsi maksimal 500 karakter.");
    return { value };
  }
  throw new Error("Kolom formulir tidak dikenal.");
}

async function getAdminProductDraft(env, adminId, formId) {
  return env.DB.prepare(
    "SELECT * FROM admin_product_drafts WHERE admin_id=? AND form_id=? AND expires_at>? LIMIT 1"
  ).bind(String(adminId),String(formId),new Date().toISOString()).first();
}

async function askAdminProductField(env, chatId, formId, field, currentValue, mode) {
  const [label, help] = ADMIN_PRODUCT_FIELD_PROMPTS[field] || ["Data Produk","Masukkan nilai."];
  const existing = mode === "EDIT" && currentValue !== "" && currentValue != null
    ? "\nNilai saat ini: " + (field === "price" ? rupiah(currentValue) : field === "active" ? (currentValue ? "Aktif" : "Nonaktif") : field === "stock" && currentValue === null ? "Tak terbatas" : String(currentValue))
    : "";
  const optional = field === "photo_url" || field === "description";
  const prompt = [
    "📝 FORM PRODUK SEITON",
    "FORM_ID=" + formId,
    "FIELD=" + field,
    "",
    "Tahap: " + label,
    help + existing,
    optional ? "Balas /skip untuk mempertahankan nilai saat ini atau /hapus untuk mengosongkan." : "Balas pesan ini dengan nilainya.",
    "Ketik /batal untuk membatalkan seluruh formulir."
  ].join("\n");
  await sendTelegram(env,chatId,prompt,{
    force_reply:true,
    input_field_placeholder:field === "price" ? "Contoh: 25000" : field === "stock" ? "Contoh: 10 atau tak terbatas" : label
  });
}

async function promptAdminProduct(env, chatId, mode, sku = "") {
  if (!env.DB) throw new Error("D1 belum tersedia untuk menyimpan formulir produk.");
  let product = {
    sku:"",name:"",price:"",stock:0,active:true,photo_url:"",description:""
  };
  let originalSku = "";
  if (mode === "EDIT") {
    const rows = await readCatalogRows(env);
    const row = rows.find(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
    if (!row) throw new Error("Produk tidak ditemukan.");
    const parsed = parseCatalogProduct(row);
    product = {
      sku:parsed.sku,name:parsed.name,price:parsed.price,stock:parsed.stock,
      active:parsed.active,photo_url:parsed.photoUrl,description:parsed.description
    };
    originalSku = parsed.sku;
  }
  const steps = mode === "ADD"
    ? ["sku","name","price","stock","active","photo_url","description"]
    : ["name","price","stock","active","photo_url","description"];
  const now = new Date().toISOString();
  const formId = crypto.randomUUID();
  const expires = new Date(Date.now()+30*60*1000).toISOString();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_product_drafts " +
    "(admin_id,form_id,mode,original_sku,step_index,steps_json,draft_json,status,created_at,updated_at,expires_at) " +
    "VALUES(?,?,?,?,0,?,?, 'IN_PROGRESS',?,?,?)"
  ).bind(String(chatId),formId,mode,originalSku,JSON.stringify(steps),JSON.stringify(product),now,now,expires).run();
  await sendTelegram(env,chatId,
    mode === "ADD"
      ? "📝 Kita mulai formulir produk baru. Isi setiap bagian satu per satu; tidak perlu memakai tanda |."
      : "📝 Kita mulai formulir edit " + originalSku + ". SKU dikunci; gunakan /skip untuk mempertahankan nilai yang ada.",
    null
  );
  await askAdminProductField(env,chatId,formId,steps[0],product[steps[0]],mode);
}

async function handleAdminProductWizardReply(env, chatId, actorId, input, prompt) {
  const formId = String(prompt || "").match(/FORM_ID=([a-f0-9-]{20,40})/i)?.[1] || "";
  const fieldFromPrompt = String(prompt || "").match(/FIELD=([a-z_]+)/i)?.[1] || "";
  if (!formId || !fieldFromPrompt) throw new Error("Pesan formulir tidak dikenali. Buka kembali menu Tambah Produk.");
  const row = await getAdminProductDraft(env,chatId,formId);
  if (!row || row.status !== "IN_PROGRESS") throw new Error("Formulir sudah kedaluwarsa atau tidak lagi aktif. Buka kembali Tambah Produk.");
  const steps = JSON.parse(row.steps_json || "[]");
  const draft = JSON.parse(row.draft_json || "{}");
  const index = Number(row.step_index);
  const field = steps[index];
  if (!field || field !== fieldFromPrompt) throw new Error("Tahap formulir ini sudah terlewati. Balas pesan formulir terbaru.");
  let parsed;
  try {
    parsed = parseProductWizardValue(field,input,draft[field],row.mode);
  } catch (error) {
    await sendTelegram(env,chatId,"⚠️ " + error.message + "\\nCoba isi bagian ini kembali.");
    await askAdminProductField(env,chatId,formId,field,draft[field],row.mode);
    return;
  }
  if (parsed.cancel) {
    await env.DB.prepare("DELETE FROM admin_product_drafts WHERE admin_id=? AND form_id=?")
      .bind(String(chatId),formId).run();
    await sendTelegram(env,chatId,"✖️ Formulir produk dibatalkan.",adminMenuKeyboard());
    return;
  }
  draft[field] = parsed.value;
  const nextIndex = index+1;
  const now = new Date().toISOString();
  if (nextIndex < steps.length) {
    await env.DB.prepare("UPDATE admin_product_drafts SET step_index=?,draft_json=?,updated_at=? WHERE admin_id=? AND form_id=?")
      .bind(nextIndex,JSON.stringify(draft),now,String(chatId),formId).run();
    await askAdminProductField(env,chatId,formId,steps[nextIndex],draft[steps[nextIndex]],row.mode);
    return;
  }
  await env.DB.prepare("UPDATE admin_product_drafts SET step_index=?,draft_json=?,status='REVIEW',updated_at=? WHERE admin_id=? AND form_id=?")
    .bind(nextIndex,JSON.stringify(draft),now,String(chatId),formId).run();
  const summary = [
    "📋 PERIKSA DATA PRODUK",
    "SKU: " + draft.sku,
    "Nama: " + draft.name,
    "Harga: " + rupiah(draft.price),
    "Stok: " + (draft.stock == null ? "Tidak dibatasi" : draft.stock),
    "Status: " + (draft.active ? "Aktif" : "Nonaktif"),
    "Foto: " + (draft.photo_url ? "URL terpasang" : "Tidak ada"),
    "Deskripsi: " + (draft.description || "—"),
    "",
    "Simpan produk ini?"
  ].join("\n");
  await sendTelegram(env,chatId,summary,{
    inline_keyboard:[
      [{text:"✅ Simpan Produk",callback_data:"adm:productform:save:"+formId}],
      [{text:"✖️ Batal",callback_data:"adm:productform:cancel:"+formId}]
    ]
  });
}

async function handleAdminProductWizardConfirm(env, message, chatId, actorId, action, formId) {
  const row = await env.DB.prepare(
    "SELECT * FROM admin_product_drafts WHERE admin_id=? AND form_id=? AND status='REVIEW' AND expires_at>? LIMIT 1"
  ).bind(String(chatId),String(formId),new Date().toISOString()).first();
  if (!row) throw new Error("Formulir tidak ditemukan atau sudah kedaluwarsa.");
  if (action === "cancel") {
    await env.DB.prepare("DELETE FROM admin_product_drafts WHERE admin_id=? AND form_id=?")
      .bind(String(chatId),String(formId)).run();
    await updateTelegramMessage(env,message,{
      text:"✖️ Formulir produk dibatalkan. Tidak ada perubahan pada katalog.",
      replyMarkup:adminMenuKeyboard(),clearMedia:true
    });
    return;
  }
  if (action !== "save") throw new Error("Aksi formulir tidak dikenal.");
  const product = JSON.parse(row.draft_json || "{}");
  let result;
  try {
    result = await saveCatalogProduct(env,product,String(row.original_sku || ""));
  } catch (error) {
    await updateTelegramMessage(env,message,{
      text:"⚠️ Produk belum tersimpan: " + String(error.message || "Kesalahan validasi") +
        "\\nData formulir masih disimpan. Batalkan lalu mulai ulang bila perlu.",
      replyMarkup:{inline_keyboard:[
        [{text:"✖️ Batal",callback_data:"adm:productform:cancel:"+formId}]
      ]},
      clearMedia:true
    });
    return;
  }
  await recordAdminActivity(env,{
    actorId,
    action:result === "updated" ? "PRODUCT_UPDATED" : "PRODUCT_CREATED",
    resourceType:"product",
    resourceId:product.sku,
    summary:{sku:product.sku,name:String(product.name||"").slice(0,100),price:Number(product.price),stock:product.stock,active:Boolean(product.active)}
  });
  await env.DB.prepare("DELETE FROM admin_product_drafts WHERE admin_id=? AND form_id=?")
    .bind(String(chatId),String(formId)).run();
  await updateTelegramMessage(env,message,{
    text:"✅ Produk " + product.sku + (result === "updated" ? " berhasil diperbarui." : " berhasil ditambahkan.") +
      "\n\nKatalog pelanggan sudah membaca sumber data D1 yang sama. Gunakan Refresh Katalog untuk melihat perubahan.",
    replyMarkup:adminMenuKeyboard(),clearMedia:true
  });
}

async function saveCatalogProduct(env, product, originalSku = "") {
  const sku = String(product.sku || "").trim();
  const name = String(product.name || "").trim();
  const priceText = product.price == null ? "" : String(product.price).trim();
  const stockText = product.stock == null ? "" : String(product.stock).trim();
  const price = Number(priceText), stock = stockText === "" ? null : Number(stockText);
  const photo = String(product.photo_url || "").trim();
  const description = String(product.description || "").trim();

  if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new Error("SKU hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung (maksimal 40 karakter).");
  if (!name || name.length > 100) throw new Error("Nama produk wajib diisi (maksimal 100 karakter).");
  if (priceText === "" || !Number.isSafeInteger(price) || price < 0 ||
      (stock !== null && (!Number.isSafeInteger(stock) || stock < 0))) {
    throw new Error("Harga harus valid dan stok harus bilangan bulat nol atau lebih.");
  }
  if (typeof product.active !== "boolean") throw new Error("Status aktif harus boolean.");
  if (photo && (!/^https:\/\//i.test(photo) || photo.length > 1000)) throw new Error("URL foto harus berupa tautan HTTPS.");
  if (description.length > 500) throw new Error("Deskripsi maksimal 500 karakter.");

  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1 terlebih dahulu.");
  if (state.ready) {
    const result = await saveProductTransactional(env,{sku,name,price,stock,active:product.active,photo_url:photo,description},originalSku);
    const stored = await findProductTransactional(env,sku);
    await mirrorTransactionalProduct(env,stored);
    await invalidateStoreUiCaches(env);
    return result;
  }

  const rows = await readCatalogRows(env);
  const matches = rows.map((r, i) => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase() ? i : -1).filter(i => i >= 0);
  if (matches.length > 1) throw new Error("SKU duplikat ditemukan. Perbaiki katalog sebelum menyimpan.");
  const index = matches[0] ?? -1;
  const editing = Boolean(originalSku);
  if (editing && sku.toUpperCase() !== originalSku.toUpperCase()) throw new Error("SKU tidak boleh diubah saat mengedit produk.");
  if (editing && index < 0) throw new Error("Produk yang akan diedit tidak ditemukan.");
  if (!editing && index >= 0) throw new Error("SKU sudah digunakan. Gunakan SKU lain atau pilih Atur Produk.");

  const values = [[sku, name, price, stock, product.active, photo, description]];
  if (editing) {
    await updateSheetRange(env, "Katalog_Produk!A" + (index + 2) + ":G" + (index + 2), values);
    return "updated";
  }
  await appendSheetRows(env, "Katalog_Produk!A:G", values);
  return "created";
}

async function deleteCatalogProduct(env, sku) {
  const normalizedSku = String(sku || "").trim().toUpperCase();
  if (!normalizedSku) throw new Error("SKU produk tidak valid.");
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1 terlebih dahulu.");
  if (state.ready) {
    const result = await deleteProductTransactional(env,normalizedSku);
    const stored = await findProductTransactional(env,normalizedSku);
    await mirrorTransactionalProduct(env,stored);
    await invalidateStoreUiCaches(env);
    return result;
  }
  const rows = await readCatalogRows(env);
  const index = rows.findIndex(r => String(r[0] || "").trim().toUpperCase() === normalizedSku);
  if (index < 0) throw new Error("Produk tidak ditemukan. Muat ulang katalog admin lalu coba kembali.");
  const token = await getGoogleAccessToken(env);
  const meta = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + "?fields=sheets.properties", {
    headers: { Authorization: "Bearer " + token }
  });
  if (!meta.ok) throw new Error("Tidak dapat membaca metadata spreadsheet (" + meta.status + "): " + (await meta.text()).slice(0,400));
  const metadata = await meta.json();
  const sheet = (metadata.sheets || []).find(x => x.properties?.title === "Katalog_Produk");
  if (!sheet || sheet.properties?.sheetId == null) throw new Error("Tab Katalog_Produk tidak ditemukan atau sheetId tidak tersedia.");
  const rowIndex = index + 1;
  const response = await fetch(SHEETS_BASE + "/" + env.GOOGLE_SHEETS_ID + ":batchUpdate", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1
    } } }] })
  });
  if (!response.ok) throw new Error("Gagal menghapus produk (" + response.status + "): " + (await response.text()).slice(0,400));
  return { sku: normalizedSku, row: index + 2 };
}
async function sendVerifiedProductClaimToCustomer(env, customerId, orderRow, receiptCode, { proofFileId = "", proofType = "", actor = "auto" } = {}) {
  const orderId = String(orderRow?.[0] || "");
  const customerName = String(orderRow?.[4] || "Pelanggan");
  const product = String(orderRow?.[5] || "-");
  const quantity = Number(orderRow?.[6] || 1);
  const total = Number(orderRow?.[10] || 0);
  const paymentMethod = String(orderRow?.[11] || "QRIS");
  const [langPref, intlConfig] = await Promise.all([
    getUserLang(env, customerId),
    loadIntlPaymentConfig(env)
  ]);
  const lang = normalizeLang(langPref?.lang);
  const screen = renderVerifiedClaimScreen(
    {
      orderId,
      product,
      quantity,
      total,
      paymentMethod,
      receiptCode: String(receiptCode || orderRow?.[18] || "-"),
      config: intlConfig,
      lang
    },
    env
  );
  await clearPendingProofOrder(env, customerId);
  await sendTelegram(env, String(customerId), screen.text, screen.replyMarkup, { parseMode: screen.parseMode });

  const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  for (const adminId of admins) {
    try {
      const adminCaption = [
        "✅ <b>PEMBAYARAN TERVERIFIKASI — SIAP KLAIM PRODUK</b>",
        "━━━━━━━━━━━━━━━━━━━━━━",
        `• <b>Order:</b> <code>${escapeHtml(orderId)}</code>`,
        `• <b>Pembeli:</b> ${escapeHtml(customerName)} (<code>${escapeHtml(String(customerId))}</code>)`,
        `• <b>Produk:</b> ${escapeHtml(product)} × ${quantity}`,
        `• <b>Total:</b> <b>${escapeHtml(rupiah(total))}</b> (≈ ${convertIdrToUsdt(total, intlConfig.usd_exchange_rate)} USDT)`,
        `• <b>Metode:</b> ${escapeHtml(paymentMethod)}`,
        `• <b>Kode Klaim / Resi:</b> <code>${escapeHtml(String(receiptCode || orderRow?.[18] || "-"))}</code>`,
        `• <b>Verifikator:</b> <code>${escapeHtml(actor)}</code>`,
        "",
        "<blockquote>Pembeli telah diarahkan untuk menghubungi Admin guna menerima produk yang dibeli.</blockquote>"
      ].join("\n");
      const adminKeyboard = {
        inline_keyboard: [
          [{ text: "💬 Buka Chat Pembeli", url: "tg://user?id=" + encodeURIComponent(String(customerId)) }],
          [{ text: "✅ Tandai Selesai / Diambil", callback_data: "pickupdone:" + orderId, style: "success" }]
        ]
      };
      if (proofFileId && proofType === "PHOTO") {
        await sendTelegramPhoto(env, adminId, proofFileId, adminCaption, adminKeyboard, { parseMode: "HTML" });
      } else {
        await sendTelegram(env, adminId, adminCaption, adminKeyboard, { parseMode: "HTML" });
        if (proofFileId && proofType === "DOCUMENT") {
          await sendTelegramDocumentById(env, adminId, proofFileId, "Bukti pembayaran " + orderId);
        }
      }
    } catch (err) {
      console.warn(JSON.stringify({ level: "warn", event: "verified_claim_admin_notify_failed", order_id: orderId, message: String(err?.message || err).slice(0, 120) }));
    }
  }
}

async function handleClaimProductBot(env, ctx, query, orderId) {
  const message = query?.message || null;
  const chatId = String(message?.chat?.id || query?.from?.id || "");
  const userId = String(query?.from?.id || "");
  const callbackId = String(query?.id || "");
  const [found, langPref, intlConfig] = await Promise.all([
    findOrderById(env, orderId),
    getUserLang(env, userId),
    loadIntlPaymentConfig(env)
  ]);
  const lang = normalizeLang(langPref?.lang);
  const isEn = lang === "en";
  if (!found || String(found.row?.[3] || "") !== userId) {
    await answerTelegramCallback(env, callbackId, isEn ? "⚠️ Order not found for this account." : "⚠️ Pesanan tidak ditemukan untuk akun ini.", true);
    return;
  }
  const r = found.row;
  if (String(r[13] || "").toUpperCase() !== "DISETUJUI") {
    await answerTelegramCallback(env, callbackId, isEn ? "⏳ Payment is not verified yet. Send your payment screenshot first." : "⏳ Pembayaran belum terverifikasi. Kirim screenshot bukti bayar terlebih dahulu.", true);
    return;
  }
  await answerTelegramCallback(env, callbackId, isEn ? "✅ Admin has been notified!" : "✅ Admin telah diberi tahu!");
  const screen = renderVerifiedClaimScreen(
    {
      orderId: String(r[0]),
      product: String(r[5]),
      quantity: Number(r[6] || 1),
      total: Number(r[10] || 0),
      paymentMethod: String(r[11] || ""),
      receiptCode: String(r[18] || "-"),
      config: intlConfig,
      lang
    },
    env
  );
  await updateTelegramMessage(env, message, {
    text: screen.text,
    parseMode: screen.parseMode,
    replyMarkup: screen.replyMarkup,
    clearMedia: true
  });

  const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  for (const adminId of admins) {
    try {
      await sendTelegram(
        env,
        adminId,
        [
          "🔔 <b>PERMINTAAN KLAIM PRODUK (LUNAS)</b>",
          "━━━━━━━━━━━━━━━━━━━━━━",
          `• <b>Order:</b> <code>${escapeHtml(String(r[0]))}</code>`,
          `• <b>Pembeli:</b> ${escapeHtml(String(r[4] || "-"))} (<code>${escapeHtml(userId)}</code>)`,
          `• <b>Produk:</b> ${escapeHtml(String(r[5] || "-"))} × ${escapeHtml(String(r[6] || 1))}`,
          `• <b>Kode Resi:</b> <code>${escapeHtml(String(r[18] || "-"))}</code>`,
          "",
          "Pembeli menekan tombol klaim produk. Silakan kirim produk/layanan ke pembeli."
        ].join("\n"),
        {
          inline_keyboard: [
            [{ text: "💬 Chat Pembeli Sekarang", url: "tg://user?id=" + encodeURIComponent(userId) }],
            [{ text: "✅ Tandai Selesai / Diambil", callback_data: "pickupdone:" + String(r[0]), style: "success" }]
          ]
        },
        { parseMode: "HTML" }
      );
    } catch {}
  }
}

async function deliverOrderCheckout(env, ctx, message, chatId, method, result, userId = "") {
  const targetUser = String(userId || result?.customerId || chatId);
  runBackground(ctx, setPendingProofOrder(env, targetUser, result.orderId), "ui_set_pending_proof_order");
  const upperMethod = String(method || "").toUpperCase();
  if (upperMethod === "QRIS") {
    runBackground(ctx, deleteTelegramMessage(env, message), "ui_delete_checkout_before_qris");
    try {
      await sendQrisPaymentScreen(env, chatId, result, targetUser);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "qris_charge_or_delivery_failed", order_id: result.orderId, message: String(error?.message || "QRIS_FAILED").slice(0, 160) }));
      for (const adminId of String(env.ADMIN_CHAT_ID || "").split(",").map(value => value.trim()).filter(Boolean)) {
        try {
          await sendTelegram(env, adminId, "⚠️ QRIS untuk order " + result.orderId + " gagal dibuat/dikirim. Periksa konfigurasi payload QRIS internal dan bukti pembayaran sebelum membatalkan order.");
        } catch (notifyErr) {
          console.warn(JSON.stringify({ level: "warn", event: "qris_admin_notify_failed", order_id: result.orderId, message: String(notifyErr?.message || notifyErr).slice(0, 120) }));
        }
      }
      await sendTelegram(env, chatId,
        "⚠️ Kode QRIS belum dapat ditampilkan untuk order " + result.orderId + ". Jangan lakukan pembayaran dari kode lain. Pesanan belum dibatalkan; hubungi admin Seiton.id untuk pemeriksaan sebelum mencoba kembali.");
    }
    return;
  }
  if (["USDT", "PAYPAL", "STARS", "TRANSFER"].includes(upperMethod)) {
    const [langPref, intlConfig, payConfig] = await Promise.all([
      getUserLang(env, targetUser),
      loadIntlPaymentConfig(env),
      loadPaymentMethodConfiguration(env).catch(() => ({ bank_accounts: [] }))
    ]);
    const screen = renderIntlPaymentInstructionsScreen({
      order: result,
      method: upperMethod,
      config: intlConfig,
      bankAccounts: payConfig.bank_accounts || [],
      lang: normalizeLang(langPref?.lang)
    });
    await updateTelegramMessage(env, message, {
      text: screen.text,
      parseMode: screen.parseMode,
      replyMarkup: screen.replyMarkup,
      clearMedia: true
    });
    return;
  }
  await updateTelegramMessage(env, message, {
    text: await orderConfirmationWithPaymentInstructions(env, result),
    replyMarkup: orderConfirmationKeyboard(result),
    clearMedia: true
  });
}

async function handleTelegramCallback(env, query, ctx = null) {
  const message = query.message || null;
  const chatId = String(message?.chat?.id || query.from?.id || "");
  const userId = String(query.from?.id || "");
  const data = String(query.data || "");
  const admin = isAdmin(userId, env);

  const handledHybrid = await handleCustomerHybridCallback(env, ctx, query, {
    isAdmin,
    readTelegramCatalogRows,
    getAvailablePaymentMethods,
    createOrder,
    deliverOrderCheckout,
    handleClaimProductBot
  });
  if (handledHybrid) return;

  await answerTelegramCallback(env, query.id);

  if (data.startsWith("hf:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, {
        text: "⛔ Tombol antrean bantuan khusus admin.",
        replyMarkup: null,
        clearMedia: true
      });
      return;
    }
    const parts = data.split(":");
    const action = parts[1];
    const handoffId = parts.slice(2).join(":");
    if (!["take", "done", "decline"].includes(action) || !handoffId) {
      await showTelegramHandoffQueue(env, message, chatId, "⚠️ Tombol tidak valid. Perbarui antrean.");
      return;
    }

    if (!(await messagingHandoffSchemaReady(env))) {
      await showTelegramHandoffQueue(env, message, chatId, "⚠️ Fitur bantuan belum aktif.");
      return;
    }

    let result;
    try {
      if (action === "take") {
        result = await claimMessagingHandoff(env, handoffId, chatId);
      } else if (action === "done") {
        result = await resolveMessagingHandoff(env, handoffId, chatId);
      } else {
        result = await declineMessagingHandoff(env, handoffId, chatId);
      }
    } catch (error) {
      console.error(JSON.stringify({level:"error",event:"telegram_handoff_action",message:error.message}));
      await showTelegramHandoffQueue(env, message, chatId, "⚠️ Aksi tidak berhasil. Coba perbarui antrean.");
      return;
    }

    if (result.ok && !result.alreadyClosed && !(action === "take" && result.alreadyClaimed)) {
      const actions = { take: "HANDOFF_CLAIMED", done: "HANDOFF_RESOLVED", decline: "HANDOFF_DECLINED" };
      await recordAdminActivity(env, { actorId: userId, action: actions[action], resourceType: "support_handoff", resourceId: handoffId, summary: { handoff_id: handoffId, resolution: action === "decline" ? "DECLINED" : action === "done" ? "RESOLVED" : null } });
    }
    if (result.ok) {
      if (action === "decline" && result.noticeQueued) {
        await dispatchTelegramMessagingOutbox(env, 50);
      }
      let notice;
      if (result.alreadyClosed) {
        notice = result.resolution === "DECLINED"
          ? "ℹ️ Permintaan bantuan ini sudah ditolak sebelumnya."
          : "ℹ️ Permintaan bantuan ini sudah diselesaikan sebelumnya.";
      } else if (action === "take") {
        notice = result.alreadyClaimed
          ? "ℹ️ Kasus ini sudah Anda ambil."
          : "✅ Kasus berhasil Anda terima. Anda sekarang menjadi admin penanggung jawab.";
      } else if (action === "done") {
        notice = result.automationResumed
          ? "✅ Bantuan selesai. Bot otomatis aktif kembali untuk pelanggan."
          : result.conversationMode === "OPTED_OUT"
            ? "✅ Bantuan selesai. Preferensi STOP pelanggan tetap berlaku."
            : "✅ Kasus diselesaikan, tetapi percakapan masih memiliki permintaan bantuan lain.";
      } else {
        notice = result.conversationMode === "OPTED_OUT"
          ? "❌ Permintaan ditolak. Pelanggan diberi tahu; preferensi STOP tetap berlaku sehingga balasan otomatis tetap nonaktif."
          : result.automationResumed
            ? "❌ Permintaan ditolak. Pelanggan diberi tahu dan bot otomatis diaktifkan kembali."
            : "❌ Permintaan ditolak. Pelanggan diberi tahu; bot tetap dijeda karena masih ada kasus aktif lain.";
      }
      await showTelegramHandoffQueue(env, message, chatId, notice);
      return;
    }

    const reason = {
      NOT_FOUND: "Kasus tidak ditemukan.",
      CLOSED: "Kasus sudah ditutup.",
      ALREADY_CLAIMED: "Kasus sudah diterima admin lain dan tidak dapat ditolak.",
      NOT_CLAIMED: "Terima kasus terlebih dahulu.",
      CLAIMED_BY_OTHER: "Kasus sedang ditangani admin lain: " + (result.handoff?.claimed_by || "-"),
      CONFLICT: "Status kasus berubah. Perbarui antrean."
    };
    await showTelegramHandoffQueue(env, message, chatId,
      "⚠️ " + (reason[result.reason] || "Aksi tidak dapat dilakukan."));
    return;
  }

  if (data === "nav:home" || data === "adm:home") {
    const showAdmin = data === "adm:home" && admin;
    if (showAdmin) {
      const home = renderAdminHomeScreen();
      await updateTelegramMessage(env, message, {
        text: home.text,
        parseMode: home.parseMode,
        replyMarkup: home.replyMarkup,
        clearMedia: true
      });
      return;
    }
    await deleteTelegramMessage(env, message);
    await sendSeitonWelcome(env, chatId, false);
    return;
  }

  if (data === "nav:catalog" || data === "nav:refresh") {
    await showCustomerCategoryMenu(env, message);
    return;
  }

  if (data.startsWith("cat:items:")) {
    const parts = data.split(":");
    await showCustomerCatalogPage(env, message, Number(parts[3] || 0), parts[2] || "all");
    return;
  }

  // Keep old catalog buttons working after the storefront redesign.
  if (data.startsWith("cat:page:")) {
    await showCustomerCatalogPage(env, message, Number(data.slice("cat:page:".length)), "all");
    return;
  }

  if (data.startsWith("buy:") || data.startsWith("view:")) {
    const sku = data.startsWith("view:") ? data.slice(5) : data.slice(4);
    const rows = await readTelegramCatalogRows(env);
    const p = rows.find(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
    if (!p) throw new Error("Produk tidak ditemukan atau sudah tidak tersedia.");
    const product = parseCatalogProduct(p);
    if (!product.active || !product.priceValid || !product.stockValid) throw new Error("Produk tidak tersedia. Refresh katalog.");
    const category = customerCategoryForProduct(p);
    const visibleProducts = customerCatalogProducts(rows).filter(row => customerCategoryForProduct(row) === category);
    const index = visibleProducts.findIndex(row => String(row[0] || "").toUpperCase() === product.sku.toUpperCase());
    const page = index < 0 ? 0 : Math.floor(index / CUSTOMER_CATALOG_PAGE_SIZE);
    const canBuy = product.stock === null || product.stock > 0;
    const quantityButtons = canBuy
      ? [1,2,3,5].filter(q => product.stock === null || product.stock >= q)
        .map(q => ({ text: q + " pcs", callback_data: "qty:" + product.sku + ":" + q }))
      : [];
    const detail = [
      "📦 DETAIL PRODUK",
      product.name,
      "Harga: " + rupiah(product.price),
      "Stok: " + (product.stock === null ? "Tidak dibatasi" : product.stock === 0 ? "Habis" : product.stock + " tersedia"),
      product.description,
      canBuy ? "Pilih jumlah:" : "Stok habis. Produk belum dapat dipesan."
    ].filter(Boolean).join("\n");
    await updateTelegramMessage(env, message, {
      text: detail,
      photo: p[5] && /^https:\/\//i.test(String(p[5])) ? String(p[5]) : null,
      clearMedia: !(p[5] && /^https:\/\//i.test(String(p[5]))),
      replyMarkup: { inline_keyboard: [
        ...(quantityButtons.length ? [quantityButtons] : []),
        [{ text: "⬅️ Kembali ke Kategori", callback_data: "cat:items:" + category + ":" + page }],
        [{ text: "🗂️ Semua Kategori", callback_data: "nav:catalog" }]
      ] }
    });
    return;
  }

  if (data.startsWith("qty:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new Error("Jumlah tidak valid");
    const paymentMethods = [];
    const availableMethods = await getAvailablePaymentMethods(env);
    const qrisMode = getQrisCheckoutMode(env);
    if (availableMethods.includes("QRIS")) {
      paymentMethods.push([{
        text: qrisMode === "DYNAMIC" ? "⚡ QRIS Dinamis" : "📷 QRIS (Nominal Manual)",
        callback_data: "pay:" + sku + ":" + qty + ":QRIS"
      }]);
    }
    if (availableMethods.includes("TRANSFER")) {
      paymentMethods.push([{ text: "🏦 Transfer Bank", callback_data: "pay:" + sku + ":" + qty + ":TRANSFER" }]);
    }
    if (availableMethods.includes("COD")) {
      paymentMethods.push([{ text: "💵 COD", callback_data: "pay:" + sku + ":" + qty + ":COD" }]);
    }
    if (!paymentMethods.length) throw new Error("Belum ada metode pembayaran yang aktif. Hubungi admin Seiton.id.");
    paymentMethods.push([{ text: "⬅️ Kembali", callback_data: "buy:" + sku }]);
    await updateTelegramMessage(env, message, {
      text: "Jumlah dipilih: " + qty + "\nPilih metode pembayaran:",
      replyMarkup: { inline_keyboard: paymentMethods }
    });
    return;
  }

  if (data.startsWith("pay:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]); const method = parts[3];
    if (!["QRIS","TRANSFER","COD"].includes(method)) throw new Error("Metode pembayaran tidak valid");
    const availableMethods = await getAvailablePaymentMethods(env);
    if (!availableMethods.includes(method)) throw new Error("Metode pembayaran tersebut baru saja dinonaktifkan atau belum dikonfigurasi admin. Pilih metode lain.");
    const rows = await readTelegramCatalogRows(env, "Katalog_Produk!A2:G");
    const p = rows.find(r => String(r[0] || "").trim().toUpperCase() === sku.toUpperCase());
    if (!p) throw new Error("Produk tidak ditemukan");
    await updateTelegramMessage(env, message, {
      text: "Konfirmasi pesanan\n\nProduk: " + (p[1] || sku) + "\nJumlah: " + qty + "\nHarga satuan: " + rupiah(p[2]) + "\nTotal: " + rupiah(Number(p[2]) * qty) + "\nPembayaran: " + method + "\n\nLanjutkan membuat pesanan?",
      replyMarkup: { inline_keyboard: [
        [{ text: "✅ Ya, buat pesanan", callback_data: "ok:" + sku + ":" + qty + ":" + method }],
        [{ text: "⬅️ Ubah jumlah", callback_data: "buy:" + sku }],
        [{ text: "🏠 Batal", callback_data: "nav:home" }]
      ] }
    });
    return;
  }

  if (data.startsWith("ok:")) {
    const parts = data.split(":"); const sku = parts[1]; const qty = Number(parts[2]); const method = parts[3];
    const result = await createOrder(env, { sku: sku.toUpperCase(), quantity: qty, paymentMethod: method,
      channel: "telegram", customerId: userId, customerName: [query.from.first_name, query.from.last_name].filter(Boolean).join(" "),
      idempotencyKey: ["telegram", userId, chatId, String(message?.message_id || query.id || ""), sku.toUpperCase(), String(qty), method].join(":") });
    if (String(method).toUpperCase() === "QRIS") {
      await deleteTelegramMessage(env, message);
      try {
        await sendQrisPaymentScreen(env, chatId, result);
      } catch (error) {
        console.error(JSON.stringify({level:"error",event:"qris_charge_or_delivery_failed",order_id:result.orderId,message:String(error?.message||"QRIS_FAILED").slice(0,160)}));
        for (const adminId of String(env.ADMIN_CHAT_ID || "").split(",").map(value=>value.trim()).filter(Boolean)) {
          try { await sendTelegram(env, adminId, "⚠️ QRIS untuk order " + result.orderId + " gagal dibuat/dikirim. Periksa konfigurasi payload QRIS internal dan bukti pembayaran sebelum membatalkan order."); } catch {}
        }
        await sendTelegram(env, chatId,
          "⚠️ Kode QRIS belum dapat ditampilkan untuk order " + result.orderId + ". Jangan lakukan pembayaran dari kode lain. Pesanan belum dibatalkan; hubungi admin Seiton.id untuk pemeriksaan sebelum mencoba kembali.");
      }
      return;
    }
    await updateTelegramMessage(env, message, {
      text: await orderConfirmationWithPaymentInstructions(env, result),
      replyMarkup: orderConfirmationKeyboard(result)
    });
    return;
  }

  if (data === "nav:orders") {
    const state = await transactionReadiness(env);
    if (!state.ready) await ensurePaymentWorkflowHeaders(env);
    const rows = state.ready
      ? (await listOrdersTransactional(env,{limit:5000})).map(orderToSheetRow)
      : await readSheet(env, "Pesanan!A2:T");
    const mine = (state.ready ? rows : rows.filter(r => String(r[3] || "") === userId).slice(-5).reverse())
      .filter(r => String(r[3] || "") === userId).slice(0,5);
    const lines = mine.map(r => String(r[0]) + " | " + String(r[5]) + " | " + String(r[6]) + " pcs | " + rupiah(r[10]) + " | " + String(r[12]) +
      (String(r[13] || "") === "MENUNGGU_VERIFIKASI" ? " · MENUNGGU VERIFIKASI" : String(r[13] || "") === "DISETUJUI" ? " · PEMBAYARAN TERVERIFIKASI" : ""));
    const buttons = [];
    for (const r of mine) {
      const orderId = String(r[0] || "");
      if (String(r[13] || "") === "DISETUJUI" && r[18]) {
        buttons.push([{ text: "🎟️ Lihat Resi " + orderId.slice(-8), callback_data: "ticket:" + orderId }]);
      } else if (String(r[13] || "") === "MENUNGGU_VERIFIKASI") {
        buttons.push([{ text: "📎 Kirim / Perbarui Bukti " + orderId.slice(-8), callback_data: "pc:req:" + orderId }]);
      } else if (String(r[12] || "") === "MENUNGGU_PEMBAYARAN" && String(r[11] || "").toUpperCase() === "QRIS" && isQrisCheckoutAvailable(env)) {
        buttons.push([{ text: "📲 Tampilkan QR " + orderId.slice(-8), callback_data: "qris:show:" + orderId }]);
        buttons.push([{ text: "⚡ Periksa QRIS " + orderId.slice(-8), callback_data: "qris:check:" + orderId }]);
      } else if (String(r[12] || "") === "MENUNGGU_PEMBAYARAN" && String(r[11] || "").toUpperCase() !== "COD") {
        buttons.push([{ text: "💳 Konfirmasi Bayar " + orderId.slice(-8), callback_data: "pc:req:" + orderId }]);
      }
    }
    buttons.push(...customerMenuKeyboard().inline_keyboard);
    await updateTelegramMessage(env, message, {
      text: mine.length ? "Lima pesanan terakhir:\n\n" + lines.join("\n") : "Belum ada pesanan atas akun Telegram ini.",
      replyMarkup: { inline_keyboard: buttons },
      clearMedia: true
    });
    return;
  }

  if (data === "nav:guide") {
    await updateTelegramMessage(env, message, {
      text: [
        "🧭 CARA BELANJA DI SEITON.ID",
        "",
        "1. Buka Katalog Produk dan pilih kategori.",
        "2. Pilih produk untuk melihat foto, harga, dan stok.",
        "3. Tentukan jumlah serta metode pembayaran.",
        "4. Periksa ringkasan pesanan sebelum membuat order.",
        "5. Ikuti instruksi pembayaran dan pantau status di Pesanan Saya.",
        "",
        "Anda cukup menggunakan tombol, tidak perlu mengetik format order."
      ].join("\n"),
      replyMarkup: { inline_keyboard: [
        [
          { text: "🛍️ Buka Katalog", callback_data: "nav:catalog" },
          { text: "📦 Pesanan Saya", callback_data: "nav:orders" }
        ],
        [{ text: "🏠 Menu Utama", callback_data: "nav:home" }]
      ] },
      clearMedia: true
    });
    return;
  }

  if (data === "nav:help") {
    await updateTelegramMessage(env, message, {
      text: [
        "💬 BANTUAN SEITON.ID",
        "",
        "Katalog Produk untuk berbelanja, Pesanan Saya untuk memeriksa status pembayaran/resi.",
        "Untuk kendala transaksi, hubungi admin Seiton.id."
      ].join("\n"),
      replyMarkup: { inline_keyboard: [
        [
          { text: "🛍️ Katalog Produk", callback_data: "nav:catalog" },
          { text: "📦 Pesanan Saya", callback_data: "nav:orders" }
        ],
        [{ text: "🧭 Cara Belanja", callback_data: "nav:guide" }],
        [{ text: "🏠 Menu Utama", callback_data: "nav:home" }]
      ] },
      clearMedia: true
    });
    return;
  }

  if (data.startsWith("adm:productform:")) {
    if (!admin) {
      await updateTelegramMessage(env,message,{text:"⛔ Formulir ini khusus admin.",replyMarkup:null});
      return;
    }
    const parts = data.split(":");
    const action = parts[2];
    const formId = parts.slice(3).join(":");
    await handleAdminProductWizardConfirm(env,message,chatId,userId,action,formId);
    return;
  }

  if (data.startsWith("adm:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: customerMenuKeyboard() });
      return;
    }
    const action = data.slice(4);
    if (action === "orders" || action === "products" || action === "reports" || action === "support") {
      const screen = renderAdminSubmenuScreen(action);
      await updateTelegramMessage(env, message, {
        text: screen.text,
        parseMode: screen.parseMode,
        replyMarkup: screen.replyMarkup,
        clearMedia: true
      });
      return;
    }
    if (action === "handoff") {
      await showTelegramHandoffQueue(env, message, chatId);
      return;
    }
    if (action === "report") {
      const state = await transactionReadiness(env);
      const d1Orders = state.ready ? await listOrdersTransactional(env, { limit: 5000 }) : null;
      const report = await buildAdminReport(env, d1Orders);
      await recordAdminActivity(env, { actorId: userId, action: "REPORT_GENERATED", resourceType: "sales_report", summary: { report_type: "sales_summary" } });
      await updateTelegramMessage(env, message, { text: report, parseMode: "HTML", replyMarkup: adminMenuKeyboard(), clearMedia: true });
      return;
    }
    if (action === "paymentchecks" || action.startsWith("paymentchecks:")) {
      const page = action.startsWith("paymentchecks:") ? Number(action.slice("paymentchecks:".length)) : 0;
      await showPaymentRequestsPage(env, message, page);
      return;
    }
    if (action === "pickup") {
      await showPickupQueuePage(env, message, 0);
      return;
    }
    if (action === "dashboard") {
      const accessToken = await createDashboardAccessToken(env, chatId);
      await recordAdminActivity(env, { actorId: userId, action: "DASHBOARD_LINK_ISSUED", resourceType: "admin_dashboard", summary: { lifetime_minutes: 240 } });
      const link = "https://admin.seiton.biz.id/#access=" + encodeURIComponent(accessToken);
      const screen = renderAdminDashboardLinkScreen(link);
      await updateTelegramMessage(env, message, {
        text: screen.text,
        parseMode: screen.parseMode,
        clearMedia: true,
        replyMarkup: screen.replyMarkup
      });
      return;
    }
    if (action === "exports") {
      const screen = renderAdminExportsScreen();
      await updateTelegramMessage(env, message, {
        text: screen.text,
        parseMode: screen.parseMode,
        clearMedia: true,
        replyMarkup: screen.replyMarkup
      });
      return;
    }
    if (action === "addproduct") {
      await deleteTelegramMessage(env, message);
      await ensureCatalogHeaders(env);
      await promptAdminProduct(env, chatId, "ADD");
      return;
    }
    if (action === "catalog" || action.startsWith("catalog:")) {
      await ensureCatalogHeaders(env);
      const page = action.startsWith("catalog:") ? Number(action.slice("catalog:".length)) : 0;
      await showAdminCatalogPage(env, message, page);
      return;
    }
    if (action === "recent" || action === "statuslist") {
      const state = await transactionReadiness(env);
      const recent = state.ready
        ? (await listOrdersTransactional(env,{limit:10})).map(o => ({r:orderToSheetRow(o),reference:o.order_id}))
        : (await readSheet(env, "Pesanan!A2:M")).map((r,i) => ({r,reference:String(i+2)})).filter(x => x.r[0]).slice(-10).reverse();
      const screen = renderAdminRecentOrdersScreen(recent, action);
      await updateTelegramMessage(env, message, {
        text: screen.text,
        parseMode: screen.parseMode,
        replyMarkup: screen.replyMarkup,
        clearMedia: true
      });
      return;
    }
  }

  if (data.startsWith("prod:edit:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    await deleteTelegramMessage(env, message);
    await promptAdminProduct(env, chatId, "EDIT", data.slice("prod:edit:".length));
    return;
  }

  if (data.startsWith("prod:delete:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const sku = data.slice("prod:delete:".length);
    const screen = renderAdminDeleteConfirmScreen(sku);
    await updateTelegramMessage(env, message, {
      text: screen.text,
      parseMode: screen.parseMode,
      replyMarkup: screen.replyMarkup,
      clearMedia: true
    });
    return;
  }

  if (data.startsWith("prod:delok:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const deletedSku = data.slice("prod:delok:".length);
    await deleteCatalogProduct(env, deletedSku);
    await recordAdminActivity(env, { actorId: userId, action: "PRODUCT_DELETED", resourceType: "product", resourceId: deletedSku, summary: { sku: deletedSku } });
    await updateTelegramMessage(env, message, { text: "✅ Produk berhasil dihapus dari katalog.", replyMarkup: adminMenuKeyboard() });
    return;
  }

  if (data.startsWith("exp:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const kind = data.slice(4);
    const allowed = ["orders", "finance", "daily", "inventory", "all"];
    if (!allowed.includes(kind)) throw new Error("Jenis laporan tidak dikenal");
    await updateTelegramMessage(env, message, { text: "⏳ Sedang menyiapkan file laporan dari Google Sheets…", replyMarkup: null });
    const reports = await buildReportExports(env);
    const types = kind === "all" ? ["orders", "finance", "daily", "inventory"] : [kind];
    for (const type of types) {
      await sendTelegramDocument(env, chatId, reports[type].csv, reports[type].filename, reports[type].caption);
    }
    await recordAdminActivity(env, { actorId: userId, action: "REPORT_EXPORT_SENT", resourceType: "sales_export", summary: { report_types: types } });
    await updateTelegramMessage(env, message, { text: "✅ Laporan selesai dikirim.", replyMarkup: adminMenuKeyboard() });
    return;
  }

  if (data.startsWith("qris:show:")) {
    await handleQrisPaymentShow(env, message, chatId, userId, data.slice("qris:show:".length));
    return;
  }

  if (data.startsWith("qris:check:")) {
    await handleQrisStatusCheck(env, message, chatId, userId, data.slice("qris:check:".length));
    return;
  }

  if (data.startsWith("pc:req:")) {
    await requestPaymentVerification(env, message, chatId, userId, data.slice("pc:req:".length));
    return;
  }

  if (data.startsWith("ticket:")) {
    const orderId = data.slice("ticket:".length);
    await ensurePaymentWorkflowHeaders(env);
    const found = await findOrderById(env, orderId);
    if (!found || String(found.row[3] || "") !== userId) throw new Error("Resi tidak ditemukan untuk akun Telegram ini.");
    if (String(found.row[13] || "") !== "DISETUJUI" || !found.row[18] || !PAID_ORDER_STATUSES.includes(String(found.row[12] || "").toUpperCase())) throw new Error("Pembayaran belum disetujui admin atau pesanan sudah dibatalkan.");
    await sendPickupReceipt(env, userId, found.row, orderId, String(found.row[18]));
    await updateTelegramMessage(env, message, { text: "🎟️ Resi pengambilan dikirim kembali.", replyMarkup: customerMenuKeyboard(), clearMedia: true });
    return;
  }

  if (data.startsWith("paylist:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    await showPaymentRequestsPage(env, message, Number(data.slice("paylist:".length)));
    return;
  }
  if (data.startsWith("picklist:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    await showPickupQueuePage(env, message, Number(data.slice("picklist:".length)));
    return;
  }
  if (data.startsWith("payview:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    await showPaymentRequestDetail(env, message, data.slice("payview:".length));
    return;
  }
  if (data.startsWith("payapprove:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const reference = data.slice("payapprove:".length);
    const approved = await approvePaymentAndIssueTicket(env, reference, "telegram:" + (userId || chatId));
    if (approved.alreadyApproved) {
      await updateTelegramMessage(env, message, {
        text: "ℹ️ Pembayaran " + approved.row[0] + " sudah disetujui sebelumnya. Tidak ada persetujuan atau pengiriman resi kedua.",
        replyMarkup: adminMenuKeyboard(),
        clearMedia: true
      });
      return;
    }
    let receiptSent = true;
    try { await sendPickupReceipt(env, String(approved.row[3]), approved.row, String(approved.row[0]), approved.receiptCode); }
    catch(error) {
      receiptSent = false;
      console.error(JSON.stringify({level:"error",event:"telegram_receipt_delivery",order_id:approved.row[0],message:error.message}));
    }
    try {
      await sendVerifiedProductClaimToCustomer(env, String(approved.row[3]), approved.row, approved.receiptCode, {
        proofFileId: String(approved.row[14] || ""),
        proofType: String(approved.row[15] || ""),
        actor: "telegram:" + (userId || chatId)
      });
    } catch (claimErr) {
      console.warn(JSON.stringify({ level: "warn", event: "verified_claim_notice_failed", order_id: approved.row[0], message: String(claimErr?.message || claimErr).slice(0, 120) }));
    }
    let digitalStatus = "";
    try {
      const delivered = await deliverDigitalProductAfterPayment(env, String(approved.row[0]));
      if (delivered.handled) digitalStatus = delivered.status === "DELIVERED"
        ? " Kredensial digital telah dikirim."
        : delivered.status === "WAITING_STOCK"
          ? " Produk digital masuk antrean stok dan admin telah diberi tahu."
          : delivered.status === "SETUP_PENDING"
            ? " Admin akan menghubungi pelanggan untuk proses setup."
            : delivered.status === "ALREADY_DELIVERED" ? " Produk digital sudah pernah dikirim." : "";
    } catch(error) {
      digitalStatus = " Pengiriman digital tertahan; admin perlu memeriksa konfigurasi.";
      console.error(JSON.stringify({level:"error",event:"digital_fulfillment_after_approval",order_id:approved.row[0],code:String(error?.message||"DIGITAL_FULFILLMENT_FAILED").slice(0,80)}));
      for (const target of String(env.ADMIN_CHAT_ID || "").split(",").map(v=>v.trim()).filter(Boolean)) {
        try { await sendTelegram(env,target,"⚠️ Pengiriman produk digital tertahan. Order: "+approved.row[0]+". Periksa binding OTP_KV, MUSE_STOCK_ENCRYPTION_KEY, dan status fulfillment."); } catch {}
      }
    }
    await updateTelegramMessage(env, message, {
      text: "✅ Pembayaran " + approved.row[0] + " berhasil disetujui. " + (receiptSent ? "Resi dan QR pengambilan sudah dikirim." : "Resi tersimpan, tetapi QR gagal dikirim. Pelanggan dapat meminta resi ulang lewat Pesanan Saya.") + digitalStatus,
      replyMarkup: { inline_keyboard: [
        [{ text: "📦 Lihat Antrean Pengambilan", callback_data: "adm:pickup" }],
        [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
      ] },
      clearMedia: true
    });
    return;
  }
  if (data.startsWith("payreject:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const reference = data.slice("payreject:".length);
    const rejected = await rejectPaymentRequest(env, reference, "telegram:" + (userId || chatId));
    await sendTelegram(env, String(rejected[3]), "⚠️ Permintaan verifikasi pembayaran untuk " + rejected[0] + " belum dapat disetujui. Periksa kembali nominal/bukti pembayaran dan ajukan ulang setelah benar.", {
      inline_keyboard: [[{ text: "🔁 Ajukan Verifikasi Ulang", callback_data: "pc:req:" + rejected[0] }]]
    });
    await updateTelegramMessage(env, message, {
      text: "❌ Permintaan pembayaran " + rejected[0] + " ditolak. Pelanggan sudah diberi tahu agar dapat mengajukan ulang.",
      replyMarkup: adminMenuKeyboard(),
      clearMedia: true
    });
    return;
  }
  if (data.startsWith("pickupview:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    await showPickupOrderDetail(env, message, data.slice("pickupview:".length));
    return;
  }
  if (data.startsWith("pickupdone:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const reference = data.slice("pickupdone:".length);
    const order = await markOrderPickedUp(env, reference, "telegram:" + (userId || chatId));
    try { await sendTelegram(env, String(order[3]), "✅ Pengambilan pesanan " + order[0] + " telah dicatat. Terima kasih sudah berbelanja di Seiton.id!"); } catch {}
    await updateTelegramMessage(env, message, {
      text: "✅ Pesanan " + order[0] + " berhasil ditandai SUDAH DIAMBIL.",
      replyMarkup: { inline_keyboard: [
        [{ text: "📦 Antrean Pengambilan", callback_data: "adm:pickup" }],
        [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
      ] },
      clearMedia: true
    });
    return;
  }

  if (data.startsWith("detail:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const reference = data.slice("detail:".length);
    const found = await resolveOrderReference(env,reference);
    const r = found?.row;
    if (!r) throw new Error("Pesanan tidak ditemukan");
    const screen = renderAdminOrderDetailScreen(r, reference);
    await updateTelegramMessage(env, message, {
      text: screen.text,
      parseMode: screen.parseMode,
      replyMarkup: screen.replyMarkup,
      clearMedia: true
    });
    return;
  }

  if (data.startsWith("st:")) {
    if (!admin) {
      await updateTelegramMessage(env, message, { text: "⛔ Menu ini khusus admin.", replyMarkup: null });
      return;
    }
    const reference = data.slice("st:".length);
    await updateTelegramMessage(env, message, {
      text: "Pilih status baru:",
      replyMarkup: { inline_keyboard: [
        [{ text: "Menunggu Pembayaran", callback_data: "su:" + reference + ":MENUNGGU_PEMBAYARAN" }],
        [{ text: "Dibayar", callback_data: "su:" + reference + ":DIBAYAR" }],
        [{ text: "Diproses", callback_data: "su:" + reference + ":DIPROSES" }],
        [{ text: "Dikirim", callback_data: "su:" + reference + ":DIKIRIM" }],
        [{ text: "Selesai", callback_data: "su:" + reference + ":SELESAI" }],
        [{ text: "Dibatalkan", callback_data: "su:" + reference + ":DIBATALKAN" }],
        [{ text: "⬅️ Kembali", callback_data: "detail:" + reference }]
      ] }
    });
    return;
  }

  if (data.startsWith("su:")) {
    if (!admin) throw new Error("Menu ini khusus admin.");
    const parts = data.split(":"); const reference = parts[1]; const status = parts[2];
    const allowed = ["MENUNGGU_PEMBAYARAN","MENUNGGU_VERIFIKASI","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"];
    if (!reference || !allowed.includes(status)) throw new Error("Pembaruan status tidak valid");
    await setOrderStatus(env, reference, status, "telegram:" + (userId || chatId));
    await updateTelegramMessage(env, message, {
      text: "✅ Status pesanan berhasil diperbarui menjadi " + status + ".",
      replyMarkup: adminMenuKeyboard()
    });
    return;
  }
  await updateTelegramMessage(env, message, {
    text: admin ? adminMenuText() : customerMenuText(),
    replyMarkup: admin ? adminMenuKeyboard() : customerMenuKeyboard()
  });
}

async function readTelegramCatalogRows(env, range = "Katalog_Produk!A2:G") {
  const rows = await readCatalogRows(env, range);
  const state = await transactionReadiness(env);
  if (!state.ready) return rows;
  const digital = await listProductsTransactional(env, true);
  const extras = (digital || [])
    .filter(product => Boolean(product.active) && /^(MUSE-STARTER|MUSE-BISNIS|OTP-SETUP)$/i.test(String(product.sku || "")))
    .map(product => [
      String(product.sku || ""),
      String(product.name || ""),
      String(product.price ?? 0),
      product.stock == null ? "" : String(product.stock),
      product.active ? "TRUE" : "FALSE",
      String(product.photo_url || ""),
      String(product.description || "")
    ]);
  const seen = new Set(rows.map(row => String(row[0] || "").trim().toUpperCase()));
  return rows.concat(extras.filter(row => !seen.has(String(row[0]).toUpperCase())));
}

async function showCustomerCategoryMenu(env, message) {
  const products = customerCatalogProducts(await readTelegramCatalogRows(env));
  if (!products.length) {
    await updateTelegramMessage(env, message, {
      text: "🛍️ KATALOG SEITON.ID\n\nBelum ada produk yang dapat ditampilkan.",
      replyMarkup: { inline_keyboard: [
        [{ text: "📦 Pesanan Saya", callback_data: "nav:orders" }],
        [{ text: "🏠 Menu Utama", callback_data: "nav:home" }]
      ] },
      clearMedia: true
    });
    return;
  }
  const counts = new Map();
  let availableCount = 0;
  for (const row of products) {
    const category = customerCategoryForProduct(row);
    counts.set(category, (counts.get(category) || 0) + 1);
    if (customerProductCanBeOrdered(row)) availableCount++;
  }
  const categoryButtons = CUSTOMER_CATEGORY_ORDER.filter(key => counts.has(key)).map(key => ({
    text: CUSTOMER_CATEGORY_META[key].button + " (" + counts.get(key) + ")",
    callback_data: "cat:items:" + key + ":0"
  }));
  const categoryRows = [];
  for (let i=0;i<categoryButtons.length;i+=2) categoryRows.push(categoryButtons.slice(i,i+2));
  await updateTelegramMessage(env, message, {
    text: "🛍️ KATALOG SEITON.ID\n\nTerdaftar " + products.length + " produk di " + counts.size +
      " kategori. Saat ini " + availableCount + " produk dapat dipesan. Produk nonaktif/stok habis tetap terlihat dengan statusnya.",
    replyMarkup: { inline_keyboard: [
      [{ text: "🛒 Semua Produk (" + products.length + ")", callback_data: "cat:items:all:0" }],
      ...categoryRows,
      [
        { text: "🔄 Refresh", callback_data: "nav:refresh" },
        { text: "📦 Pesanan Saya", callback_data: "nav:orders" }
      ],
      [{ text: "🏠 Menu Utama", callback_data: "nav:home" }]
    ] },
    clearMedia: true
  });
}

async function showCustomerCatalogPage(env, message, page = 0, categoryKey = "all") {
  const allProducts = customerCatalogProducts(await readTelegramCatalogRows(env));
  const safeCategory = categoryKey === "all" || CUSTOMER_CATEGORY_META[categoryKey] ? categoryKey : "all";
  const products = safeCategory === "all" ? allProducts : allProducts.filter(row => customerCategoryForProduct(row) === safeCategory);
  if (!products.length) {
    await updateTelegramMessage(env, message, {
      text: "Belum ada produk terdaftar pada kategori " + customerCategoryTitle(safeCategory) + ".",
      replyMarkup: { inline_keyboard: [
        [{ text: "⬅️ Semua Kategori", callback_data: "nav:catalog" }],
        [{ text: "🏠 Menu Utama", callback_data: "nav:home" }]
      ] },
      clearMedia: true
    });
    return;
  }
  const pages = Math.max(1,Math.ceil(products.length/CUSTOMER_CATALOG_PAGE_SIZE));
  const current = Math.max(0,Math.min(pages-1,Number.isInteger(page)?page:0));
  const visible = products.slice(current*CUSTOMER_CATALOG_PAGE_SIZE,(current+1)*CUSTOMER_CATALOG_PAGE_SIZE);
  const title = safeCategory === "all" ? "Semua Produk" : customerCategoryTitle(safeCategory);
  const lines = [];
  const buttons = [];
  visible.forEach((row,index) => {
    const p = parseCatalogProduct(row);
    const canOrder = customerProductCanBeOrdered(row);
    const status = !p.active ? "NONAKTIF"
      : !p.stockValid || !p.priceValid ? "PERLU DIPERBARUI"
        : p.stock === 0 ? "STOK HABIS" : "TERSEDIA";
    lines.push(
      (current*CUSTOMER_CATALOG_PAGE_SIZE+index+1) + ". " + p.name + " (" + p.sku + ")" +
      "\n   Harga: " + rupiah(p.price) +
      "\n   Status: " + status
    );
    if (canOrder) {
      let label = p.name + " · " + rupiah(p.price);
      if (label.length > 64) label = label.slice(0,61) + "…";
      buttons.push([{ text: "🛍️ " + label, callback_data: "view:" + p.sku }]);
    }
  });
  const nav = [];
  if (current>0) nav.push({text:"◀️ Sebelumnya",callback_data:"cat:items:"+safeCategory+":"+(current-1)});
  if (current<pages-1) nav.push({text:"Berikutnya ▶️",callback_data:"cat:items:"+safeCategory+":"+(current+1)});
  await updateTelegramMessage(env, message, {
    text: "🛍️ " + title + " (" + (current+1) + "/" + pages + ")\n\n" +
      lines.join("\n\n") + "\n\nPilih tombol produk yang tersedia untuk melihat foto dan membuat pesanan. Produk nonaktif/stok habis tidak dapat dibeli.",
    replyMarkup: { inline_keyboard: [
      ...buttons,
      ...(nav.length ? [nav] : []),
      [{ text: "🗂️ Semua Kategori", callback_data: "nav:catalog" }],
      [
        { text: "🔄 Refresh", callback_data: "nav:refresh" },
        { text: "🏠 Menu Utama", callback_data: "nav:home" }
      ]
    ] },
    clearMedia: true
  });
}

async function showAdminCatalogPage(env, message, page = 0) {
  const rows = await readCatalogRows(env);
  const products = rows.filter(r => r[0]);
  if (!products.length) {
    await updateTelegramMessage(env, message, {
      text: "🛍️ <b>KATALOG ADMIN</b>\n━━━━━━━━━━━━━━━━━━━━━━\n<i>Katalog masih kosong.</i>",
      parseMode: "HTML",
      replyMarkup: adminCatalogKeyboard(),
      clearMedia: true
    });
    return;
  }
  const pageCount = products.length;
  const current = Math.max(0, Math.min(pageCount - 1, Number.isInteger(page) ? page : 0));
  const p = products[current];
  const screen = renderAdminCatalogItemScreen({ row: p, current, total: pageCount });
  await updateTelegramMessage(env, message, {
    text: screen.text,
    parseMode: screen.parseMode,
    photo: p[5] && /^https:\/\//i.test(String(p[5])) ? String(p[5]) : null,
    clearMedia: !(p[5] && /^https:\/\//i.test(String(p[5]))),
    replyMarkup: screen.replyMarkup
  });
}

async function loadAdminDashboardData(env) {
  const state = await transactionReadiness(env);
  if (state.ready) {
    const dashboard = await listDashboardDataTransactional(env);
    const paymentResult = await env.DB.prepare(
      "SELECT order_id,status,ocr_status,ocr_amount,expected_amount,unique_code,qris_mode FROM qris_payments"
    ).all();
    const payments = new Map((paymentResult.results || []).map(payment => [String(payment.order_id), payment]));
    dashboard.orders = (dashboard.orders || []).map(order => {
      const payment = payments.get(String(order.order_id));
      if (!payment) return order;
      return {
        ...order,
        qris_status: String(payment.status || ""),
        qris_ocr_status: String(payment.ocr_status || "NOT_RUN"),
        qris_ocr_amount: payment.ocr_amount == null ? null : Number(payment.ocr_amount),
        qris_expected_amount: Number(payment.expected_amount),
        qris_unique_code: Number(payment.unique_code),
        qris_mode: String(payment.qris_mode || "DYNAMIC")
      };
    });
    return dashboard;
  }
  await ensurePaymentWorkflowHeaders(env);
  const [orderRows, productRows] = await Promise.all([
    readSheet(env, "Pesanan!A2:T"),
    readCatalogRows(env)
  ]);
  return {
    generated_at: new Date().toISOString(),
    orders: orderRowsToObjects(orderRows),
    products: productRowsToObjects(productRows)
  };
}
async function createDashboardAccessToken(env, chatId) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET belum dikonfigurasi.");
  const payload = base64url(JSON.stringify({
    sub: String(chatId),
    exp: Math.floor(Date.now() / 1000) + 14400,
    v: 1
  }));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode("SEITON_ADMIN_DASHBOARD_V1." + payload)
  );
  return payload + "." + base64urlBytes(new Uint8Array(signature));
}
async function pruneAdminWebSessions(env) {
  if (!env.DB) return;
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "DELETE FROM admin_web_sessions WHERE expires_at_ms <= ? OR (revoked_at_ms IS NOT NULL AND revoked_at_ms < ?)"
  ).bind(now, cutoff).run();
}
async function adminWebSessionTokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("site-owner-session:" + String(token)));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
function webAdminPayloadFromRequest(request) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const parts = authorization.slice(7).trim().split(".");
  if (parts.length !== 2) return null;
  try {
    const encoded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
async function handleAdminActivityAudit(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ ok: false, error: "Sesi admin tidak valid atau kedaluwarsa." }, 401);
  }
  const raw = Number(new URL(request.url).searchParams.get("limit") || 30);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.floor(raw))) : 30;
  try {
    const [orderEvents, adminActivities] = await Promise.all([
      env.DB.prepare(
        "SELECT id,order_id,event_type,from_status,to_status,actor,created_at " +
        "FROM order_events WHERE event_type IN ('PAYMENT_APPROVED','PAYMENT_REJECTED','STATUS_CHANGED','PICKED_UP') " +
        "ORDER BY id DESC LIMIT ?"
      ).bind(limit).all(),
      env.DB.prepare(
        "SELECT audit_id,actor_channel,actor_id,action,resource_type,resource_id,summary_json,created_at_ms " +
        "FROM admin_activity_audit ORDER BY created_at_ms DESC LIMIT ?"
      ).bind(limit).all()
    ]);
    const adminAuditRows = adminActivities.results || [];
    const orderAuditKey = (action, resourceId, actorChannel, actorId, fromStatus, toStatus, timestamp) =>
      JSON.stringify([action, resourceId, actorChannel, actorId, fromStatus, toStatus, timestamp]);
    const auditedOrderEvents = new Set();
    for (const row of adminAuditRows) {
      if (String(row.resource_type || "") !== "order") continue;
      const action = String(row.action || "");
      if (!["PAYMENT_APPROVED", "PAYMENT_REJECTED", "STATUS_CHANGED", "PICKED_UP"].includes(action)) continue;
      let summary = {};
      try { summary = JSON.parse(row.summary_json || "{}"); } catch {}
      auditedOrderEvents.add(orderAuditKey(
        action, String(row.resource_id || ""), String(row.actor_channel || "web"),
        String(row.actor_id || ""), String(summary.from_status || ""),
        String(summary.to_status || ""), Number(row.created_at_ms || 0)
      ));
    }
    const items = (orderEvents.results || []).flatMap(row => {
      const actor = String(row.actor || "");
      const actorChannel = actor.startsWith("telegram") ? "telegram" : "web";
      const actorId = actor.startsWith("telegram:") ? actor.slice("telegram:".length) : actor;
      const timestamp = Date.parse(row.created_at || "");
      const timestampMs = Number.isFinite(timestamp) ? timestamp : 0;
      const action = String(row.event_type || "ORDER_EVENT");
      const resourceId = String(row.order_id || "");
      const fromStatus = String(row.from_status || "");
      const toStatus = String(row.to_status || "");
      if (auditedOrderEvents.has(orderAuditKey(
        action, resourceId, actorChannel, actorId, fromStatus, toStatus, timestampMs
      ))) return [];
      const fromTelegram = actor.startsWith("telegram:") || actor === "telegram-admin";
      const actorLabel = actor.startsWith("telegram:")
        ? "Telegram · " + actor.slice("telegram:".length)
        : actor === "telegram-admin" ? "Telegram Admin (riwayat lama)"
        : actor === "web-admin" ? "Panel Web" : actor || "Admin (tidak diketahui)";
      return [{
        id: "order-event:" + row.id,
        actor: actorLabel,
        actor_id: actor,
        action,
        resource: "order",
        resource_id: resourceId,
        source: fromTelegram ? "Telegram" : actor === "web-admin" ? "Panel Web" : "Admin/Legacy",
        summary: {
          event_type: action,
          from_status: fromStatus,
          to_status: toStatus,
          transition_type: action === "PAYMENT_REJECTED" ? "payment_confirmation" : "order_status"
        },
        created_at_ms: timestampMs
      }];
    });
    for (const row of adminAuditRows) {
      let summary = {};
      try { summary = JSON.parse(row.summary_json || "{}"); } catch {}
      items.push({
        id: "admin-activity:" + row.audit_id,
        actor: row.actor_channel === "telegram"
          ? "Telegram · " + String(row.actor_id || "")
          : "Panel Web · " + String(row.actor_id || ""),
        actor_id: String(row.actor_id || ""),
        action: String(row.action || "ADMIN_ACTION"),
        resource: String(row.resource_type || ""),
        resource_id: String(row.resource_id || ""),
        source: row.actor_channel === "telegram" ? "Telegram" : "Panel Web",
        summary,
        created_at_ms: Number(row.created_at_ms || 0)
      });
    }
    items.sort((a, b) => b.created_at_ms - a.created_at_ms);
    return json({ ok: true, items: items.slice(0, limit) });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error", event: "admin_activity_audit_read_failed",
      code: "ADMIN_ACTIVITY_AUDIT_READ_FAILED"
    }));
    return json({ ok: false, error: "Riwayat operasional tidak dapat dibaca." }, 503);
  }
}

async function verifyDashboardAccess(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ") || !env.TELEGRAM_WEBHOOK_SECRET) return false;
  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const expected = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode("SEITON_ADMIN_DASHBOARD_V1." + parts[0])
  );
  if (!constantTimeEqual(base64urlBytes(new Uint8Array(expected)), parts[1])) return false;
  try {
    const encodedPayload = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(encodedPayload + "=".repeat((4 - encodedPayload.length % 4) % 4));
    const payload = JSON.parse(decoded);
    const validTime = Number(payload.exp) > Math.floor(Date.now() / 1000);
    if (!validTime) return false;
    if (payload.v === 1) return isAdmin(payload.sub, env);
    if (payload.v === 2 && payload.scope === "admin-dashboard" && payload.sub === "web-admin" && env.DB) {
      const tokenHash = await adminWebSessionTokenHash(token);
      const session = await env.DB.prepare(
        "SELECT expires_at_ms, revoked_at_ms FROM admin_web_sessions WHERE token_hash = ? LIMIT 1"
      ).bind(tokenHash).first();
      return Boolean(session && Number(session.expires_at_ms) > Date.now() &&
        (session.revoked_at_ms === null || session.revoked_at_ms === undefined));
    }
    return false;
  } catch {
    return false;
  }
}
async function createWebAdminSessionToken(env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET belum dikonfigurasi.");
  const payload = base64url(JSON.stringify({
    sub: "web-admin",
    scope: "admin-dashboard",
    exp: Math.floor(Date.now() / 1000) + 8 * 3600,
    v: 2
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("SEITON_ADMIN_DASHBOARD_V1." + payload));
  return payload + "." + base64urlBytes(new Uint8Array(sig));
}
const ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 5;

async function adminLoginClientKey(request, env) {
  const clientIp = String(request.headers.get("CF-Connecting-IP") || "").trim();
  if (!clientIp || !env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("ADMIN_LOGIN_CLIENT_ID_UNAVAILABLE");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("SEITON_ADMIN_LOGIN_CLIENT_V1." + clientIp)
  );
  return base64urlBytes(new Uint8Array(signature));
}

async function getAdminLoginLockout(env, clientKey, now = Date.now()) {
  const row = await env.DB.prepare(
    "SELECT blocked_until_ms FROM admin_login_attempts WHERE client_key = ? LIMIT 1"
  ).bind(clientKey).first();
  const blockedUntil = Number(row?.blocked_until_ms || 0);
  return {
    blocked: blockedUntil > now,
    retryAfterSeconds: blockedUntil > now ? Math.max(1, Math.ceil((blockedUntil - now) / 1000)) : 0
  };
}

async function recordAdminLoginFailure(env, clientKey, now = Date.now()) {
  const cutoff = now - ADMIN_LOGIN_FAILURE_WINDOW_MS;
  return env.DB.prepare(`
    INSERT INTO admin_login_attempts (
      client_key, window_started_ms, failed_attempts, blocked_until_ms, updated_at_ms
    ) VALUES (?, ?, 1, 0, ?)
    ON CONFLICT(client_key) DO UPDATE SET
      window_started_ms = CASE
        WHEN admin_login_attempts.window_started_ms <= ? THEN excluded.window_started_ms
        ELSE admin_login_attempts.window_started_ms
      END,
      failed_attempts = CASE
        WHEN admin_login_attempts.window_started_ms <= ? THEN 1
        ELSE MIN(admin_login_attempts.failed_attempts + 1, ?)
      END,
      blocked_until_ms = CASE
        WHEN (
          CASE
            WHEN admin_login_attempts.window_started_ms <= ? THEN 1
            ELSE MIN(admin_login_attempts.failed_attempts + 1, ?)
          END
        ) >= ? THEN excluded.updated_at_ms + ?
        ELSE 0
      END,
      updated_at_ms = excluded.updated_at_ms
    RETURNING failed_attempts, blocked_until_ms
  `).bind(
    clientKey,
    now,
    now,
    cutoff,
    cutoff,
    ADMIN_LOGIN_MAX_FAILURES,
    cutoff,
    ADMIN_LOGIN_MAX_FAILURES,
    ADMIN_LOGIN_MAX_FAILURES,
    ADMIN_LOGIN_LOCKOUT_MS
  ).first();
}

async function clearAdminLoginFailures(env, clientKey) {
  await env.DB.prepare(
    "DELETE FROM admin_login_attempts WHERE client_key = ?"
  ).bind(clientKey).run();
}

async function pruneAdminLoginAttempts(env) {
  if (!env.DB) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "DELETE FROM admin_login_attempts WHERE updated_at_ms < ?"
  ).bind(cutoff).run();
}

function adminLoginRateLimited(retryAfterSeconds) {
  const retry = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 60));
  const response = json({
    ok: false,
    error: "Terlalu banyak percobaan login. Silakan coba kembali setelah jeda."
  }, 429);
  const headers = new Headers(response.headers);
  headers.set("Retry-After", String(retry));
  return new Response(response.body, { status: 429, headers });
}

async function handleAdminLogin(request, env) {
  if (request.method !== "POST" || !env.ADMIN_WEB_PASSWORD) {
    return json({ ok:false, error:"Login dashboard belum dikonfigurasi." }, 503);
  }
  if (!env.DB || !env.ADMIN_LOGIN_RATE_LIMITER || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok:false, error:"Login sementara tidak tersedia." }, 503);
  }

  let stage = "client_key";
  try {
    const clientKey = await adminLoginClientKey(request, env);
    stage = "cloudflare_rate_limit";
    const rate = await env.ADMIN_LOGIN_RATE_LIMITER.limit({ key: clientKey });
    if (!rate.success) {
      console.warn(JSON.stringify({ level:"warn", event:"admin_login_rate_limited", source:"cloudflare" }));
      return adminLoginRateLimited(60);
    }

    const now = Date.now();
    stage = "d1_lockout_lookup";
    const lockout = await getAdminLoginLockout(env, clientKey, now);
    if (lockout.blocked) {
      console.warn(JSON.stringify({ level:"warn", event:"admin_login_rate_limited", source:"failed_attempt_lockout" }));
      return adminLoginRateLimited(lockout.retryAfterSeconds);
    }

    let body;
    stage = "parse_login_body";
    try {
      body = await request.json();
    } catch {
      return json({ok:false,error:"Format login tidak valid."},400);
    }
    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length > 1024 || !constantTimeEqual(password, String(env.ADMIN_WEB_PASSWORD))) {
      stage = "d1_record_failure";
      const failure = await recordAdminLoginFailure(env, clientKey, now);
      const blockedUntil = Number(failure?.blocked_until_ms || 0);
      if (blockedUntil > now) {
        console.warn(JSON.stringify({ level:"warn", event:"admin_login_rate_limited", source:"failed_attempt_lockout" }));
        return adminLoginRateLimited(Math.ceil((blockedUntil - now) / 1000));
      }
      return json({ ok:false, error:"Kredensial tidak valid." }, 401);
    }

    stage = "d1_clear_failures";
    await clearAdminLoginFailures(env, clientKey);
    stage = "create_admin_session";
    const token = await createWebAdminSessionToken(env);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 28800 * 1000;
    const tokenHash = await adminWebSessionTokenHash(token);
    const sessionId = crypto.randomUUID();
    stage = "persist_admin_session";
    await env.DB.prepare(
      "INSERT INTO admin_web_sessions(session_id, token_hash, issued_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)"
    ).bind(sessionId, tokenHash, issuedAt, expiresAt).run();
    return json({ ok:true, token, expires_in:28800 });
  } catch (error) {
    console.error(JSON.stringify({
      level:"error",
      event:"admin_login_security_dependency",
      stage,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_code: error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message) ? error.message : "UNEXPECTED",
      client_ip_header_present: Boolean(request.headers.get("CF-Connecting-IP")),
      real_ip_header_present: Boolean(request.headers.get("X-Real-IP")),
      forwarded_for_header_present: Boolean(request.headers.get("X-Forwarded-For")),
      webhook_secret_configured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
      message:"Login security dependency unavailable"
    }));
    return json({ ok:false, error:"Login sementara tidak tersedia." }, 503);
  }
}
async function handleAdminWebSessionRevoke(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ ok:false, error:"Sesi admin tidak valid atau kedaluwarsa." }, 401);
  }
  const payload = webAdminPayloadFromRequest(request);
  if (!payload || payload.v !== 2 || payload.scope !== "admin-dashboard" || payload.sub !== "web-admin") {
    return json({ ok:false, error:"Hanya sesi panel pemilik yang dapat mencabut sesi web." }, 403);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ ok:false, error:"Format permintaan pencabutan sesi tidak valid." }, 400); }
  const tokenHash = String(body?.token_hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
    return json({ ok:false, error:"Fingerprint sesi tidak valid." }, 400);
  }
  const now = Date.now();
  const revoked = await env.DB.prepare(
    "UPDATE admin_web_sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ? RETURNING session_id"
  ).bind(now, tokenHash, now).first();
  if (!revoked) return json({ ok:false, error:"Sesi tidak ditemukan, kedaluwarsa, atau sudah dicabut." }, 404);
  return json({ ok:true, revoked:true });
}
async function handleAdminPaymentMethods(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  }
  if (!env.DB) return json({ok:false,error:"D1 tidak tersedia."},503);
  try {
    if (request.method === "GET") {
      return json({ok:true,...await loadPaymentMethodConfiguration(env)});
    }
    let body;
    try { body = await request.json(); } catch { return json({ok:false,error:"Data pengaturan tidak valid."},400); }
    const now = new Date().toISOString();
    const actor = webAdminPayloadFromRequest(request);
    const actorId = String(actor?.sub || "web-admin").slice(0,128);
    let action = String(body.action || "");

    if (action === "set_method") {
      const key = String(body.method_key || "").toUpperCase();
      if (!PAYMENT_METHOD_KEYS.includes(key) || typeof body.enabled !== "boolean") {
        return json({ok:false,error:"Metode atau status tidak valid."},400);
      }
      const fallback = PAYMENT_METHOD_DEFAULTS[key];
      await env.DB.prepare(
        "INSERT INTO payment_method_settings(method_key,display_name,enabled,instructions,updated_at) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(method_key) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at"
      ).bind(key,fallback.display_name,body.enabled ? 1 : 0,fallback.instructions,now).run();
      await recordAdminActivity(env,{
        actorChannel:"web",actorId,action:"PAYMENT_METHOD_UPDATED",resourceType:"payment_method",
        resourceId:key,summary:{enabled:body.enabled}
      });
    } else if (action === "save_bank") {
      const accountId = String(body.account_id || crypto.randomUUID()).trim().slice(0,80);
      const bankName = String(body.bank_name || "").trim().slice(0,80);
      const accountHolder = String(body.account_holder || "").trim().slice(0,100);
      const accountNumber = String(body.account_number || "").replace(/[\s-]/g,"");
      const note = String(body.note || "").trim().slice(0,200);
      const enabled = body.enabled === undefined ? true : body.enabled;
      if (typeof enabled !== "boolean") {
        return json({ok:false,error:"Status rekening tidak valid."},400);
      }
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(accountId)
        || !bankName || !accountHolder || !/^\d{5,32}$/.test(accountNumber)) {
        return json({ok:false,error:"Lengkapi nama bank, nama pemilik, dan nomor rekening yang valid (5–32 digit)."},400);
      }
      await env.DB.prepare(
        "INSERT INTO payment_bank_accounts(account_id,bank_name,account_holder,account_number,note,enabled,sort_order,created_at,updated_at) " +
        "VALUES(?,?,?,?,?,?,0,?,?) ON CONFLICT(account_id) DO UPDATE SET " +
        "bank_name=excluded.bank_name,account_holder=excluded.account_holder,account_number=excluded.account_number," +
        "note=excluded.note,enabled=excluded.enabled,updated_at=excluded.updated_at"
      ).bind(accountId,bankName,accountHolder,accountNumber,note,enabled ? 1 : 0,now,now).run();
      await recordAdminActivity(env,{
        actorChannel:"web",actorId,action:"PAYMENT_BANK_ACCOUNT_SAVED",resourceType:"payment_bank_account",
        resourceId:accountId,summary:{bank_name:bankName,account_holder:accountHolder,account_number_last4:accountNumber.slice(-4),enabled}
      });
    } else if (action === "toggle_bank") {
      const accountId = String(body.account_id || "").trim().slice(0,80);
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(accountId) || typeof body.enabled !== "boolean") {
        return json({ok:false,error:"Rekening atau status tidak valid."},400);
      }
      const result = await env.DB.prepare(
        "UPDATE payment_bank_accounts SET enabled=?,updated_at=? WHERE account_id=?"
      ).bind(body.enabled ? 1 : 0,now,accountId).run();
      if (Number(result.meta?.changes || 0) !== 1) return json({ok:false,error:"Rekening tidak ditemukan."},404);
      await recordAdminActivity(env,{
        actorChannel:"web",actorId,action:body.enabled ? "PAYMENT_BANK_ACCOUNT_ENABLED" : "PAYMENT_BANK_ACCOUNT_DISABLED",
        resourceType:"payment_bank_account",resourceId:accountId,summary:{enabled:body.enabled}
      });
    } else {
      return json({ok:false,error:"Aksi pengaturan pembayaran tidak dikenal."},400);
    }
    return json({ok:true,...await loadPaymentMethodConfiguration(env)});
  } catch (error) {
    const message = String(error?.message || "");
    const duplicateAccount = /payment_bank_accounts_bank_number_uq|UNIQUE constraint failed/i.test(message);
    console.error(JSON.stringify({level:"error",event:"admin_payment_methods",code:duplicateAccount ? "DUPLICATE_BANK_ACCOUNT" : "PAYMENT_METHOD_SETTINGS_FAILED"}));
    return json({ok:false,error:duplicateAccount ? "Rekening tersebut sudah terdaftar." : "Pengaturan pembayaran gagal disimpan. Periksa migrasi D1 dan coba lagi."},duplicateAccount ? 409 : 500);
  }
}
async function handleAdminPaymentAction(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Data aksi tidak valid."},400); }
  const found=await findOrderById(env,body.order_id);
  if (!found) return json({ok:false,error:"Pesanan tidak ditemukan."},404);
  try {
    if (body.action==="approve") {
      const method=String(found.row[11]||"").toUpperCase();
      if (!["QRIS","TRANSFER","TRANSFER_BANK"].includes(method)) throw new Error("Hanya pembayaran QRIS/transfer yang dapat diverifikasi melalui menu ini.");
      const approved=await approvePaymentAndIssueTicket(env,found.rowNumber ?? body.order_id,"web-admin");
      if (approved.alreadyApproved) {
        return json({ok:true,status:"ALREADY_APPROVED",already_approved:true,receipt_code:approved.receiptCode,receipt_sent:false});
      }
      let receiptSent = true;
      try { await sendPickupReceipt(env,String(approved.row[3]),approved.row,String(approved.row[0]),approved.receiptCode); }
      catch(error) {
        receiptSent = false;
        console.error(JSON.stringify({level:"error",event:"dashboard_receipt_delivery",order_id:approved.row[0],message:error.message}));
      }
      return json({ok:true,status:"DIBAYAR",receipt_code:approved.receiptCode,receipt_sent:receiptSent});
    }
    if (body.action==="reject") {
      const rejected=await rejectPaymentRequest(env,found.rowNumber ?? body.order_id,"web-admin");
      try { await sendTelegram(env,String(rejected[3]),"⚠️ Permintaan verifikasi pembayaran untuk "+rejected[0]+" belum dapat disetujui. Periksa kembali bukti dan nominal pembayaran, lalu ajukan ulang dari menu Pesanan Saya.",{inline_keyboard:[[{text:"🔁 Ajukan Verifikasi Ulang",callback_data:"pc:req:"+rejected[0]}]]}); } catch (error) { console.warn(JSON.stringify({level:"warn",event:"dashboard_payment_rejection_notice",message:error.message})); }
      return json({ok:true,status:"DITOLAK"});
    }
    return json({ok:false,error:"Aksi pembayaran tidak dikenal."},400);
  } catch(error) { return json({ok:false,error:error.message},400); }
}
async function handleAdminProductMutation(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Data produk tidak valid."},400); }
  try {
    await ensureCatalogHeaders(env);
    if (body.action === "delete") {
      const result = await deleteCatalogProduct(env, body.sku);
      await recordAdminActivity(env, { actorChannel: "web", actorId: "web-admin", action: "PRODUCT_DELETED", resourceType: "product", resourceId: result.sku, summary: { sku: result.sku } });
      return json({ok:true,deleted:result.sku});
    }
    if (body.action !== "save" || !body.product) return json({ok:false,error:"Aksi produk tidak dikenal."},400);
    const p = body.product;
    const active = p.active === true || String(p.active).toLowerCase() === "true";
    const result = await saveCatalogProduct(env, { ...p, active }, String(p.original_sku || ""));
    await recordAdminActivity(env, { actorChannel: "web", actorId: "web-admin", action: result === "updated" ? "PRODUCT_UPDATED" : "PRODUCT_CREATED", resourceType: "product", resourceId: String(p.sku).trim(), summary: { sku: String(p.sku).trim(), name: String(p.name || "").slice(0, 100), price: Number(p.price), active } });
    return json({ok:true,sku:String(p.sku).trim(),action:result});
  } catch(error) { return json({ok:false,error:error.message},400); }
}

async function setOrderStatus(env, rowNumber, status, actor = "admin") {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,rowNumber);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const updated = await setOrderStatusTransactional(env,found.order.order_id,status,actor);
    await mirrorTransactionalOrder(env,updated);
    return orderToSheetRow(updated);
  }
  await ensurePaymentWorkflowHeaders(env);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error("Nomor baris pesanan tidak valid.");
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const row = values[0];
  if (!row || !row[0]) throw new Error("Pesanan tidak ditemukan.");
  const current = String(row[12] || "").trim().toUpperCase();
  const method = String(row[11] || "").trim().toUpperCase();
  if (status === "DIBATALKAN" && PAID_ORDER_STATUSES.includes(current)) {
    throw new Error("Pesanan yang sudah dibayar tidak dapat dibatalkan dari panel ini. Refund perlu dicatat terpisah.");
  }
  if (["DIBAYAR", "DIPROSES", "DIKIRIM", "SELESAI"].includes(status) &&
      ["QRIS", "TRANSFER", "TRANSFER_BANK"].includes(method) &&
      String(row[13] || "").trim().toUpperCase() !== "DISETUJUI") {
    throw new Error("Pembayaran QRIS/transfer harus disetujui melalui menu Verifikasi Pembayaran agar resi diterbitkan.");
  }
  await updateSheetRange(env, "Pesanan!M" + rowNumber + ":M" + rowNumber, [[status]]);
  await recordAdminActivity(env, { actorChannel: actorChannel(actor), actorId: actorIdentifier(actor), action: "STATUS_CHANGED", resourceType: "order", resourceId: String(row[0]), summary: { from_status: current, to_status: status } });
  return row;
}

async function handleAdminOrderStatus(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Data status tidak valid."},400); }
  const found=await findOrderById(env,body.order_id);
  if(!found)return json({ok:false,error:"Pesanan tidak ditemukan."},404);
  const status=String(body.status||"").trim().toUpperCase();
  const allowed=["MENUNGGU_PEMBAYARAN","MENUNGGU_VERIFIKASI","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"];
  if(!allowed.includes(status))return json({ok:false,error:"Status pesanan tidak dikenal."},400);
  try { await setOrderStatus(env,found.rowNumber ?? body.order_id,status,"web-admin"); return json({ok:true,status}); }
  catch(error){return json({ok:false,error:error.message},400);}
}
async function handleAdminPaymentProof(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ok:false,error:"Sesi admin tidak valid atau kedaluwarsa."},401);
  const orderId=new URL(request.url).searchParams.get("order_id")||"";
  const found=await findOrderById(env,orderId);
  if(!found||!found.row[14])return json({ok:false,error:"File bukti pembayaran tidak ditemukan."},404);
  const fileId=String(found.row[14]);
  const get=await fetch(TELEGRAM_API+"/bot"+env.TELEGRAM_TOKEN+"/getFile?file_id="+encodeURIComponent(fileId));
  const meta=await get.json().catch(()=>({}));
  if(!get.ok||!meta.ok||!meta.result?.file_path)return json({ok:false,error:"Telegram tidak dapat membuka file bukti pembayaran."},502);
  const file=await fetch("https://api.telegram.org/file/bot"+env.TELEGRAM_TOKEN+"/"+meta.result.file_path);
  if(!file.ok)return json({ok:false,error:"Gagal mengunduh bukti pembayaran dari Telegram."},502);
  const type=String(found.row[15]||"")==="PHOTO"?"image/jpeg":(file.headers.get("content-type")||"application/octet-stream");
  return new Response(file.body,{headers:{"Content-Type":type,"Content-Disposition":"inline; filename=\"payment-proof\"","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}

async function handleAdminBotDiagnostics(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ ok: false, error: "Sesi admin tidak valid atau kedaluwarsa." }, 401);
  }
  const checkedAt = new Date().toISOString();
  const expectedWebhookUrl = "https://automate-bot.seiton.biz.id/telegram";
  const state = await transactionReadiness(env);
  const diagnostics = {
    ok: true,
    service: "seiton-order-bot",
    checked_at: checkedAt,
    worker: { status: "HEALTHY", transaction_store: state.ready ? "READY" : state.configured ? "MIGRATION_REQUIRED" : "LEGACY" },
    telegram: { reachable: false, webhook_configured: false, pending_update_count: null, bot_name: "", username: "", last_error_date: null, last_error_message: "" },
    catalog: { total: 0, active: 0, inactive: 0, stock_units: 0 },
    orders: { total: 0, today: 0, pending_payment: 0, pending_verification: 0 },
    operations: { failed_mirror_outbox: 0, stalled_mirror_outbox: 0, stale_payment_verification: 0 }
  };
  if (!state.ready) diagnostics.worker.status = "DEGRADED";
  const [meResult, webhookResult, catalogResult, orderResult, operationsResult] = await Promise.allSettled([
    env.TELEGRAM_TOKEN
      ? fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/getMe")
      : Promise.reject(new Error("TELEGRAM_TOKEN_MISSING")),
    env.TELEGRAM_TOKEN
      ? fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/getWebhookInfo")
      : Promise.reject(new Error("TELEGRAM_TOKEN_MISSING")),
    env.DB.prepare(
      "SELECT COUNT(*) AS total, " +
      "COALESCE(SUM(CASE WHEN active=1 THEN 1 ELSE 0 END),0) AS active, " +
      "COALESCE(SUM(CASE WHEN active=0 THEN 1 ELSE 0 END),0) AS inactive, " +
      "COALESCE(SUM(CASE WHEN active=1 AND stock IS NOT NULL THEN stock ELSE 0 END),0) AS stock_units " +
      "FROM catalog_products"
    ).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS total, " +
      "COALESCE(SUM(CASE WHEN substr(created_at,1,10)=? THEN 1 ELSE 0 END),0) AS today, " +
      "COALESCE(SUM(CASE WHEN status='MENUNGGU_PEMBAYARAN' THEN 1 ELSE 0 END),0) AS pending_payment, " +
      "COALESCE(SUM(CASE WHEN payment_confirmation_status='MENUNGGU_VERIFIKASI' THEN 1 ELSE 0 END),0) AS pending_verification " +
      "FROM orders"
    ).bind(localDateKey(checkedAt)).first(),
    env.DB.prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM outbox WHERE status='FAILED' AND event_type IN ('SHEET_MIRROR','CATALOG_MIRROR')) AS failed_mirror_outbox, " +
      "(SELECT COUNT(*) FROM outbox WHERE status IN ('PENDING','PROCESSING') " +
      "AND event_type IN ('SHEET_MIRROR','CATALOG_MIRROR') AND attempts>=5 " +
      "AND julianday('now')-julianday(created_at)>=(1.0/24.0)) AS stalled_mirror_outbox, " +
      "(SELECT COUNT(*) FROM orders WHERE payment_confirmation_status='MENUNGGU_VERIFIKASI' " +
      "AND payment_requested_at<>'' AND julianday('now')-julianday(payment_requested_at)>=(2.0/24.0)) AS stale_payment_verification"
    ).first()
  ]);
  if (meResult.status === "fulfilled") {
    const response = meResult.value;
    const body = await response.json().catch(() => ({}));
    diagnostics.telegram.reachable = Boolean(response.ok && body.ok && body.result?.is_bot);
    diagnostics.telegram.bot_name = String(body.result?.first_name || "").slice(0,80);
    diagnostics.telegram.username = String(body.result?.username || "").slice(0,80);
  }
  if (webhookResult.status === "fulfilled") {
    const response = webhookResult.value;
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.ok) {
      const info = body.result || {};
      const webhookUrl = String(info.url || "");
      diagnostics.telegram.webhook_configured = webhookUrl === expectedWebhookUrl;
      diagnostics.telegram.pending_update_count = Number(info.pending_update_count || 0);
      diagnostics.telegram.last_error_date = info.last_error_date ? Number(info.last_error_date) : null;
      diagnostics.telegram.last_error_message = String(info.last_error_message || "").slice(0,240);
      diagnostics.telegram.webhook_host = (() => { try { return webhookUrl ? new URL(webhookUrl).host : ""; } catch { return ""; } })();
    }
  }
  if (catalogResult.status === "fulfilled" && catalogResult.value) {
    for (const key of ["total","active","inactive","stock_units"]) diagnostics.catalog[key] = Number(catalogResult.value[key] || 0);
  } else {
    diagnostics.worker.status = "DEGRADED";
  }
  if (orderResult.status === "fulfilled" && orderResult.value) {
    for (const key of ["total","today","pending_payment","pending_verification"]) diagnostics.orders[key] = Number(orderResult.value[key] || 0);
  } else {
    diagnostics.worker.status = "DEGRADED";
  }
  if (operationsResult.status === "fulfilled" && operationsResult.value) {
    diagnostics.operations.failed_mirror_outbox = Number(operationsResult.value.failed_mirror_outbox || 0);
    diagnostics.operations.stalled_mirror_outbox = Number(operationsResult.value.stalled_mirror_outbox || 0);
    diagnostics.operations.stale_payment_verification = Number(operationsResult.value.stale_payment_verification || 0);
  } else {
    diagnostics.worker.status = "DEGRADED";
  }
  if (!diagnostics.telegram.reachable || !diagnostics.telegram.webhook_configured) diagnostics.worker.status = "DEGRADED";
  return json(diagnostics);
}

async function handleAdminDashboardData(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ ok: false, error: "Akses dashboard tidak valid atau sudah kedaluwarsa. Buka kembali dari bot Telegram admin." }, 401);
  try {
    const data = await loadAdminDashboardData(env);
    return json({ ok: true, ...data });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "dashboard_data", message: error.message }));
    return json({ ok: false, error: "Gagal membaca data Google Sheets: " + error.message }, 502);
  }
}
async function buildReportExports(env, range = {}) {
  const data = await loadAdminDashboardData(env);
  const from = String(range.from || "");
  const to = String(range.to || "");
  if (from || to) {
    data.orders = (data.orders || []).filter(order => {
      const day = localDateKey(order.created_at);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
      return (!from || day >= from) && (!to || day <= to);
    });
  }
  return buildReportExportsFromData(data);
}
async function handleAdminDashboardExport(request, env) {
  if (!(await verifyDashboardAccess(request, env))) return json({ ok: false, error: "Akses dashboard tidak valid atau sudah kedaluwarsa." }, 401);
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "";
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!["orders", "finance", "daily", "inventory"].includes(type)) return json({ ok: false, error: "Jenis export tidak valid." }, 400);
  if (!isValidReportDate(from) || !isValidReportDate(to) || (from && to && from > to)) {
    return json({ ok: false, error: "Rentang tanggal laporan tidak valid. Gunakan tanggal kalender Asia/Jakarta." }, 400);
  }
  try {
    const report = (await buildReportExports(env,{from,to}))[type];
    const rangeSuffix = type === "inventory" ? "_snapshot" : (from || to ? "_" + (from || "awal") + "_" + (to || "akhir") : "");
    const filename = report.filename.replace(/\.csv$/i,"") + rangeSuffix + ".csv";
    return new Response(report.csv, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + filename + '"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    } });
  } catch (error) {
    console.error(JSON.stringify({level:"error",event:"admin_report_export_failed",type,from,to,error:String(error && error.message || error)}));
    return json({ ok: false, error: "Gagal membuat laporan. Periksa kesiapan data dan coba kembali." }, 502);
  }
}
function orderConfirmationKeyboard(order) {
  const buttons = [];
  const method = String(order.paymentMethod || "").toUpperCase();
  if (method === "QRIS") {
    buttons.push([{ text: "📎 Upload Bukti Pembayaran", callback_data: "pc:req:" + order.orderId }]);
    buttons.push([{ text: "🔄 Periksa Status", callback_data: "qris:check:" + order.orderId }]);
  } else if (method !== "COD") {
    buttons.push([{ text: "💳 Saya Sudah Bayar — Minta Verifikasi", callback_data: "pc:req:" + order.orderId }]);
  }
  buttons.push([{ text: "📦 Pesanan Saya", callback_data: "nav:orders" }]);
  return { inline_keyboard: buttons };
}

function paymentProofPrompt(orderId) {
  return [
    "🧾 BUKTI PEMBAYARAN SEITON",
    "ORDER_ID=" + orderId,
    "",
    "Balas pesan ini dengan foto atau dokumen bukti transfer/QRIS.",
    "Admin akan mencocokkan pembayaran sebelum menerbitkan resi pengambilan."
  ].join("\n");
}


const PAYMENT_METHOD_KEYS = ["QRIS","TRANSFER","COD"];
const PAYMENT_METHOD_DEFAULTS = {
  QRIS: { display_name: "QRIS Dinamis", enabled: 1, instructions: "Pindai QRIS dan pastikan nominal tepat." },
  TRANSFER: { display_name: "Transfer Bank", enabled: 1, instructions: "Transfer tepat sesuai total tagihan ke rekening resmi Seiton.id." },
  COD: { display_name: "Bayar di Tempat (COD)", enabled: 1, instructions: "Pembayaran dilakukan saat pesanan diterima." }
};

async function loadPaymentMethodConfiguration(env) {
  if (!env.DB) throw new Error("D1_BINDING_MISSING");
  const [methodResult, accountResult] = await Promise.all([
    env.DB.prepare("SELECT method_key,display_name,enabled,instructions,updated_at FROM payment_method_settings ORDER BY method_key").all(),
    env.DB.prepare("SELECT account_id,bank_name,account_holder,account_number,note,enabled,sort_order,created_at,updated_at FROM payment_bank_accounts ORDER BY sort_order,bank_name,account_holder").all()
  ]);
  const configured = new Map((methodResult.results || []).map(row => [String(row.method_key), row]));
  const accounts = (accountResult.results || []).map(row => ({
    account_id: String(row.account_id),
    bank_name: String(row.bank_name),
    account_holder: String(row.account_holder),
    account_number: String(row.account_number),
    note: String(row.note || ""),
    enabled: Number(row.enabled) === 1,
    sort_order: Number(row.sort_order || 0),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || "")
  }));
  const methods = PAYMENT_METHOD_KEYS.map(key => {
    const row = configured.get(key);
    if (!row) throw new Error("PAYMENT_METHOD_SETTINGS_NOT_MIGRATED");
    const fallback = PAYMENT_METHOD_DEFAULTS[key];
    const enabled = Number(row.enabled) === 1;
    const activeAccounts = key === "TRANSFER" ? accounts.filter(account => account.enabled) : [];
    const runtimeReady = key !== "QRIS" || isQrisCheckoutAvailable(env);
    const hasDestination = key !== "TRANSFER" || activeAccounts.length > 0;
    return {
      method_key: key,
      display_name: String(row.display_name || fallback.display_name),
      enabled,
      available: enabled && runtimeReady && hasDestination,
      runtime_ready: runtimeReady,
      instructions: String(row.instructions || fallback.instructions),
      active_account_count: activeAccounts.length,
      updated_at: String(row.updated_at || "")
    };
  });
  return { methods, bank_accounts: accounts };
}

async function getAvailablePaymentMethods(env) {
  const [config, intl] = await Promise.all([
    loadPaymentMethodConfiguration(env),
    loadIntlPaymentConfig(env)
  ]);
  const base = config.methods.filter(method => method.available).map(method => method.method_key);
  const result = [];
  if (base.includes("QRIS")) result.push("QRIS");
  if (intl.usdt_enabled) result.push("USDT");
  if (intl.paypal_enabled) result.push("PAYPAL");
  if (intl.stars_enabled) result.push("STARS");
  if (base.includes("TRANSFER")) result.push("TRANSFER");
  if (base.includes("COD")) result.push("COD");
  return result;
}

async function orderConfirmationWithPaymentInstructions(env, order) {
  const base = orderConfirmation(order, env);
  if (String(order.paymentMethod || "").toUpperCase() !== "TRANSFER") return base;
  const config = await loadPaymentMethodConfiguration(env);
  const accounts = config.bank_accounts.filter(account => account.enabled);
  if (!accounts.length) throw new Error("Rekening transfer belum tersedia. Pilih QRIS/COD atau hubungi admin.");
  const details = [
    "🏦 REKENING RESMI SEITON.ID",
    "Silakan transfer tepat sesuai total tagihan. Jangan membulatkan nominal.",
    "",
    ...accounts.flatMap((account, index) => [
      (index + 1) + ". " + account.bank_name,
      "No. rekening: " + account.account_number,
      "Atas nama: " + account.account_holder,
      ...(account.note ? ["Catatan: " + account.note] : []),
      ""
    ]),
    "Setelah transfer, tekan tombol Saya Sudah Bayar dan unggah bukti transaksi.",
    "Admin akan mencocokkan dana masuk dan nominal sebelum menerbitkan resi."
  ];
  return base + "\n\n" + details.join("\n");
}

async function getQrisPaymentForOrder(env, orderId) {
  if (!env.DB) throw new Error("D1_BINDING_MISSING");
  return env.DB.prepare("SELECT * FROM qris_payments WHERE order_id=?")
    .bind(String(orderId)).first();
}

async function createOrReuseQrisPayment(env, order) {
  const mode = getQrisCheckoutMode(env);
  if (mode === "DISABLED") throw new Error("QRIS_CHECKOUT_NOT_CONFIGURED");
  const existing = await getQrisPaymentForOrder(env, order.orderId);
  if (existing) return existing;
  const baseAmount = Number(order.total);
  if (!Number.isSafeInteger(baseAmount) || baseAmount <= 0) {
    throw new Error("QRIS_BASE_AMOUNT_INVALID");
  }
  if (baseAmount >= MAX_QRIS_TRANSACTION_AMOUNT) {
    throw new Error("QRIS_BASE_AMOUNT_EXCEEDS_TRANSACTION_LIMIT");
  }
  const staticPayload = String(env.QRIS_STATIC_PAYLOAD || "").trim();
  const merchant = extractQrisMerchantProfile(staticPayload);
  const createdAt = new Date().toISOString();
  for (let attempt = 0; attempt < 60; attempt++) {
    const uniqueCodeText = generateQrisUniqueCode(
      Math.min(999, MAX_QRIS_TRANSACTION_AMOUNT - baseAmount)
    );
    const uniqueCode = Number(uniqueCodeText);
    const expectedAmount = baseAmount + uniqueCode;
    if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= baseAmount
      || expectedAmount > MAX_QRIS_TRANSACTION_AMOUNT) {
      throw new Error("QRIS_EXPECTED_AMOUNT_INVALID");
    }
    const collision = await env.DB.prepare(
      "SELECT order_id FROM qris_payments WHERE expected_amount=? LIMIT 1"
    ).bind(expectedAmount).first();
    if (collision) continue;
    const payload = mode === "DYNAMIC"
      ? buildDynamicQrisPayload(staticPayload, expectedAmount)
      : staticPayload;
    try {
      await env.DB.prepare("INSERT INTO qris_payments " +
        "(order_id,provider,provider_order_id,amount,currency,status,base_amount,unique_code," +
        "expected_amount,qris_payload,merchant_name,merchant_city,qris_mode,created_at,updated_at) " +
        "VALUES(?,'internal_qris',?,?,'IDR','PENDING',?,?,?,?,?,?,?,?,?)")
        .bind(String(order.orderId),String(order.orderId),expectedAmount,baseAmount,uniqueCode,
          expectedAmount,payload,merchant.merchantName,merchant.merchantCity,mode,createdAt,createdAt).run();
      return await getQrisPaymentForOrder(env, order.orderId);
    } catch (error) {
      const raced = await getQrisPaymentForOrder(env, order.orderId);
      if (raced) return raced;
      const racedAmount = await env.DB.prepare(
        "SELECT order_id FROM qris_payments WHERE expected_amount=? LIMIT 1"
      ).bind(expectedAmount).first();
      if (racedAmount) continue;
      throw error;
    }
  }
  throw new Error("QRIS_UNIQUE_CODE_EXHAUSTED");
}

async function fetchInternalQrisImage(payload) {
  const url = new URL("https://quickchart.io/qr");
  url.searchParams.set("text", String(payload));
  url.searchParams.set("size", "640");
  url.searchParams.set("margin", "2");
  url.searchParams.set("format", "png");
  url.searchParams.set("ecc", "M");
  const response = await fetch(url.toString(), { headers: { Accept: "image/png" } });
  if (!response.ok) throw new Error("QRIS_IMAGE_RENDER_FAILED_" + response.status);
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (contentType !== "image/png") throw new Error("QRIS_IMAGE_TYPE_INVALID");
  const image = await response.blob();
  if (!image.size || image.size > 3 * 1024 * 1024) throw new Error("QRIS_IMAGE_SIZE_INVALID");
  return image;
}

async function sendQrisPaymentScreen(env, chatId, order) {
  const payment = await createOrReuseQrisPayment(env, order);
  if (payment.status === "PAID") {
    await sendTelegram(env, chatId, "✅ Pembayaran pesanan " + order.orderId + " sudah disetujui.");
    return payment;
  }
  const image = await fetchInternalQrisImage(payment.qris_payload);
  const uniqueCode = String(payment.unique_code).padStart(3, "0");
  const staticFallback = String(payment.qris_mode || "DYNAMIC") === "STATIC_FALLBACK";
  const caption = [
    staticFallback ? "📷 QRIS STATIS SEITON.ID — NOMINAL DIISI MANUAL" : "⚡ QRIS DINAMIS SEITON.ID",
    "Pesanan: " + order.orderId,
    "Merchant: " + (payment.merchant_name || "Seiton.id"),
    "Total pesanan: " + rupiah(payment.base_amount),
    "Kode unik: " + uniqueCode,
    "TRANSFER PERSIS: " + rupiah(payment.expected_amount),
    "",
    staticFallback
      ? "QR ini adalah QRIS statis asli merchant, jadi nominal tidak terisi otomatis. Setelah memindai, masukkan " + rupiah(payment.expected_amount) + " secara manual. Jangan bulatkan nominal."
      : "Nominal sudah tertanam di QR. Pindai menggunakan aplikasi pembayaran dan pastikan nominalnya " + rupiah(payment.expected_amount) + ".",
    "Setelah pembayaran berhasil, tekan Upload Bukti Pembayaran dan kirim screenshot transaksi.",
    "Sistem membaca nominal dan data bukti. Admin tetap mencocokkan transaksi masuk sebelum pembayaran disahkan."
  ].join("\n");
  const sent = await sendTelegramPhotoBlob(env, chatId, image, caption, {
    inline_keyboard: [
      [{ text: "📎 Saya Sudah Bayar — Upload Bukti", callback_data: "pc:req:" + order.orderId, style: "success" }],
      [{ text: "🔄 Periksa Status Pembayaran", callback_data: "qris:check:" + order.orderId, style: "primary" }],
      [{ text: "📜 Riwayat Pesanan", callback_data: "nav:orders", style: "primary" }]
    ]
  });
  const qrisMsgId = sent?.result?.message_id;
  if (qrisMsgId && order?.orderId) {
    await setQrisMessageRef(env, order.orderId, { chatId: String(chatId), messageId: qrisMsgId });
  }
  return payment;
}

async function handleQrisPaymentShow(env, message, chatId, userId, orderId) {
  if (!isQrisCheckoutAvailable(env)) throw new Error("QRIS internal belum diaktifkan.");
  const order = await findOrderTransactional(env, orderId);
  if (!order || String(order.customer_id) !== String(userId)) throw new Error("Pesanan tidak ditemukan untuk akun Telegram ini.");
  if (String(order.payment_confirmation_status).toUpperCase() === "DISETUJUI") {
    await updateTelegramMessage(env, message, {
      text: "✅ Pembayaran pesanan ini telah disetujui.",
      replyMarkup: customerMenuKeyboard(), clearMedia: true
    });
    return;
  }
  if (CANCELLED_ORDER_STATUSES.includes(String(order.status || "").toUpperCase())) {
    await updateTelegramMessage(env, message, {
      text: "⛔ Pesanan ini sudah dibatalkan. QRIS tidak dapat ditampilkan kembali. Jika Anda terlanjur membayar, hubungi admin dan kirim bukti transaksi untuk rekonsiliasi.",
      replyMarkup: customerMenuKeyboard(), clearMedia: true
    });
    return;
  }
    const payment = await createOrReuseQrisPayment(env, {
    orderId: order.order_id, total: Number(order.total)
  });
  if (payment.status === "PAID") {
    await updateTelegramMessage(env, message, {
      text: "✅ Pembayaran pesanan ini telah disetujui.",
      replyMarkup: customerMenuKeyboard(), clearMedia: true
    });
    return;
  }
  await deleteTelegramMessage(env, message);
  await sendQrisPaymentScreen(env, chatId, {
    orderId: order.order_id, total: Number(order.total), sku: order.sku,
    product: order.product_name, unitPrice: Number(order.unit_price),
    quantity: Number(order.quantity), shipping: Number(order.shipping || 0)
  });
}

async function handleQrisStatusCheck(env, message, chatId, userId, orderId) {
  if (!isQrisCheckoutAvailable(env)) throw new Error("QRIS internal belum diaktifkan.");
  const order = await findOrderTransactional(env, orderId);
  if (!order || String(order.customer_id) !== String(userId)) throw new Error("Pesanan tidak ditemukan untuk akun Telegram ini.");
  const payment = await getQrisPaymentForOrder(env, orderId);
  if (!payment) throw new Error("QRIS untuk pesanan ini belum dibuat. Buka kembali detail pesanan untuk membuat QR.");
  if (payment.status === "PAID" || String(order.payment_confirmation_status).toUpperCase() === "DISETUJUI") {
    await updateTelegramMessage(env, message, {
      text: "✅ Pembayaran QRIS untuk " + orderId + " sudah disetujui. Resi tersedia di menu Pesanan Saya.",
      replyMarkup: customerMenuKeyboard(), clearMedia: true
    });
    return;
  }
  const ocrText = payment.ocr_status === "MATCHED"
    ? "Pembacaan bukti: nominal, merchant, dan waktu cocok."
    : payment.ocr_status === "MISMATCH"
      ? "Pembacaan bukti menemukan data yang tidak cocok."
      : payment.ocr_status === "UNAVAILABLE"
        ? "Pembacaan otomatis belum tersedia; admin akan memeriksa bukti."
        : payment.receipt_file_id ? "Bukti sudah diterima dan menunggu pemeriksaan admin."
          : "Belum ada bukti pembayaran yang diunggah.";
  await updateTelegramMessage(env, message, {
    text: "⏳ STATUS PEMBAYARAN QRIS\nPesanan: " + orderId +
      "\nNominal yang harus dibayar: " + rupiah(payment.expected_amount) +
      "\nStatus: " + String(payment.status || "PENDING") +
      "\n" + ocrText +
      "\n\nOCR hanya mencocokkan isi gambar. Pembayaran baru disahkan setelah admin memastikan transaksi masuk.",
    replyMarkup: { inline_keyboard: [
      [{ text: "📎 Upload / Kirim Ulang Bukti", callback_data: "pc:req:" + orderId }],
      [{ text: "📦 Pesanan Saya", callback_data: "nav:orders" }]
    ] },
    clearMedia: true
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function runQrisReceiptOcr(env, fileId, mimeType) {
  if (!env.AI || typeof env.AI.run !== "function") {
    return { status: "UNAVAILABLE", extraction: {}, evaluation: null, reason: "WORKERS_AI_BINDING_MISSING" };
  }
  const mime = String(mimeType || "").toLowerCase();
  if (!["image/jpeg","image/png","image/webp"].includes(mime)) {
    return { status: "UNAVAILABLE", extraction: {}, evaluation: null, reason: "IMAGE_OCR_ONLY_PDF_REQUIRES_MANUAL_REVIEW" };
  }
  const metaResponse = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN +
    "/getFile?file_id=" + encodeURIComponent(fileId));
  const meta = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok || !meta.ok || !meta.result?.file_path) throw new Error("TELEGRAM_PROOF_FILE_LOOKUP_FAILED");
  const fileResponse = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_TOKEN + "/" + meta.result.file_path);
  if (!fileResponse.ok) throw new Error("TELEGRAM_PROOF_DOWNLOAD_FAILED");
  const bytes = new Uint8Array(await fileResponse.arrayBuffer());
  if (!bytes.length || bytes.byteLength > 4 * 1024 * 1024) {
    return { status: "UNAVAILABLE", extraction: {}, evaluation: null, reason: "PROOF_IMAGE_SIZE_LIMIT" };
  }
  const image = "data:" + mime + ";base64," + bytesToBase64(bytes);
  const response = await env.AI.run("@cf/moondream/moondream3.1-9B-A2B", {
    task: "query",
    image,
    question: "Baca screenshot bukti pembayaran Indonesia ini. Ekstrak HANYA data yang benar-benar terlihat. Balas JSON valid saja dengan properti amount (integer rupiah tanpa pemisah atau null), merchant_name (string atau null), transaction_datetime (string format ISO 8601 atau null), transaction_reference (string atau null), confidence (angka 0 sampai 1). Jangan menebak data yang tidak terlihat. Jangan menyatakan pembayaran asli atau dana sudah diterima."
  });
  const raw = String(response?.answer || response?.response || response?.description || response?.result || "");
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { status: "REVIEW", extraction: { raw_text: raw.slice(0, 1200) }, evaluation: null, reason: "OCR_RESPONSE_NOT_JSON" };
  let extracted;
  try { extracted = JSON.parse(jsonMatch[0]); }
  catch { return { status: "REVIEW", extraction: { raw_text: raw.slice(0, 1200) }, evaluation: null, reason: "OCR_JSON_INVALID" }; }
  return { status: "EXTRACTED", extraction: {
    amount: extracted.amount ?? extracted.amount_idr ?? null,
    merchant_name: String(extracted.merchant_name || "").slice(0,100),
    transaction_datetime: String(extracted.transaction_datetime || extracted.transaction_at || "").slice(0,100),
    transaction_reference: String(extracted.transaction_reference || extracted.reference || "").slice(0,120),
    confidence: Number.isFinite(Number(extracted.confidence)) ? Number(extracted.confidence) : null
  }, evaluation: null, reason: "" };
}


async function resolveActiveOrderIdForProof(env, userId, replyText = "") {
  const match = String(replyText || "").match(/ORDER_ID=([A-Za-z0-9_-]{1,60})/);
  if (match) return match[1];
  const pendingKv = await getPendingProofOrder(env, userId);
  if (pendingKv?.orderId) return String(pendingKv.orderId);
  if (env?.DB) {
    try {
      const row = await env.DB.prepare(
        "SELECT order_id FROM orders WHERE customer_id = ? " +
        "AND UPPER(payment_method) <> 'COD' " +
        "AND UPPER(status) NOT IN ('DIBATALKAN','CANCELLED','CANCELED','DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED') " +
        "AND COALESCE(UPPER(payment_confirmation_status), '') <> 'DISETUJUI' " +
        "ORDER BY created_ms DESC LIMIT 1"
      ).bind(String(userId)).first();
      if (row?.order_id) return String(row.order_id);
    } catch {}
  }
  return "";
}

async function requestPaymentVerification(env, message, chatId, userId, orderId) {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Admin perlu menjalankan /migrasi_d1.");
  if (!state.ready) await ensurePaymentWorkflowHeaders(env);
  const found = await findOrderById(env, orderId);
  if (!found) throw new Error("Pesanan tidak ditemukan.");
  let r = found.row;
  if (String(r[3] || "") !== String(userId)) throw new Error("Pesanan ini bukan milik akun Telegram Anda.");
  const method = String(r[11] || "").trim().toUpperCase();
  if (method === "COD") throw new Error("Pesanan COD dibayar saat pengambilan dan tidak memakai verifikasi pembayaran online.");
  if (method === "QRIS" && isQrisCheckoutAvailable(env)) {
    const payment = await getQrisPaymentForOrder(env, orderId);
    if (!payment) throw new Error("QRIS pesanan belum dibuat. Tampilkan QR pembayaran terlebih dahulu.");
    if (payment.status === "PAID") throw new Error("Pembayaran pesanan ini sudah disetujui.");
  }
  if (!["QRIS","TRANSFER","TRANSFER_BANK","USDT","PAYPAL","STARS"].includes(method)) throw new Error("Metode pembayaran tidak didukung untuk verifikasi online.");
  if (PAID_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase()) && String(r[18] || "")) {
    await sendPickupReceipt(env, String(r[3]), r, orderId, String(r[18]));
    await sendVerifiedProductClaimToCustomer(env, String(r[3]), r, String(r[18]), { actor: "already-verified" });
    await updateTelegramMessage(env, message, { text: "✅ Pembayaran pesanan ini sudah diverifikasi. Resi pengambilan telah dikirim kembali.", replyMarkup: customerMenuKeyboard(), clearMedia: true });
    return;
  }
  if (CANCELLED_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase())) throw new Error("Pesanan ini sudah dibatalkan.");
  if (!["MENUNGGU_PEMBAYARAN", "DITOLAK"].includes(String(r[12] || "").toUpperCase()) &&
      String(r[13] || "").toUpperCase() !== "MENUNGGU_VERIFIKASI") {
    throw new Error("Status pesanan tidak mengizinkan permintaan verifikasi pembayaran.");
  }
  await setPendingProofOrder(env, userId, orderId);
  const langPref = await getUserLang(env, userId);
  const isEn = normalizeLang(langPref?.lang) === "en";
  if (state.ready) {
    const updated = await requestVerificationTransactional(env,orderId,userId);
    r = orderToSheetRow(updated);
    await mirrorTransactionalOrder(env,updated);
  } else if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") {
    const requestedAt = new Date().toISOString();
    await updateSheetRange(env, "Pesanan!N" + found.rowNumber + ":T" + found.rowNumber,
      [["MENUNGGU_VERIFIKASI", "", "", requestedAt, "", "", ""]]);
  }
  if (String(r[13] || "") === "MENUNGGU_VERIFIKASI") {
    await updateTelegramMessage(env, message, {
      text: isEn
        ? "⏳ Verification request for " + orderId + " is active. Send your payment screenshot directly in this chat (or reply to the prompt below) for automatic validation."
        : "⏳ Permintaan verifikasi untuk " + orderId + " sudah tercatat. Kirim foto atau dokumen bukti pembayaran langsung di chat ini (atau balas pesan instruksi bot) untuk validasi otomatis.",
      replyMarkup: customerMenuKeyboard(), clearMedia: true
    });
    await sendTelegram(env, chatId, paymentProofPrompt(orderId), {
      force_reply: true,
      input_field_placeholder: isEn ? "Attach payment screenshot/document" : "Lampirkan foto/dokumen bukti pembayaran"
    });
    const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
    for (const adminId of admins) {
      try {
        await sendTelegram(env, adminId,
          "🔔 Permintaan verifikasi pembayaran baru\nPesanan: " + orderId + "\nPelanggan: " + String(r[4] || "-") + "\nTotal: " + rupiah(r[10]),
          { inline_keyboard: [[{ text: "Periksa Permintaan", callback_data: "payview:" + (found.rowNumber || orderId) }]] });
      } catch (error) {
        console.warn(JSON.stringify({ level: "warn", event: "payment_admin_notify", message: error.message }));
      }
    }
    return;
  }
  await updateTelegramMessage(env, message, {
    text: "✅ Permintaan verifikasi pembayaran untuk " + orderId + " telah dikirim ke admin.\n\nSilakan lampirkan bukti transfer/QRIS dengan membalas pesan instruksi bot. Resi pengambilan akan dikirim setelah admin menyetujui pembayaran.",
    replyMarkup: customerMenuKeyboard(), clearMedia: true
  });
  await sendTelegram(env, chatId, paymentProofPrompt(orderId), { force_reply: true, input_field_placeholder: "Lampirkan foto/dokumen bukti pembayaran" });
}
async function handlePaymentProofUpload(env, message, chatId, userId) {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap.");
  if (!state.ready) await ensurePaymentWorkflowHeaders(env);
  const [langPref, intlConfig] = await Promise.all([
    getUserLang(env, userId),
    loadIntlPaymentConfig(env)
  ]);
  const lang = normalizeLang(langPref?.lang);
  const isEn = lang === "en";
  const prompt = String(message.reply_to_message?.text || "");
  const orderId = await resolveActiveOrderIdForProof(env, userId, prompt);
  if (!orderId) {
    throw new Error(
      isEn
        ? "No active unpaid order found. Please select a product and create an order first."
        : "Instruksi bukti pembayaran tidak valid. Ajukan verifikasi ulang dari menu Pesanan Saya."
    );
  }
  const found = await findOrderById(env, orderId);
  if (!found) throw new Error("Pesanan tidak ditemukan.");
  let r = found.row;
  if (String(r[3] || "") !== String(userId)) throw new Error("Pesanan ini bukan milik akun Telegram Anda.");
  const method = String(r[11] || "").trim().toUpperCase();
  if (String(r[13] || "").toUpperCase() === "DISETUJUI" && r[18]) {
    await sendVerifiedProductClaimToCustomer(env, userId, r, String(r[18]), { actor: "already-verified" });
    return;
  }
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") {
    if (state.ready && ["MENUNGGU_PEMBAYARAN", "DITOLAK"].includes(String(r[12] || "").toUpperCase()) && method !== "COD") {
      const updated = await requestVerificationTransactional(env, orderId, userId);
      r = orderToSheetRow(updated);
      await mirrorTransactionalOrder(env, updated);
    } else {
      throw new Error("Permintaan pembayaran tidak sedang menunggu verifikasi.");
    }
  }

  let fileId = "", fileType = "", fileUniqueId = "", mimeType = "";
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    if (Number(photo.file_size || 0) > 10 * 1024 * 1024) throw new Error("Ukuran bukti pembayaran maksimal 10 MB.");
    fileId = String(photo.file_id || "");
    fileUniqueId = String(photo.file_unique_id || "");
    fileType = "PHOTO";
    mimeType = "image/jpeg";
  } else if (message.document?.file_id) {
    mimeType = String(message.document.mime_type || "").toLowerCase();
    const allowedMime = ["application/pdf","image/jpeg","image/png","image/webp"];
    if (mimeType && !allowedMime.includes(mimeType)) throw new Error("Bukti dokumen harus berupa PDF, JPG, PNG, atau WebP.");
    if (Number(message.document.file_size || 0) > 10 * 1024 * 1024) throw new Error("Ukuran bukti pembayaran maksimal 10 MB.");
    fileId = String(message.document.file_id);
    fileUniqueId = String(message.document.file_unique_id || "");
    fileType = "DOCUMENT";
  } else {
    await sendTelegram(env, chatId, "Mohon kirim bukti sebagai foto atau dokumen dengan membalas pesan instruksi sebelumnya.");
    return;
  }

  const isQris = method === "QRIS" && isQrisCheckoutAvailable(env);
  let qrisPayment = null;
  if (isQris) {
    qrisPayment = await getQrisPaymentForOrder(env, orderId);
    if (!qrisPayment) throw new Error("Data QRIS pesanan tidak ditemukan. Hubungi admin.");
    if (qrisPayment.receipt_file_unique_id && qrisPayment.receipt_file_unique_id === fileUniqueId) {
      await sendTelegram(env, chatId, "ℹ️ Bukti yang sama sudah pernah diterima. Admin tetap dapat melihat hasil pemeriksaan sebelumnya.");
      return;
    }
  }

  if (state.ready) {
    const updated = await updateProofTransactional(env,orderId,userId,fileId,fileType);
    await mirrorTransactionalOrder(env,updated);
  } else {
    await updateSheetRange(env, "Pesanan!O" + found.rowNumber + ":P" + found.rowNumber, [[fileId, fileType]]);
  }

  let ocrStatus = "NOT_RUN";
  let ocrSummary = "OCR tidak diperlukan untuk metode pembayaran ini.";
  if (isQris && qrisPayment) {
    let ocr = { status: "UNAVAILABLE", extraction: {}, evaluation: null, reason: "OCR_UNAVAILABLE" };
    try {
      ocr = await runQrisReceiptOcr(env, fileId, mimeType);
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn", event: "qris_receipt_ocr", order_id: orderId,
        message: String(error?.message || "OCR_FAILED").slice(0,160)
      }));
      ocr = { status: "REVIEW", extraction: {}, evaluation: null, reason: "OCR_PROCESSING_ERROR" };
    }

    let evaluation = ocr.evaluation;
    if (ocr.status === "EXTRACTED") {
      evaluation = evaluateQrisReceipt({
        expectedAmount: Number(qrisPayment.expected_amount),
        merchantName: String(qrisPayment.merchant_name || ""),
        createdAt: String(qrisPayment.created_at || "")
      }, ocr.extraction);
      if (evaluation.reference) {
        const duplicateRef = await env.DB.prepare(
          "SELECT order_id FROM qris_payments WHERE ocr_reference=? AND order_id<>? LIMIT 1"
        ).bind(evaluation.reference,orderId).first();
        if (duplicateRef) {
          evaluation.status = "MISMATCH";
          evaluation.reasons.push("TRANSACTION_REFERENCE_ALREADY_USED");
          evaluation.reference = "";
        }
      }
      ocrStatus = evaluation.status;
    } else {
      ocrStatus = ocr.status === "UNAVAILABLE" ? "UNAVAILABLE" : "REVIEW";
    }

    const duplicateFile = fileUniqueId
      ? await env.DB.prepare("SELECT order_id FROM qris_payments WHERE receipt_file_unique_id=? AND order_id<>? LIMIT 1")
          .bind(fileUniqueId,orderId).first()
      : null;
    if (duplicateFile) {
      ocrStatus = "MISMATCH";
      evaluation = evaluation || { amount: null, merchantName: "", transactionAt: "", reference: "", confidence: null, reasons: [] };
      evaluation.status = "MISMATCH";
      evaluation.reasons.push("RECEIPT_FILE_ALREADY_USED");
    }

    const paymentStatus = ocrStatus === "MATCHED" ? "OCR_MATCHED"
      : ocrStatus === "MISMATCH" ? "OCR_MISMATCH" : "REVIEW";
    const extractedAmount = evaluation?.amount ?? null;
    const extractedMerchant = evaluation?.merchantName || ocr.extraction?.merchant_name || "";
    const extractedAt = evaluation?.transactionAt || "";
    const extractedRef = duplicateFile ? "" : (evaluation?.reference || "");
    const checkedAt = new Date().toISOString();
    const resultJson = JSON.stringify({
      status: ocrStatus,
      reason: duplicateFile ? "RECEIPT_FILE_ALREADY_USED" : (ocr.reason || ""),
      extraction: ocr.extraction || {},
      evaluation: evaluation || null
    }).slice(0, 8000);
    await env.DB.prepare(
      "UPDATE qris_payments SET status=?,receipt_file_id=?,receipt_file_unique_id=?,receipt_file_type=?," +
      "receipt_uploaded_at=?,ocr_status=?,ocr_result_json=?,ocr_amount=?,ocr_merchant_name=?," +
      "ocr_transaction_at=?,ocr_reference=?,ocr_confidence=?,ocr_checked_at=?,updated_at=? WHERE order_id=?"
    ).bind(paymentStatus,fileId,duplicateFile ? "" : fileUniqueId,mimeType || fileType,checkedAt,
      ocrStatus,resultJson,extractedAmount,extractedMerchant,extractedAt,extractedRef,
      evaluation?.confidence ?? null,checkedAt,checkedAt,orderId).run();

    const moneyText = extractedAmount === null ? "nominal tidak terbaca" : rupiah(extractedAmount);
    ocrSummary = "Pembacaan otomatis: " + ocrStatus + " (" + moneyText + ").";
    const qrisAutoMatch = !duplicateFile && ocrStatus !== "MISMATCH" && (
      ocrStatus === "MATCHED" ||
      (extractedAmount !== null && Number(extractedAmount) === Number(qrisPayment.expected_amount))
    );
    if (qrisAutoMatch && intlConfig.auto_verify_qris_ocr) {
      try {
        const approved = await approvePaymentAndIssueTicket(env, orderId, "auto:qris-ocr");
        if (!approved.alreadyApproved) {
          try { await sendPickupReceipt(env, String(approved.row[3]), approved.row, String(approved.row[0]), approved.receiptCode); } catch {}
        }
        await sendVerifiedProductClaimToCustomer(env, userId, approved.row, approved.receiptCode, {
          proofFileId: fileId,
          proofType: fileType,
          actor: "auto:qris-ocr"
        });
        return;
      } catch (autoErr) {
        console.warn(JSON.stringify({ level: "warn", event: "qris_auto_verify_fallback", order_id: orderId, message: String(autoErr?.message || autoErr).slice(0, 140) }));
      }
    }

    if (ocrStatus === "MATCHED") {
      await sendTelegram(env, chatId, "✅ Bukti diterima. Pembacaan gambar menemukan nominal, merchant, dan waktu yang cocok. Admin tetap akan memastikan dana masuk sebelum pesanan disahkan.");
    } else if (ocrStatus === "MISMATCH") {
      await sendTelegram(
        env,
        chatId,
        isEn
          ? "⚠️ Proof received, but automatic verification detected an amount mismatch or duplicate receipt. Please upload a valid payment screenshot matching the exact total + unique code."
          : "⚠️ Bukti diterima, tetapi pembacaan otomatis menemukan data yang tidak cocok atau bukti pernah digunakan. Admin akan memeriksa bukti dan mutasi transaksi.",
        { inline_keyboard: [[{ text: isEn ? "📎 Re-upload Payment Proof" : "📎 Kirim Ulang Bukti", callback_data: "pc:req:" + orderId, style: "primary" }]] }
      );
    } else {
      await sendTelegram(env, chatId, "✅ Bukti diterima. Sebagian data belum terbaca otomatis; admin akan memeriksanya secara manual.");
    }
  } else {
    // Non-QRIS methods (USDT, TRANSFER, PAYPAL, STARS): check anti-duplicate screenshot & auto-validate
    let duplicateNonQris = false;
    if (fileUniqueId && env?.DB) {
      try {
        const existingUid = await env.DB.prepare("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
          .bind("proof_uid:" + fileUniqueId).first();
        if (existingUid?.value && String(existingUid.value) !== String(orderId)) {
          duplicateNonQris = true;
        }
      } catch {}
    }

    if (duplicateNonQris) {
      await sendTelegram(
        env,
        chatId,
        isEn
          ? "⚠️ This payment screenshot has already been used for another order. Please upload a valid screenshot for order " + orderId + "."
          : "⚠️ Screenshot bukti pembayaran ini sudah pernah digunakan pada pesanan lain. Mohon kirim screenshot bukti transaksi yang valid untuk " + orderId + ".",
        { inline_keyboard: [[{ text: isEn ? "📎 Re-upload Screenshot" : "📎 Kirim Ulang Bukti", callback_data: "pc:req:" + orderId, style: "primary" }]] }
      );
      return;
    }

    if (intlConfig.auto_verify_non_qris_proof) {
      try {
        if (fileUniqueId && env?.DB) {
          await env.DB.prepare(
            "INSERT INTO app_meta(key, value, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
          ).bind("proof_uid:" + fileUniqueId, String(orderId), new Date().toISOString()).run();
        }
        const approved = await approvePaymentAndIssueTicket(env, orderId, "auto:proof-" + method.toLowerCase());
        if (!approved.alreadyApproved) {
          try { await sendPickupReceipt(env, String(approved.row[3]), approved.row, String(approved.row[0]), approved.receiptCode); } catch {}
        }
        await sendVerifiedProductClaimToCustomer(env, userId, approved.row, approved.receiptCode, {
          proofFileId: fileId,
          proofType: fileType,
          actor: "auto:proof-" + method.toLowerCase()
        });
        return;
      } catch (autoErr) {
        console.warn(JSON.stringify({ level: "warn", event: "non_qris_auto_verify_fallback", order_id: orderId, message: String(autoErr?.message || autoErr).slice(0, 140) }));
      }
    }

    await sendTelegram(env, chatId, "✅ Bukti pembayaran untuk " + orderId + " berhasil diterima. Admin akan memeriksanya.");
  }

  const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  for (const adminId of admins) {
    try {
      await sendTelegram(env, adminId,
        "📎 Bukti pembayaran diunggah\nPesanan: " + orderId + "\nPelanggan: " + String(r[4] || "-") +
        (isQris ? "\n" + ocrSummary + "\n⚠️ OCR bukan konfirmasi dana masuk; cocokkan mutasi merchant." : ""),
        { inline_keyboard: [[{ text: "Lihat Bukti & Verifikasi", callback_data: "payview:" + (found.rowNumber || orderId) }]] });
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "payment_proof_notify", message: error.message }));
    }
  }
}

async function showPaymentRequestsPage(env, message, page = 0) {
  const state = await transactionReadiness(env);
  if (!state.ready) await ensurePaymentWorkflowHeaders(env);
  const pending = state.ready
    ? (await listOrdersTransactional(env,{limit:5000}))
        .filter(o => String(o.payment_confirmation_status || "") === "MENUNGGU_VERIFIKASI")
        .map(o => ({r:orderToSheetRow(o),reference:o.order_id}))
    : (await readSheet(env, "Pesanan!A2:T")).map((r,i) => ({r,reference:String(i+2)}))
        .filter(x => String(x.r[13] || "") === "MENUNGGU_VERIFIKASI").reverse();
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(pending.length / pageSize));
  const current = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
  const subset = pending.slice(current * pageSize, current * pageSize + pageSize);
  const screen = renderAdminPaymentQueueScreen({ subset, current, pages, total: pending.length });
  await updateTelegramMessage(env, message, {
    text: screen.text,
    parseMode: screen.parseMode,
    replyMarkup: screen.replyMarkup,
    clearMedia: true
  });
}
async function showPaymentRequestDetail(env, message, reference) {
  const found = await resolveOrderReference(env,reference);
  const r = found?.row;
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan ini sudah diproses atau tidak lagi menunggu verifikasi.");
  const ref = String(reference);
  let qrisPayment = null;
  if (String(r[11] || "").toUpperCase() === "QRIS" && env.DB) {
    try { qrisPayment = await getQrisPaymentForOrder(env,String(r[0])); } catch {}
  }
  const qrisMismatch = Boolean(qrisPayment && (
    String(qrisPayment.ocr_status || "").toUpperCase() === "MISMATCH"
    || String(qrisPayment.status || "").toUpperCase() === "OCR_MISMATCH"
    || (qrisPayment.ocr_amount !== null && qrisPayment.ocr_amount !== undefined
      && Number(qrisPayment.ocr_amount) !== Number(qrisPayment.expected_amount))
  ));
  const screen = renderAdminPaymentDetailScreen({ row: r, reference: ref, qrisPayment, qrisMismatch });
  if (r[14] && r[15] === "PHOTO") {
    await updateTelegramMessage(env, message, { text: screen.text, parseMode: screen.parseMode, photo: String(r[14]), replyMarkup: screen.replyMarkup });
  } else {
    await updateTelegramMessage(env, message, { text: screen.text, parseMode: screen.parseMode, replyMarkup: screen.replyMarkup, clearMedia: true });
    if (r[14] && r[15] === "DOCUMENT") await sendTelegramDocumentById(env, message.chat.id, String(r[14]), "Bukti pembayaran " + r[0]);
  }
}

async function approvePaymentAndIssueTicket(env, reference, actor = "telegram-admin") {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const method = String(found.order.payment_method || "").toUpperCase();
    if (String(found.order.payment_confirmation_status || "").toUpperCase() === "DISETUJUI" && found.order.receipt_code) {
      const row = orderToSheetRow(found.order);
      return { row, receiptCode: String(found.order.receipt_code), ticketUrl: "", rowNumber: found.order.legacy_sheet_row, alreadyApproved: true };
    }

    if (method === "QRIS") {
      const qrisPayment = await getQrisPaymentForOrder(env,found.order.order_id);
      if (!qrisPayment || !qrisPayment.receipt_file_id) {
        throw new Error("Bukti QRIS belum tersedia. Minta pelanggan mengunggah bukti sebelum verifikasi.");
      }
      const baseAmount = Number(qrisPayment.base_amount);
      const uniqueCode = Number(qrisPayment.unique_code);
      const expectedAmount = Number(qrisPayment.expected_amount);
      if (!Number.isSafeInteger(baseAmount) || baseAmount !== Number(found.order.total)
        || !Number.isInteger(uniqueCode) || uniqueCode < 1 || uniqueCode > 999
        || !Number.isSafeInteger(expectedAmount) || expectedAmount !== baseAmount + uniqueCode) {
        throw new Error("Nominal QRIS tidak konsisten dengan total pesanan. Tahan persetujuan dan periksa transaksi.");
      }
      const ocrStatus = String(qrisPayment.ocr_status || "").toUpperCase();
      const ledgerStatus = String(qrisPayment.status || "").toUpperCase();
      if (ocrStatus === "MISMATCH" || ledgerStatus === "OCR_MISMATCH"
        || (qrisPayment.ocr_amount !== null && qrisPayment.ocr_amount !== undefined
          && Number(qrisPayment.ocr_amount) !== expectedAmount)) {
        throw new Error("Bukti QRIS terdeteksi tidak cocok dengan nominal tagihan. Minta bukti yang benar sebelum menyetujui.");
      }
      let parsedPayload;
      try { parsedPayload = parseQrisPayload(String(qrisPayment.qris_payload || "")); }
      catch { throw new Error("Payload QRIS tersimpan tidak valid. Jangan setujui pembayaran sebelum pemeriksaan manual."); }
      if (String(qrisPayment.qris_mode || "DYNAMIC") === "DYNAMIC") {
        if (parsedPayload.pointOfInitiation !== "12" || parsedPayload.amount !== expectedAmount) {
          throw new Error("Nominal di payload QRIS tidak cocok dengan tagihan. Pembayaran ditahan.");
        }
      } else if (parsedPayload.pointOfInitiation !== "11") {
        throw new Error("Mode QRIS statis tidak konsisten. Pembayaran ditahan untuk pemeriksaan.");
      }
    }

    const approved = await approvePaymentTransactional(env,found.order.order_id,actor);
    if (approved.alreadyApproved) {
      const row = orderToSheetRow(approved);
      return { row, receiptCode: String(approved.receipt_code || ""), ticketUrl: "", rowNumber: approved.legacy_sheet_row, alreadyApproved: true };
    }
    await mirrorTransactionalOrder(env,approved);
    await Promise.allSettled([
      cleanupStoredQrisMessage(env, String(approved.order_id)),
      invalidateStoreUiCaches(env)
    ]);
    const row = orderToSheetRow(approved);
    const ticketUrl = await createPickupTicketUrl(env,String(approved.order_id),String(approved.receipt_code));
    return {row,receiptCode:approved.receipt_code,ticketUrl,rowNumber:approved.legacy_sheet_row,alreadyApproved:false};
  }
  await ensurePaymentWorkflowHeaders(env);
  const rowNumber = Number(reference);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan pembayaran sudah diproses.");
  if (String(r[11] || "").toUpperCase() === "COD") throw new Error("Pesanan COD tidak menggunakan verifikasi pembayaran online.");
  if (String(r[11] || "").toUpperCase() === "QRIS" && isQrisCheckoutAvailable(env)) {
    throw new Error("Verifikasi QRIS internal memerlukan lapisan transaksi D1 aktif.");
  }
  if (CANCELLED_ORDER_STATUSES.includes(String(r[12] || "").toUpperCase())) throw new Error("Pesanan sudah dibatalkan.");
  const now = new Date().toISOString();
  const receiptCode = "SEI-" + localDateKey(now).replace(/-/g,"") + "-" + crypto.randomUUID().slice(0,6).toUpperCase();
  await updateSheetRange(env, "Pesanan!M" + rowNumber + ":T" + rowNumber, [[
    "DIBAYAR", "DISETUJUI", r[14] || "", r[15] || "", r[16] || now, now, receiptCode, "BELUM_DIAMBIL"
  ]]);
  await recordAdminActivity(env, { actorChannel: actorChannel(actor), actorId: actorIdentifier(actor), action: "PAYMENT_APPROVED", resourceType: "order", resourceId: String(r[0]), summary: { from_status: String(r[12] || ""), to_status: "DIBAYAR" } });
  const ticketUrl = await createPickupTicketUrl(env, String(r[0]), receiptCode);
  return { row:r, receiptCode, ticketUrl };
}
function digitalStockSku(category) {
  return category === "muse_starter" ? "MUSE-STARTER"
    : category === "muse_bisnis" ? "MUSE-BISNIS" : "";
}
function digitalStockCoordinator(env, category) {
  const sku = digitalStockSku(category);
  if (!sku || !env.ORDER_COORDINATOR) throw new Error("DIGITAL_STOCK_COORDINATOR_NOT_CONFIGURED");
  // Share the same per-SKU Durable Object queue used by checkout, so add/remove/claim
  // cannot race a customer order reservation.
  return env.ORDER_COORDINATOR.getByName("sku:" + sku);
}

async function deliverDigitalProductAfterPayment(env, orderId) {
  const order = await findOrderTransactional(env, String(orderId || ""));
  if (!order) return { handled: false, reason: "ORDER_NOT_FOUND" };
  const sku = String(order.sku || "").toUpperCase();
  const category = sku === "MUSE-STARTER" ? "muse_starter"
    : sku === "MUSE-BISNIS" ? "muse_bisnis" : null;

  if (category) {
    if (String(env.OTP_EMAIL_ROUTING_READY || "false").toLowerCase() !== "true") {
      throw new Error("OTP_EMAIL_ROUTING_NOT_READY");
    }
    const stub = digitalStockCoordinator(env, category);
    const claim = await stub.claimDigitalStock(category, String(order.order_id));
    if (claim.status === "WAITING_STOCK") {
      const buyerText = "Pembayaran pesanan " + order.order_id +
        " sudah dikonfirmasi. Stok akun sedang disiapkan dan pesanan masuk antrean prioritas. " +
        "Admin akan menindaklanjuti maksimal 15 menit.";
      await sendTelegram(env, String(order.customer_id), buyerText);
      const targets = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
      for (const target of targets) {
        await sendTelegram(env, target,
          "🚨 STOK DIGITAL KOSONG\nKategori: " + category +
          "\nOrder: " + order.order_id + "\nPembeli: " + String(order.customer_name || "-") +
          "\nSegera masukkan stok dengan /addstock " + category +
          " lalu jalankan /approve " + order.order_id);
      }
      return { handled: true, status: "WAITING_STOCK" };
    }
    if (claim.status === "DELIVERED") {
      return { handled: true, status: "ALREADY_DELIVERED" };
    }
    if (!claim.credentials || !claim.credentials.email || !claim.credentials.password) {
      throw new Error("DIGITAL_STOCK_CLAIM_INVALID");
    }
    const portalUrl = await createOtpPortalAccess(
      env, claim.credentials.email, order.order_id, order.customer_id
    );
    const lines = [
      "✅ PRODUK DIGITAL SEITON.ID",
      "Order: " + order.order_id,
      "Paket: " + (category === "muse_starter" ? "Muse Starter" : "Muse Bisnis"),
      "",
      "Email: " + claim.credentials.email,
      "Password: " + claim.credentials.password,
      "Portal mailbox privat (berlaku 30 hari):",
      portalUrl,
      "",
      "Jangan bagikan kredensial atau tautan portal kepada orang lain."
    ];
    if (category === "muse_bisnis") {
      lines.push("", "Setelah login, kirim detail instalasi dengan format:",
        "SETUP | Nama Usaha | Token Bot Telegram | Deskripsi Layanan",
        "Token bot hanya akan diteruskan kepada admin dan disimpan terenkripsi.");
    }
    await sendTelegram(env, String(order.customer_id), lines.join("\n"));
    await markDigitalDeliveredD1(env.DB, order.order_id);
    await recordAdminActivity(env, {
      actorChannel: "telegram",
      actorId: "system:digital-fulfillment",
      action: "DIGITAL_PRODUCT_DELIVERED",
      resourceType: "digital_order",
      resourceId: String(order.order_id),
      summary: { category, stock_domain: String(claim.credentials.email).split("@")[1] }
    });
    return { handled: true, status: "DELIVERED" };
  }

  if (sku === "OTP-SETUP") {
    const at = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO digital_fulfillments(order_id,category,status,updated_at) " +
      "VALUES(?,'otp_setup','SETUP_PENDING',?) ON CONFLICT(order_id) DO NOTHING"
    ).bind(order.order_id, at).run();
    await sendTelegram(env, String(order.customer_id),
      "✅ Pesanan Setup Portal OTP telah dikonfirmasi. Admin Seiton.id akan menghubungi Anda untuk verifikasi kepemilikan domain dan daftar mailbox yang akan diaktifkan.");
    for (const target of String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean)) {
      await sendTelegram(env, target,
        "🛠️ PESANAN SETUP PORTAL OTP\nOrder: " + order.order_id +
        "\nPelanggan: " + String(order.customer_name || "-") +
        "\nLanjutkan pemeriksaan kepemilikan domain sebelum konfigurasi Email Routing.");
    }
    return { handled: true, status: "SETUP_PENDING" };
  }
  return { handled: false, reason: "NOT_A_DIGITAL_PRODUCT" };
}

async function rejectPaymentRequest(env, reference, actor = "telegram-admin") {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const rejected = await rejectPaymentTransactional(env,found.order.order_id,actor);
    await mirrorTransactionalOrder(env,rejected);
    return orderToSheetRow(rejected);
  }
  await ensurePaymentWorkflowHeaders(env);
  const rowNumber = Number(reference);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0]) throw new Error("Pesanan tidak ditemukan.");
  if (String(r[13] || "") !== "MENUNGGU_VERIFIKASI") throw new Error("Permintaan pembayaran sudah diproses.");
  await updateSheetRange(env, "Pesanan!N" + rowNumber + ":N" + rowNumber, [["DITOLAK"]]);
  await recordAdminActivity(env, { actorChannel: actorChannel(actor), actorId: actorIdentifier(actor), action: "PAYMENT_REJECTED", resourceType: "order", resourceId: String(r[0]), summary: { payment_confirmation_status: "DITOLAK" } });
  return r;
}
async function showPickupQueuePage(env, message, page = 0) {
  const state = await transactionReadiness(env);
  if (!state.ready) await ensurePaymentWorkflowHeaders(env);
  const queue = state.ready
    ? (await listOrdersTransactional(env,{limit:5000}))
        .filter(o => String(o.payment_confirmation_status || "") === "DISETUJUI" && o.receipt_code &&
          String(o.pickup_status || "") !== "DIAMBIL" && PAID_ORDER_STATUSES.includes(String(o.status || "").toUpperCase()))
        .map(o => ({r:orderToSheetRow(o),reference:o.order_id}))
    : (await readSheet(env, "Pesanan!A2:T")).map((r,i) => ({r,reference:String(i+2)}))
        .filter(x => String(x.r[13] || "") === "DISETUJUI" && String(x.r[18] || "") &&
          String(x.r[19] || "") !== "DIAMBIL" && PAID_ORDER_STATUSES.includes(String(x.r[12] || "").toUpperCase())).reverse();
  const pageSize = 8; const pages = Math.max(1, Math.ceil(queue.length / pageSize));
  const current = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
  const subset = queue.slice(current * pageSize, current * pageSize + pageSize);
  const screen = renderAdminPickupQueueScreen({ subset, current, pages, total: queue.length });
  await updateTelegramMessage(env, message, {
    text: screen.text,
    parseMode: screen.parseMode,
    replyMarkup: screen.replyMarkup,
    clearMedia: true
  });
}
async function showPickupOrderDetail(env, message, reference) {
  const found = await resolveOrderReference(env,reference);
  const r = found?.row;
  if (!r || !r[0] || String(r[13] || "").trim().toUpperCase() !== "DISETUJUI" ||
      !r[18] || !PAID_ORDER_STATUSES.includes(String(r[12] || "").trim().toUpperCase())) {
    throw new Error("Resi pengambilan tidak ditemukan, dibatalkan, atau belum disetujui.");
  }
  const ticketUrl = await createPickupTicketUrl(env, String(r[0]), String(r[18]));
  const picked = String(r[19] || "") === "DIAMBIL";
  const screen = renderAdminPickupDetailScreen({ row: r, reference, ticketUrl, picked });
  await updateTelegramMessage(env, message, {
    text: screen.text,
    parseMode: screen.parseMode,
    replyMarkup: screen.replyMarkup,
    clearMedia: true
  });
}
async function markOrderPickedUp(env, reference, actor = "telegram-admin") {
  const state = await transactionReadiness(env);
  if (state.configured && !state.ready) throw new Error("Lapisan transaksi D1 belum siap. Jalankan /migrasi_d1.");
  if (state.ready) {
    const found = await resolveOrderReference(env,reference);
    if (!found) throw new Error("Pesanan tidak ditemukan.");
    const updated = await markPickedUpTransactional(env,found.order.order_id,actor);
    await mirrorTransactionalOrder(env,updated);
    return orderToSheetRow(updated);
  }
  await ensurePaymentWorkflowHeaders(env);
  const rowNumber = Number(reference);
  const values = await readSheet(env, "Pesanan!A" + rowNumber + ":T" + rowNumber);
  const r = values[0];
  if (!r || !r[0] || String(r[13] || "").trim().toUpperCase() !== "DISETUJUI" || !r[18] || !PAID_ORDER_STATUSES.includes(String(r[12] || "").trim().toUpperCase())) throw new Error("Pesanan tidak memiliki resi pembayaran valid atau sudah dibatalkan.");
  if (String(r[19] || "").trim().toUpperCase() === "DIAMBIL") throw new Error("Pesanan ini sudah ditandai diambil.");
  await updateSheetRange(env, "Pesanan!M" + rowNumber + ":T" + rowNumber, [[
    "SELESAI", "DISETUJUI", r[14] || "", r[15] || "", r[16] || "", r[17] || "", r[18], "DIAMBIL"
  ]]);
  await recordAdminActivity(env, { actorChannel: actorChannel(actor), actorId: actorIdentifier(actor), action: "PICKED_UP", resourceType: "order", resourceId: String(r[0]), summary: { from_status: String(r[12] || ""), to_status: "SELESAI", pickup_status: "DIAMBIL" } });
  return r;
}



function parseOrderText(text) {
  const match = text.match(/^beli\s+([A-Za-z0-9._-]{1,40})\s+((?:[1-9]\d{0,2}|1000))\s+(QRIS|TRANSFER|TRANSFER_BANK|COD)$/i);
  if (!match) return null;
  return {
    sku: match[1].toUpperCase(),
    quantity: Number(match[2]),
    paymentMethod: match[3].toUpperCase().replace("TRANSFER_BANK", "TRANSFER")
  };
}

async function createOrder(env, input) {
  const requestedMethod = String(input?.paymentMethod || "").toUpperCase();
  if (!PAYMENT_METHOD_KEYS.includes(requestedMethod)) throw new Error("Metode pembayaran tidak valid.");
  if (requestedMethod === "QRIS" && !isQrisCheckoutAvailable(env)) {
    throw new Error("QRIS belum dikonfigurasi. Pilih metode pembayaran lain.");
  }
  const transactionState = await transactionReadiness(env);
  if (transactionState.configured && !transactionState.ready) {
    throw new Error("Lapisan transaksi D1 belum siap. Admin perlu menjalankan /migrasi_d1 sebelum pesanan baru diterima.");
  }
  if (transactionState.ready) {
    const availableMethods = await getAvailablePaymentMethods(env);
    if (!availableMethods.includes(requestedMethod)) {
      throw new Error(requestedMethod === "TRANSFER"
        ? "Transfer Bank sedang tidak tersedia. Admin perlu mengaktifkan metode dan menambahkan rekening tujuan."
        : "Metode pembayaran ini sedang dinonaktifkan oleh admin. Silakan pilih metode lain.");
    }
    const shipping = env.DEFAULT_SHIPPING == null || env.DEFAULT_SHIPPING === "" ? 0 : Number(env.DEFAULT_SHIPPING);
    if (!Number.isSafeInteger(shipping) || shipping < 0) throw new Error("DEFAULT_SHIPPING harus berupa bilangan Rupiah nol atau lebih.");
    const order = await createOrderTransactional(env,{...input,shipping});
    if (!order.duplicate) {
      try {
        const stored = await findOrderTransactional(env,order.orderId);
        await mirrorTransactionalOrder(env,stored);
      } catch (error) {
        console.warn(JSON.stringify({level:"warn",event:"order_sheet_mirror_read",order_id:order.orderId,message:error.message}));
      }
    }
    return order;
  }
  if (!env.GOOGLE_SHEETS_ID || !env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    throw new Error("Google Sheets credentials are not configured");
  }
  const idempotencyKey = input.idempotencyKey
    ? `update:${String(input.channel)}:${String(input.idempotencyKey).slice(0,128)}`
    : "";
  if (env.ORDERS_KV && idempotencyKey) {
    const recent = await env.ORDERS_KV.get(idempotencyKey, "json");
    if (recent) return { ...recent, duplicate: true };
  }

  const product = await findProduct(env, input.sku);
  if (!product || !product.active) throw new Error("Produk tidak ditemukan atau sedang nonaktif");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000) {
    throw new Error("Jumlah pesanan tidak valid");
  }
  if (product.stock !== null && product.stock < input.quantity) {
    throw new Error(`Stok tidak mencukupi. Stok tersedia: ${product.stock}`);
  }

  const subtotal = product.price * input.quantity;
  const shipping = env.DEFAULT_SHIPPING == null || env.DEFAULT_SHIPPING === "" ? 0 : Number(env.DEFAULT_SHIPPING);
  if (!Number.isSafeInteger(subtotal)) throw new Error("Subtotal pesanan melebihi batas angka aman.");
  if (!Number.isSafeInteger(shipping) || shipping < 0) throw new Error("DEFAULT_SHIPPING harus berupa bilangan Rupiah nol atau lebih.");
  if (!Number.isSafeInteger(subtotal + shipping)) throw new Error("Total pesanan melebihi batas angka aman.");
  // Store Jakarta-local ISO text so spreadsheet text-prefix formulas can group by business date.
  const createdAt = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace("Z", "+07:00");
  const dateStamp = localDateKey(createdAt).replace(/-/g, "");
  const total = subtotal + shipping;
  const order = {
    orderId: `SEI-${dateStamp}-${crypto.randomUUID().slice(0,8).toUpperCase()}`,
    createdAt,
    createdMs: Date.now(),
    channel: input.channel,
    customerId: String(input.customerId),
    customerName: String(input.customerName || "Pelanggan").slice(0,100),
    product: product.name,
    sku: product.sku,
    quantity: input.quantity,
    unitPrice: product.price,
    subtotal,
    shipping,
    total,
    paymentMethod: input.paymentMethod,
    status: "MENUNGGU_PEMBAYARAN"
  };
  await appendOrder(env, order);
  if (env.ORDERS_KV && idempotencyKey) {
    try {
      await env.ORDERS_KV.put(idempotencyKey, JSON.stringify(order), { expirationTtl: 86400 });
    } catch (error) {
      console.warn(JSON.stringify({level:"warn",event:"order_dedupe_cache",order_id:order.orderId,message:error.message}));
    }
  }
  return order;
}


async function findProduct(env, sku) {
  const normalized = String(sku || "").trim().toUpperCase();
  if (!normalized) throw new Error("SKU produk tidak valid.");
  const state = await transactionReadiness(env);
  if (state.ready) {
    const p = await findProductTransactional(env,normalized);
    if (!p) return null;
    return {sku:p.sku,name:p.name,price:Number(p.price),priceValid:true,
      stock:p.stock == null ? null : Number(p.stock),stockValid:true,active:Boolean(p.active),
      photoUrl:p.photo_url || "",description:p.description || ""};
  }
  const rows = await readCatalogRows(env);
  const matches = rows.filter(row => String(row[0] || "").trim().toUpperCase() === normalized);
  if (!matches.length) return null;
  if (matches.length > 1) throw new Error("SKU duplikat ditemukan pada katalog. Hubungi admin.");
  const product = parseCatalogProduct(matches[0]);
  if (!product.priceValid) throw new Error("Harga produk pada katalog tidak valid.");
  if (!product.stockValid) throw new Error("Stok produk pada katalog tidak valid.");
  return product;
}


async function recordAdminActivity(env, entry) {
  if (!env?.DB || !entry || !entry.actorId || !entry.action) return false;
  const actorChannelValue = entry.actorChannel === "web" ? "web" : "telegram";
  const actorIdValue = String(entry.actorId).trim().slice(0, 128);
  if (!actorIdValue) return false;
  const actionValue = String(entry.action).trim().slice(0, 80);
  const resourceTypeValue = String(entry.resourceType || "admin").trim().slice(0, 40);
  const resourceIdValue = entry.resourceId == null ? null : String(entry.resourceId).trim().slice(0, 160);
  let summaryJson = "{}";
  try { summaryJson = JSON.stringify(entry.summary || {}).slice(0, 4000); } catch {}
  try {
    await env.DB.prepare(
      "INSERT INTO admin_activity_audit(audit_id,actor_channel,actor_id,action,resource_type,resource_id,summary_json,created_at_ms) " +
      "VALUES(?,?,?,?,?,?,?,?)"
    ).bind(crypto.randomUUID(), actorChannelValue, actorIdValue, actionValue,
      resourceTypeValue, resourceIdValue, summaryJson, Date.now()).run();
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      level: "error", event: "admin_activity_audit_write_failed", action: actionValue,
      code: "ADMIN_ACTIVITY_AUDIT_WRITE_FAILED"
    }));
    return false;
  }
}
function actorChannel(actor) {
  return String(actor || "").startsWith("telegram") ? "telegram" : "web";
}
function actorIdentifier(actor) {
  const value = String(actor || "");
  return value.startsWith("telegram:") ? value.slice("telegram:".length) : value;
}

function isAdmin(id, env) {
  const admins = String(env.ADMIN_CHAT_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  return admins.includes(String(id));
}

async function messagingCoreReady(env) {
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messaging_outbox' LIMIT 1"
    ).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function messagingHandoffSchemaReady(env) {
  if (!(await messagingCoreReady(env))) return false;
  try {
    await env.DB.prepare(
      "SELECT claimed_by,claimed_at,closed_by,resolution FROM messaging_handoff_requests LIMIT 0"
    ).all();
    return true;
  } catch {
    return false;
  }
}

function telegramHandoffCallback(action, handoffId) {
  const callback = "hf:" + action + ":" + String(handoffId || "");
  return new TextEncoder().encode(callback).length <= 64 ? callback : null;
}

function formatHandoffDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short"
  }).format(date);
}

async function showTelegramHandoffQueue(env, message, adminChatId, notice = "") {
  if (!(await messagingHandoffSchemaReady(env))) {
    await updateTelegramMessage(env, message, {
      text: "⚠️ <b>ANTREAN BANTUAN BELUM TERSEDIA</b>\n━━━━━━━━━━━━━━━━━━━━━━\nPeriksa migrasi D1 Messaging Core.",
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]] },
      clearMedia: true
    });
    return;
  }

  const items = await listMessagingHandoffs(env, 20, "telegram");
  if (!items.length) {
    await updateTelegramMessage(env, message, {
      text: (notice ? `<blockquote>${escapeHtml(notice)}</blockquote>\n\n` : "") +
        "🆘 <b>ANTREAN BANTUAN PELANGGAN</b>\n━━━━━━━━━━━━━━━━━━━━━━\n✅ <i>Tidak ada permintaan bantuan yang menunggu atau sedang ditangani.</i>",
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [
        [{ text: "🔄 Perbarui", callback_data: "adm:handoff", style: "primary" }],
        [{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]
      ] },
      clearMedia: true
    });
    return;
  }

  const keyboard = [];
  const cards = items.map((item, index) => {
    const claimedBy = String(item.claimed_by || "");
    const status = item.status === "OPEN" ? "🆕 MENUNGGU ADMIN" :
      claimedBy === String(adminChatId) ? "🟡 ANDA MENANGANI" : "🔒 SEDANG DITANGANI";
    const owner = item.status === "CLAIMED"
      ? "\n• Admin: " + escapeHtml(claimedBy === String(adminChatId) ? "Anda" : claimedBy)
      : "";
    if (item.status === "OPEN") {
      const row = [];
      const take = telegramHandoffCallback("take", item.handoff_id);
      const decline = telegramHandoffCallback("decline", item.handoff_id);
      if (take) row.push({ text: "✅ Terima #" + (index + 1), callback_data: take, style: "success" });
      if (decline) row.push({ text: "❌ Tolak #" + (index + 1), callback_data: decline, style: "danger" });
      if (row.length) keyboard.push(row);
    } else if (claimedBy === String(adminChatId)) {
      const done = telegramHandoffCallback("done", item.handoff_id);
      if (done) keyboard.push([{ text: "✅ Selesaikan #" + (index + 1), callback_data: done, style: "success" }]);
    }
    return `<b>${index + 1}. ${escapeHtml(String(item.customer_name || "Pelanggan"))}</b>\n• Status: ${status}\n• Kanal: <code>${escapeHtml(item.source_channel)}</code>\n• Waktu: ${escapeHtml(formatHandoffDate(item.created_at))}` + owner;
  });

  keyboard.push([{ text: "🔄 Perbarui antrean", callback_data: "adm:handoff", style: "primary" }]);
  keyboard.push([{ text: "⬅️ Menu Admin", callback_data: "adm:home" }]);
  await updateTelegramMessage(env, message, {
    text: (notice ? `<blockquote>${escapeHtml(notice)}</blockquote>\n\n` : "") +
      "🆘 <b>ANTREAN BANTUAN PELANGGAN</b>\n━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Pilih tindakan pada setiap permintaan:\n\n" + cards.join("\n\n"),
    parseMode: "HTML",
    replyMarkup: { inline_keyboard: keyboard },
    clearMedia: true
  });
}

function telegramMessagingEvent(update, message, textOverride = null) {
  const chatId = String(message.chat.id);
  const senderId = String(message.from.id);
  return {
    tenantId: "seiton",
    channel: "telegram",
    eventId: "telegram:" + String(update.update_id ?? (chatId + ":" + message.message_id)),
    externalMessageId: String(message.message_id ?? update.update_id ?? ""),
    conversationId: chatId,
    senderId,
    customerName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "Pelanggan",
    text: textOverride == null ? String(message.text || message.caption || "").trim() : textOverride,
    fromMe: false,
    isDirect: !message.chat.type || message.chat.type === "private",
    occurredAt: new Date().toISOString()
  };
}

function createMessagingServices(env) {
  return {
    async listProducts() {
      const rows = await readTelegramCatalogRows(env);
      return rows.map(parseCatalogProduct).filter(product =>
        product.priceValid && product.stockValid
      ).map(product => ({
        sku: product.sku,
        name: product.name,
        price: product.price,
        stock: product.stock,
        active: product.active,
        priceValid: product.priceValid,
        stockValid: product.stockValid,
        photoUrl: product.photoUrl,
        description: product.description
      }));
    },
    async listOrders(customerId, channel) {
      const state = await transactionReadiness(env);
      if (state.ready) {
        const orders = await listOrdersTransactional(env, { limit: 5000 });
        return orders.filter(order =>
          String(order.customer_id) === String(customerId) &&
          String(order.channel) === String(channel)
        ).slice(0, 5).map(order => ({
          orderId: order.order_id,
          customerId: order.customer_id,
          channel: order.channel,
          product: String(order.sku || "") + " - " + String(order.product_name || ""),
          quantity: Number(order.quantity),
          total: Number(order.total),
          paymentMethod: order.payment_method,
          status: order.status
        }));
      }
      const rows = await readSheet(env, "Pesanan!A2:T");
      return rows.filter(row =>
        String(row[3] || "") === String(customerId) &&
        String(row[2] || "") === String(channel)
      ).slice(-5).reverse().map(row => ({
        orderId: String(row[0] || ""),
        customerId: String(row[3] || ""),
        channel: String(row[2] || ""),
        product: String(row[5] || ""),
        quantity: Number(row[6] || 0),
        total: Number(row[10] || 0),
        paymentMethod: String(row[11] || ""),
        status: String(row[12] || "")
      }));
    },
    async findOrder(orderId) {
      const found = await findOrderById(env, orderId);
      if (!found) return null;
      const row = found.row;
      return {
        orderId: String(row[0] || ""),
        customerId: String(row[3] || ""),
        channel: String(row[2] || ""),
        product: String(row[5] || ""),
        quantity: Number(row[6] || 0),
        unitPrice: Number(row[7] || 0),
        shipping: Number(row[9] || 0),
        total: Number(row[10] || 0),
        paymentMethod: String(row[11] || ""),
        status: String(row[12] || "")
      };
    },
    createOrder(input) {
      if (String(input?.paymentMethod || "").toUpperCase() === "QRIS") {
        throw new Error("Untuk QRIS, buka /start lalu pilih produk melalui tombol katalog. Bot akan mengirim QR dan nominal yang tepat.");
      }
      return createOrder(env, input);
    },
    async getPaymentInstructions(order) {
      if (String(order.paymentMethod).toUpperCase() === "QRIS") {
        return "Untuk QRIS, gunakan tombol checkout katalog agar bot menampilkan QR yang sesuai serta nominal transfer dan kode unik.";
      }
      if (String(order.paymentMethod).toUpperCase() === "TRANSFER") {
        const config = await loadPaymentMethodConfiguration(env);
        const accounts = config.bank_accounts.filter(account => account.enabled);
        if (!accounts.length) throw new Error("Rekening transfer tidak aktif. Pilih metode pembayaran lain atau hubungi admin.");
        return [
          "🏦 REKENING RESMI SEITON.ID",
          "Transfer tepat sesuai total pesanan. Jangan membulatkan nominal.",
          "",
          ...accounts.flatMap((account,index) => [
            (index+1)+". "+account.bank_name,
            "Nomor rekening: "+account.account_number,
            "Atas nama: "+account.account_holder,
            ...(account.note ? ["Catatan: "+account.note] : []),
            ""
          ]),
          "Setelah transfer, unggah bukti untuk diverifikasi admin."
        ].join("\n");
      }
      return "Pembayaran COD dipilih.";
    },
    getAdminTargets() {
      return String(env.ADMIN_CHAT_ID || "").split(",").map(value => value.trim()).filter(Boolean);
    }
  };
}

function telegramMessagingReplyMarkup(payload) {
  const buttons = Array.isArray(payload.buttons) ? payload.buttons : [];
  if (!buttons.length) return null;
  const values = new Set(buttons.map(button => String(button.value || "")));
  if (values.has("catalog") && values.has("orders") && values.has("help")) {
    return customerMenuKeyboard();
  }
  const callbackByValue = {
    catalog: "nav:catalog",
    orders: "nav:orders",
    help: "nav:help"
  };
  const rows = buttons.map(button => {
    const value = String(button.value || "");
    let callback = callbackByValue[value] || "nav:home";
    if (value.startsWith("handoff:take:")) callback = "hf:take:" + value.slice("handoff:take:".length);
    else if (value.startsWith("handoff:decline:")) callback = "hf:decline:" + value.slice("handoff:decline:".length);
    if (new TextEncoder().encode(callback).length > 64) return null;
    return [{ text: String(button.label || "Pilih").slice(0, 60), callback_data: callback }];
  }).filter(Boolean);
  return rows.length ? { inline_keyboard: rows } : null;
}

async function dispatchTelegramMessagingOutbox(env, limit = 20) {
  if (!env.DB || !env.TELEGRAM_TOKEN) return { claimed: 0, sent: 0, failed: 0 };
  const jobs = await claimMessagingOutbox(env, "telegram", limit);
  let sent = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payload_json || "{}");
      if (payload.type !== "text" || !payload.text) throw new Error("OUTBOX_PAYLOAD_INVALID");
      const isWelcome = /SELAMAT DATANG DI SEITON\.ID|Layanan otomatis Seiton/i.test(String(payload.text || ""));
      if (isWelcome) {
        await sendTelegramPhoto(
          env,
          String(job.recipient_id),
          SEITON_LOGO_URL,
          String(payload.text),
          telegramMessagingReplyMarkup(payload) || customerMenuKeyboard()
        );
      } else {
        await sendTelegram(
          env,
          String(job.recipient_id),
          String(payload.text),
          telegramMessagingReplyMarkup(payload)
        );
      }
      await completeMessagingOutbox(env, job, null);
      sent += 1;
    } catch (error) {
      await failMessagingOutbox(env, job, "TELEGRAM_SEND_FAILED");
      failed += 1;
      console.warn(JSON.stringify({
        level: "warn",
        event: "messaging_outbox_delivery_failed",
        action_id: job.action_id,
        code: error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message)
          ? error.message
          : "TELEGRAM_SEND_FAILED"
      }));
    }
  }
  return { claimed: jobs.length, sent, failed };
}


async function handleMutationIngest(request, env) {
  const token = request.headers.get("X-Device-Token") || "";
  const auth = await verifyMutationDeviceToken(env, token);
  if (!auth.ok) {
    return json({ ok: false, error: "Device token tidak valid." }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Payload JSON tidak valid." }, 400);
  }

  const nowIso = new Date().toISOString();
  if (env?.DB && auth.deviceId !== "env-device") {
    try {
      await env.DB.prepare("UPDATE payment_listener_devices SET last_seen_at=? WHERE device_id=?")
        .bind(nowIso, auth.deviceId).run();
    } catch {
      // Best-effort heartbeat update.
    }
  }

  const parsed = parseMutationNotification(body);
  if (auth.allowedApps?.length && parsed.sourceApp && !auth.allowedApps.includes(parsed.sourceApp)) {
    return json({ ok: true, status: "IGNORED", reason: "APP_NOT_ALLOWED" });
  }

  const dedupeKey = await buildMutationDedupeKey(parsed);
  const mutationId = "mut_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const initialStatus = parsed.accepted ? "UNMATCHED" : "IGNORED";

  if (env?.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO payment_mutations
          (mutation_id, device_id, source_app, title, body, extracted_amount, dedupe_key, match_status, match_note, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        mutationId,
        auth.deviceId,
        parsed.sourceApp || "unknown",
        parsed.title,
        parsed.body,
        parsed.amount,
        dedupeKey,
        initialStatus,
        parsed.accepted ? "" : parsed.reason,
        nowIso,
        parsed.accepted ? "" : nowIso
      ).run();
    } catch (error) {
      if (String(error?.message || "").toLowerCase().includes("unique")) {
        return json({ ok: true, status: "DUPLICATE" });
      }
      return json({ ok: false, error: "Gagal mencatat mutasi ke database." }, 500);
    }
  }

  if (!parsed.accepted) {
    return json({ ok: true, status: "IGNORED", reason: parsed.reason, mutation_id: mutationId });
  }

  const state = await transactionReadiness(env);
  if (!state.ready) {
    return json({ ok: false, error: "Lapisan transaksi D1 belum siap." }, 503);
  }

  const candidate = await env.DB.prepare(
    `SELECT qp.order_id, qp.provider_order_id, qp.base_amount, qp.unique_code, qp.expected_amount, qp.expires_at
     FROM qris_payments qp
     JOIN orders o ON o.order_id = qp.order_id
     WHERE qp.expected_amount = ?
       AND qp.status NOT IN ('PAID', 'FAILED')
       AND o.status NOT IN ('DIBATALKAN', 'CANCELLED', 'CANCELED')
       AND COALESCE(o.payment_confirmation_status, '') <> 'DISETUJUI'
     ORDER BY qp.created_at DESC LIMIT 1`
  ).bind(parsed.amount).first();

  if (!candidate) {
    await env.DB.prepare(
      "UPDATE payment_mutations SET match_status='UNMATCHED', match_note='NO_ACTIVE_ORDER', processed_at=? WHERE mutation_id=?"
    ).bind(new Date().toISOString(), mutationId).run();
    return json({ ok: true, status: "UNMATCHED", mutation_id: mutationId, extracted_amount: parsed.amount });
  }

  const expiresMs = Date.parse(String(candidate.expires_at || ""));
  if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
    await env.DB.prepare(
      "UPDATE payment_mutations SET match_status='UNMATCHED', matched_order_id=?, match_note='ORDER_EXPIRED', processed_at=? WHERE mutation_id=?"
    ).bind(String(candidate.order_id), new Date().toISOString(), mutationId).run();
    return json({ ok: true, status: "UNMATCHED", reason: "ORDER_EXPIRED", mutation_id: mutationId });
  }

  try {
    const actor = "qris-mutation:" + auth.deviceId;
    const approved = await approvePaymentByMutationTransactional(
      env,
      String(candidate.order_id),
      { mutationId, sourceApp: parsed.sourceApp, amount: parsed.amount },
      actor
    );
    await env.DB.prepare(
      "UPDATE payment_mutations SET match_status='MATCHED', matched_order_id=?, match_note='AUTO_APPROVED', processed_at=? WHERE mutation_id=?"
    ).bind(String(candidate.order_id), new Date().toISOString(), mutationId).run();

    let receiptSent = false;
    let webhooksEnqueued = 0;
    if (!approved.alreadyApproved) {
      await mirrorTransactionalOrder(env, approved);
      await Promise.allSettled([
        cleanupStoredQrisMessage(env, String(approved.order_id)),
        invalidateStoreUiCaches(env)
      ]);
      try {
        const row = orderToSheetRow(approved);
        await sendPickupReceipt(env, String(approved.customer_id), row, String(approved.order_id), String(approved.receipt_code));
        await sendVerifiedProductClaimToCustomer(env, String(approved.customer_id), row, String(approved.receipt_code), { actor });
        receiptSent = true;
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "mutation_receipt_delivery", order_id: approved.order_id, message: String(error?.message || error).slice(0, 200) }));
      }
      const webhookPayload = buildPaymentWebhookPayload("payment.paid", approved, candidate, parsed);
      const queued = await enqueuePaymentWebhookDeliveries(env, "payment.paid", webhookPayload);
      webhooksEnqueued = queued.enqueued;
      if (queued.enqueued > 0) {
        await dispatchPaymentWebhookDeliveries(env, 10).catch(() => {});
      }
    }

    return json({
      ok: true,
      status: "MATCHED",
      mutation_id: mutationId,
      order_id: String(approved.order_id),
      receipt_code: String(approved.receipt_code || ""),
      already_approved: Boolean(approved.alreadyApproved),
      receipt_sent: receiptSent,
      webhooks_enqueued: webhooksEnqueued
    });
  } catch (error) {
    const errMsg = String(error?.message || error).slice(0, 200);
    await env.DB.prepare(
      "UPDATE payment_mutations SET match_status='APPROVAL_FAILED', matched_order_id=?, match_note=?, processed_at=? WHERE mutation_id=?"
    ).bind(String(candidate.order_id), errMsg, new Date().toISOString(), mutationId).run();
    return json({ ok: false, status: "APPROVAL_FAILED", mutation_id: mutationId, error: errMsg }, 409);
  }
}

async function handleAdminMutations(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ ok: false, error: "Sesi admin tidak valid atau kedaluwarsa." }, 401);
  }
  if (!env?.DB) return json({ ok: false, error: "D1 tidak tersedia." }, 503);

  if (request.method === "GET") {
    try {
      const [mutationsRes, devicesRes] = await Promise.all([
        env.DB.prepare(
          "SELECT mutation_id, device_id, source_app, title, extracted_amount, match_status, matched_order_id, match_note, received_at, processed_at FROM payment_mutations ORDER BY received_at DESC LIMIT 50"
        ).all(),
        env.DB.prepare(
          "SELECT device_id, label, allowed_apps_json, enabled, last_seen_at, created_at, revoked_at FROM payment_listener_devices ORDER BY created_at DESC LIMIT 20"
        ).all()
      ]);
      return json({ ok: true, mutations: mutationsRes.results || [], devices: devicesRes.results || [] });
    } catch {
      return json({ ok: false, error: "Tabel mutasi belum dimigrasi (0015)." }, 503);
    }
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "JSON tidak valid." }, 400); }
  const action = String(body?.action || "").trim();
  const nowIso = new Date().toISOString();

  if (action === "create_device") {
    const label = String(body?.label || "Android Listener").trim().slice(0, 80);
    const allowedApps = Array.isArray(body?.allowed_apps)
      ? body.allowed_apps.map(x => String(x || "").trim().toLowerCase()).filter(Boolean).slice(0, 20)
      : [];
    const deviceId = "dev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const rawToken = "dt_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const tokenHash = await sha256Hex(rawToken);
    await env.DB.prepare(
      "INSERT INTO payment_listener_devices (device_id, label, token_hash, allowed_apps_json, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).bind(deviceId, label, tokenHash, JSON.stringify(allowedApps), nowIso).run();
    return json({ ok: true, device_id: deviceId, label, device_token: rawToken }, 201);
  }

  if (action === "revoke_device") {
    const deviceId = String(body?.device_id || "").trim();
    if (!deviceId) return json({ ok: false, error: "device_id wajib diisi." }, 400);
    await env.DB.prepare(
      "UPDATE payment_listener_devices SET enabled=0, revoked_at=? WHERE device_id=?"
    ).bind(nowIso, deviceId).run();
    return json({ ok: true, revoked: deviceId });
  }

  return json({ ok: false, error: "Aksi tidak dikenal." }, 400);
}

async function handleAdminWebhooks(request, env) {
  if (!(await verifyDashboardAccess(request, env))) {
    return json({ ok: false, error: "Sesi admin tidak valid atau kedaluwarsa." }, 401);
  }
  if (!env?.DB) return json({ ok: false, error: "D1 tidak tersedia." }, 503);

  if (request.method === "GET") {
    try {
      const [endpointsRes, deliveriesRes] = await Promise.all([
        env.DB.prepare(
          "SELECT endpoint_id, name, target_url, events_json, enabled, created_at, updated_at FROM payment_webhook_endpoints ORDER BY created_at DESC LIMIT 20"
        ).all(),
        env.DB.prepare(
          "SELECT delivery_id, endpoint_id, order_id, event_type, target_url, status, attempts, max_attempts, last_http_status, last_error, created_at, delivered_at FROM payment_webhook_deliveries ORDER BY created_at DESC LIMIT 30"
        ).all()
      ]);
      return json({ ok: true, endpoints: endpointsRes.results || [], deliveries: deliveriesRes.results || [] });
    } catch {
      return json({ ok: false, error: "Tabel webhook belum dimigrasi (0015)." }, 503);
    }
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "JSON tidak valid." }, 400); }
  const action = String(body?.action || "").trim();
  const nowIso = new Date().toISOString();

  if (action === "save") {
    const check = validateWebhookTargetUrl(body?.target_url);
    if (!check.ok) return json({ ok: false, error: check.error }, 400);
    const name = String(body?.name || "Primary Webhook").trim().slice(0, 80);
    const enabled = body?.enabled === false ? 0 : 1;
    const events = Array.isArray(body?.events) && body.events.length
      ? body.events.map(e => String(e || "").trim()).filter(Boolean).slice(0, 10)
      : ["payment.paid"];
    const existingId = String(body?.endpoint_id || "").trim();
    if (existingId) {
      await env.DB.prepare(
        "UPDATE payment_webhook_endpoints SET name=?, target_url=?, events_json=?, enabled=?, updated_at=? WHERE endpoint_id=?"
      ).bind(name, check.url, JSON.stringify(events), enabled, nowIso, existingId).run();
      return json({ ok: true, endpoint_id: existingId, target_url: check.url });
    }
    const endpointId = "whe_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const signingSecret = "whsec_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.DB.prepare(
      "INSERT INTO payment_webhook_endpoints (endpoint_id, name, target_url, signing_secret, events_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(endpointId, name, check.url, signingSecret, JSON.stringify(events), enabled, nowIso, nowIso).run();
    return json({ ok: true, endpoint_id: endpointId, target_url: check.url, signing_secret: signingSecret }, 201);
  }

  if (action === "rotate_secret") {
    const endpointId = String(body?.endpoint_id || "").trim();
    if (!endpointId) return json({ ok: false, error: "endpoint_id wajib diisi." }, 400);
    const signingSecret = "whsec_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.DB.prepare(
      "UPDATE payment_webhook_endpoints SET signing_secret=?, updated_at=? WHERE endpoint_id=?"
    ).bind(signingSecret, nowIso, endpointId).run();
    return json({ ok: true, endpoint_id: endpointId, signing_secret: signingSecret });
  }

  if (action === "delete") {
    const endpointId = String(body?.endpoint_id || "").trim();
    if (!endpointId) return json({ ok: false, error: "endpoint_id wajib diisi." }, 400);
    await env.DB.prepare("DELETE FROM payment_webhook_endpoints WHERE endpoint_id=?").bind(endpointId).run();
    return json({ ok: true, deleted: endpointId });
  }

  if (action === "test") {
    const endpointId = String(body?.endpoint_id || "").trim();
    if (!endpointId) return json({ ok: false, error: "endpoint_id wajib diisi." }, 400);
    const row = await env.DB.prepare(
      "SELECT target_url, signing_secret FROM payment_webhook_endpoints WHERE endpoint_id=? LIMIT 1"
    ).bind(endpointId).first();
    if (!row) return json({ ok: false, error: "Endpoint webhook tidak ditemukan." }, 404);
    const testPayload = JSON.stringify({
      event: "webhook.test",
      transaction_id: "trx_test",
      external_order_id: "TEST-PING",
      base_amount: 10000,
      unique_code: 7,
      total_amount: 10007,
      paid_at: nowIso,
      created_at: nowIso
    });
    const res = await deliverSingleWebhook(row.target_url, row.signing_secret, "webhook.test", testPayload, "whd_test_" + Date.now(), 1);
    return json({ ok: res.ok, http_status: res.status, error: res.error || "" }, res.ok ? 200 : 502);
  }

  return json({ ok: false, error: "Aksi webhook tidak dikenal." }, 400);
}

export {
  pruneAdminLoginAttempts,
  pruneAdminWebSessions,
  messagingCoreReady,
  dispatchTelegramMessagingOutbox,
  dispatchOperationalAlerts,
  dispatchSheetsMirrorOutbox,
  dispatchPaymentWebhookDeliveries,
  handleAdminLogin,
  handleAdminWebSessionRevoke,
  handleAdminPaymentMethods,
  handleAdminPaymentAction,
  handleAdminProductMutation,
  handleAdminOrderStatus,
  handleAdminPaymentProof,
  handleAdminDashboardData,
  handleAdminBotDiagnostics,
  handleAdminActivityAudit,
  handleAdminDashboardExport,
  handleMutationIngest,
  handleAdminMutations,
  handleAdminWebhooks,
  handleTelegram
};
