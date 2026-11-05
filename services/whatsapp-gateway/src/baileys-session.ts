import makeWASocket, { type WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import type { LoadedAuthState } from "./auth-store.js";
import { isDirectChatJid, normalizeInboundMessage } from "./event-normalizer.js";
import type { InboundProcessor } from "./inbound-processor.js";

export type ConnectionState =
  | "STOPPED"
  | "CONNECTING"
  | "QR_REQUIRED"
  | "CONNECTED"
  | "LOGGED_OUT"
  | "MANUAL_REVIEW";

interface GatewayLogger {
  info: (obj: object, message?: string) => void;
  warn: (obj: object, message?: string) => void;
}

export class BaileysSession {
  private socket: WASocket | null = null;
  private state: ConnectionState = "STOPPED";
  private stopping = false;
  private readonly baileysLogger = pino({ level: "silent" });

  constructor(
    private readonly auth: LoadedAuthState,
    private readonly processor: InboundProcessor,
    private readonly log: GatewayLogger
  ) {}

  getState(): ConnectionState {
    return this.state;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (!this.auth.state.creds.registered) {
      this.state = "QR_REQUIRED";
      this.log.warn({ event: "whatsapp_pairing_required" }, "Pairing is required before starting the gateway");
      return;
    }

    this.state = "CONNECTING";
    const socket = makeWASocket({
      auth: this.auth.state,
      logger: this.baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: jid => !isDirectChatJid(jid)
    });
    this.socket = socket;

    socket.ev.on("creds.update", () => {
      void this.auth.saveCreds().catch(() => {
        this.state = "MANUAL_REVIEW";
        this.log.warn({ event: "whatsapp_auth_persist_failed" }, "Authentication state could not be persisted");
      });
    });

    socket.ev.on("messages.upsert", update => {
      if (update.type !== "notify") return;
      for (const message of update.messages) {
        const normalized = normalizeInboundMessage(message);
        if (!normalized) continue;
        this.processor.enqueue(normalized, socket);
      }
    });

    socket.ev.on("connection.update", update => {
      if (update.qr) {
        this.state = "QR_REQUIRED";
        this.log.warn({ event: "whatsapp_repair_pairing_required" }, "Saved session requires operator pairing");
        socket.end(new Error("PAIRING_REQUIRED"));
        this.socket = null;
        return;
      }

      if (update.connection === "open") {
        this.state = "CONNECTED";
        this.log.info({ event: "whatsapp_connection_open" }, "WhatsApp session connected");
        void this.processor.flushOutbound(socket);
        return;
      }

      if (update.connection === "close") {
        this.socket = null;
        if (this.stopping) {
          this.state = "STOPPED";
          return;
        }
        const statusCode = (
          update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;

        this.state = statusCode === 401 ? "LOGGED_OUT" : "MANUAL_REVIEW";
        this.log.warn(
          { event: "whatsapp_connection_closed", status_code: statusCode ?? null },
          "Connection closed; automatic reconnect is disabled pending operator review"
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.end(new Error("OPERATOR_SHUTDOWN"));
    this.state = "STOPPED";
  }

  currentSocket(): WASocket | null {
    return this.socket;
  }
}
