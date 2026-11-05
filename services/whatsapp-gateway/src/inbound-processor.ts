import { createHash } from "node:crypto";
import type { WASocket } from "@whiskeysockets/baileys";
import type { NormalizedInboundMessage } from "./event-normalizer.js";
import type { GatewayStore } from "./store.js";
import type { SeitonWorkerClient } from "./worker-client.js";

function chatHashFromJid(jid: string): string {
  return createHash("sha256")
    .update("seiton-whatsapp-chat-v1\u0000" + jid, "utf8")
    .digest("hex");
}

export class InboundProcessor {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: GatewayStore,
    private readonly worker: SeitonWorkerClient,
    private readonly log: { info: (obj: object, message?: string) => void; warn: (obj: object, message?: string) => void }
  ) {}

  enqueue(message: NormalizedInboundMessage, socket: WASocket): void {
    this.queue = this.queue
      .then(() => this.process(message, socket))
      .catch(error => {
        this.log.warn(
          { event: "whatsapp_inbound_processing_failed", code: this.errorCode(error) },
          "Inbound event processing failed"
        );
      });
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message)) return error.message;
    return "INBOUND_PROCESSING_ERROR";
  }

  private async process(message: NormalizedInboundMessage, socket: WASocket): Promise<void> {
    if (!this.store.claimInbound(message.eventId, message.chatHash)) return;

    const command = message.text.trim().toUpperCase();
    const mode = this.store.getConversationMode(message.chatHash);

    try {
      if (command === "STOP") {
        this.store.setConversationMode(message.chatHash, "OPTED_OUT");
        this.store.enqueueOutbound(
          message.eventId + ":stop",
          message.eventId,
          message.chatHash,
          {
            jid: message.chatId,
            text: "Otomatisasi Seiton dihentikan untuk percakapan ini. Ketik START untuk mengaktifkannya kembali."
          }
        );
      } else if (mode === "OPTED_OUT" && command === "START") {
        this.store.setConversationMode(message.chatHash, "BOT");
        this.store.enqueueOutbound(
          message.eventId + ":start",
          message.eventId,
          message.chatHash,
          {
            jid: message.chatId,
            text: "Otomatisasi layanan Seiton diaktifkan kembali. Ketik MENU untuk melihat pilihan."
          }
        );
      } else if (mode === "OPTED_OUT" || mode === "HUMAN") {
        this.store.completeInbound(message.eventId);
        return;
      } else if (command === "ADMIN") {
        this.store.setConversationMode(message.chatHash, "HUMAN");
        this.store.enqueueOutbound(
          message.eventId + ":handoff",
          message.eventId,
          message.chatHash,
          {
            jid: message.chatId,
            text: "Percakapan dialihkan ke admin. Bot tidak akan membalas lagi sampai admin mengaktifkannya kembali."
          }
        );
      } else {
        const actions = await this.worker.processCommand({
          event_id: message.eventId,
          message_id: message.messageId,
          chat_id: message.chatId,
          push_name: message.pushName,
          text: message.text,
          from_me: false,
          chat_type: "direct"
        });

        for (const action of actions) {
          this.store.enqueueOutbound(
            action.action_id,
            message.eventId,
            message.chatHash,
            { jid: message.chatId, text: action.text }
          );
        }
      }

      this.store.completeInbound(message.eventId);
      await this.flushOutbound(socket);
    } catch (error) {
      this.store.failInbound(message.eventId, this.errorCode(error));
      throw error;
    }
  }

  async flushOutbound(socket: WASocket): Promise<void> {
    if (!socket.user) return;

    while (true) {
      const job = this.store.nextPendingOutbound();
      if (!job) return;
      if (!this.store.markOutboundAttempting(job.actionId)) continue;

      try {
        await socket.sendMessage(job.payload.jid, { text: job.payload.text });
        this.store.markOutbound(job.actionId, "SUBMITTED");
      } catch {
        // A timeout or disconnect can occur after WhatsApp accepted the message.
        // Do not automatically retry an ambiguous send and risk a duplicate reply.
        this.store.markOutbound(job.actionId, "UNKNOWN", "SEND_RESULT_UNKNOWN");
        this.log.warn(
          { event: "whatsapp_outbound_unknown", action_id: job.actionId },
          "Outbound result is unknown; manual review is required"
        );
        return;
      }
    }
  }
}
