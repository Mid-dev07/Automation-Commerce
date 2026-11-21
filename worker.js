import { OrderCoordinator, transactionReadiness } from "./transaction-layer.js";
import { ADMIN_DASHBOARD_HTML } from "./src/order-bot/dashboard-html.mjs";
import { handlePickupVerificationPage } from "./src/order-bot/pickup.mjs";
import { json } from "./src/order-bot/utils.mjs";
import {
  pruneAdminLoginAttempts,
  pruneAdminWebSessions,
  messagingCoreReady,
  dispatchTelegramMessagingOutbox,
  dispatchOperationalAlerts,
  dispatchSheetsMirrorOutbox,
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
  handleTelegram
} from "./src/order-bot/handlers.mjs";

export { OrderCoordinator };

export default {
  async scheduled(controller, env) {
    try {
      await pruneAdminLoginAttempts(env);
    } catch {
      console.warn(JSON.stringify({ level:"warn", event:"admin_login_attempt_cleanup_failed" }));
    }
    try {
      await pruneAdminWebSessions(env);
    } catch {
      console.warn(JSON.stringify({ level:"warn", event:"admin_web_session_cleanup_failed" }));
    }
    if (await messagingCoreReady(env)) {
      const messaging = await dispatchTelegramMessagingOutbox(env, 20);
      if (messaging.claimed) {
        console.log(JSON.stringify({level:"info",event:"messaging_outbox_batch",cron:controller.cron,...messaging}));
      }
    }
    const state = await transactionReadiness(env);
    if (!state.ready) return;
    try {
      const alerts = await dispatchOperationalAlerts(env);
      if (alerts.sent) console.log(JSON.stringify({level:"info",event:"operational_alerts_sent",cron:controller.cron,...alerts}));
    } catch(error) {
      console.warn(JSON.stringify({level:"warn",event:"operational_alerts_failed",message:String(error?.message||error).slice(0,200)}));
    }
    const result = await dispatchSheetsMirrorOutbox(env, 20);
    if (result.claimed) {
      console.log(JSON.stringify({level:"info",event:"sheet_mirror_outbox_batch",cron:controller.cron,...result}));
    }
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/pickup") {
      return handlePickupVerificationPage(request, env);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
      return new Response(ADMIN_DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self' https://cdn.jsdelivr.net; img-src 'self' https: blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/login") return handleAdminLogin(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/session/revoke") return handleAdminWebSessionRevoke(request, env);
    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/admin/payment-methods") {
      return handleAdminPaymentMethods(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/admin/payment") return handleAdminPaymentAction(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/products") return handleAdminProductMutation(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/order-status") return handleAdminOrderStatus(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/proof") return handleAdminPaymentProof(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/data") {
      return handleAdminDashboardData(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/admin/bot/diagnostics") {
      return handleAdminBotDiagnostics(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/admin/activity-audit") {
      return handleAdminActivityAudit(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/admin/export") {
      return handleAdminDashboardExport(request, env);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const tx = await transactionReadiness(env);
      return json({ ok: true, service: "seiton-order-bot",
        transaction_store: tx.ready ? "READY" : tx.configured ? "MIGRATION_REQUIRED" : "LEGACY",
        time: new Date().toISOString() });
    }
    if (request.method === "POST" && url.pathname === "/telegram") {
      return handleTelegram(request, env, ctx);
    }
    return json({ ok: false, error: "Not found" }, 404);
  }
};
