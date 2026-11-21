import { extractVerificationCode } from "./otp-extractor.js";
import { renderPublicPage } from "./public-page.mjs";
import {
  MAILBOX_TTL_OPTIONS_SECONDS,
  isAllowedMailboxTtl,
  isMailboxActive,
  responseJson,
  securityHeaders,
  randomHex,
  mailboxAddress,
  encryptMessagePayload,
  decryptMessagePayload,
  passwordHash,
  parseAliasRecipient
} from "./core.mjs";
import {
  handlePublicMailboxCreate,
  handlePublicMailboxUnlock,
  handlePublicInboxGet,
  handlePublicMailboxLogout
} from "./tmail-public.mjs";
import {
  hasOwner,
  currentSession,
  requireSession,
  handleSetup,
  handleLogin,
  handleLoginTwoFactor,
  handleLogout,
  handleTwoFactorStatus,
  handleTwoFactorEnroll,
  handleTwoFactorConfirm,
  handleTwoFactorDisable,
  handleMachineTokensList,
  handleMachineTokenCreate,
  handleMachineTokenRevoke,
  handleAliasesGet,
  handleAliasCreate,
  handleAliasRevoke,
  handleMessagesGet,
  handleMessageDelete
} from "./owner-api.mjs";
import { parseBearerToken, handleMachineApi } from "./agent-api.mjs";
import { handlePanel } from "./owner-ui.mjs";
import { handleInboundEmail, scheduledCleanup } from "./inbound.mjs";

async function api(request, env, url) {
  if (url.pathname.startsWith("/api/v1/machine/")) {
    return handleMachineApi(request, env, url);
  }
  if (request.method === "POST" && url.pathname === "/api/public/mailboxes") return handlePublicMailboxCreate(request, env);
  if (request.method === "POST" && url.pathname === "/api/public/unlock") return handlePublicMailboxUnlock(request, env);
  if (request.method === "GET" && url.pathname === "/api/public/inbox") return handlePublicInboxGet(request, url, env);
  if (request.method === "POST" && url.pathname === "/api/public/logout") return handlePublicMailboxLogout(request, env);

  if (request.method === "GET" && url.pathname === "/api/session") {
    return responseJson({
      ok: true,
      configured: await hasOwner(env),
      authenticated: Boolean(await currentSession(request, env)),
      two_factor_enabled: Number((await env.MAIL_DB.prepare("SELECT totp_enabled FROM mail_admin WHERE id='owner' LIMIT 1").first())?.totp_enabled || 0) === 1
    });
  }
  if (request.method === "POST" && url.pathname === "/api/setup") return handleSetup(request, env);
  if (request.method === "POST" && url.pathname === "/api/login") return handleLogin(request, env);
  if (request.method === "POST" && url.pathname === "/api/login/2fa") return handleLoginTwoFactor(request, env);
  if (request.method === "POST" && url.pathname === "/api/logout") return handleLogout(request, env);

  const session = await requireSession(request, env);
  if (!session) return responseJson({ ok: false, error: "Sesi admin tidak valid atau sudah berakhir." }, 401);

  if (request.method === "GET" && url.pathname === "/api/2fa/status") return handleTwoFactorStatus(env);
  if (request.method === "POST" && url.pathname === "/api/2fa/enroll") return handleTwoFactorEnroll(request, env);
  if (request.method === "POST" && url.pathname === "/api/2fa/confirm") return handleTwoFactorConfirm(request, env);
  if (request.method === "POST" && url.pathname === "/api/2fa/disable") return handleTwoFactorDisable(request, env);
  if (request.method === "GET" && url.pathname === "/api/machine-tokens") return handleMachineTokensList(env);
  if (request.method === "POST" && url.pathname === "/api/machine-tokens") return handleMachineTokenCreate(request, env);
  if (request.method === "DELETE" && url.pathname.startsWith("/api/machine-tokens/")) {
    return handleMachineTokenRevoke(request, env, url.pathname.slice("/api/machine-tokens/".length));
  }

  if (request.method === "GET" && (url.pathname === "/api/mailboxes" || url.pathname === "/api/aliases")) return handleAliasesGet(env);
  if (request.method === "POST" && url.pathname === "/api/mailboxes") {
    const response = await handleAliasCreate(request, env);
    const payload = await response.json().catch(() => ({}));
    if (payload.alias) {
      payload.mailbox = payload.alias;
      delete payload.alias;
    }
    return responseJson(payload, response.status);
  }
  if (request.method === "POST" && url.pathname === "/api/aliases") return handleAliasCreate(request, env);
  if (request.method === "DELETE" && url.pathname.startsWith("/api/mailboxes/")) {
    return handleAliasRevoke(request, env, url.pathname.slice("/api/mailboxes/".length));
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/aliases/")) {
    return handleAliasRevoke(request, env, url.pathname.slice("/api/aliases/".length));
  }
  if (request.method === "GET" && url.pathname === "/api/messages") return handleMessagesGet(url, env);
  if (request.method === "DELETE" && url.pathname.startsWith("/api/messages/")) {
    return handleMessageDelete(request, env, url.pathname.slice("/api/messages/".length));
  }
  return responseJson({ ok: false, error: "Endpoint tidak ditemukan." }, 404);
}

export {
  decryptMessagePayload,
  encryptMessagePayload,
  extractVerificationCode,
  parseAliasRecipient,
  mailboxAddress,
  parseBearerToken,
  passwordHash,
  randomHex,
  isAllowedMailboxTtl,
  isMailboxActive,
  MAILBOX_TTL_OPTIONS_SECONDS
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return responseJson({ ok: true, service: "seiton-mail-automation" });
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" })
      });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (error) {
        const code = error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message)
          ? error.message
          : "INTERNAL_ERROR";
        console.error(JSON.stringify({
          level: "error",
          event: "mail_api_error",
          code,
          errorName: error instanceof Error ? error.name : "UnknownError",
          detail: error instanceof Error ? String(error.message).slice(0, 160) : "NonErrorThrowable",
          stack: error instanceof Error && error.stack ? String(error.stack).slice(0, 700) : undefined
        }));
        return responseJson({ ok: false, error: "Permintaan tidak dapat diproses." }, 500);
      }
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/inbox/"))) {
      const nonce = randomHex(32);
      return renderPublicPage(nonce);
    }
    if (request.method === "GET" && (url.pathname === "/owner" || url.pathname === "/login")) {
      try { return await handlePanel(request, env); }
      catch (error) {
        console.error(JSON.stringify({ level: "error", event: "mail_panel_error", name: error?.name || "Error" }));
        return responseJson({ ok: false, error: "Panel belum siap." }, 503);
      }
    }
    return responseJson({ ok: false, error: "Not found" }, 404);
  },

  async email(message, env) {
    try {
      await handleInboundEmail(message, env);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "mail_ingest_failed",
        name: error instanceof Error ? error.name : "UnknownError"
      }));
      message.setReject("Unable to process this message");
    }
  },

  async scheduled(controller, env) {
    try {
      await scheduledCleanup(env);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "mail_cleanup_failed",
        name: error instanceof Error ? error.name : "UnknownError"
      }));
    }
  }
};

