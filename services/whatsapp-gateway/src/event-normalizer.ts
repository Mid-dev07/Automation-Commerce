import { createHash } from "node:crypto";
import type { WAMessage } from "@whiskeysockets/baileys";

export interface NormalizedInboundMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatHash: string;
  pushName: string;
  text: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isDirectChatJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

function unwrapTextContent(message: WAMessage["message"]): string {
  if (!message) return "";
  let current: Record<string, unknown> = message as Record<string, unknown>;

  for (let depth = 0; depth < 4; depth += 1) {
    const ephemeral = current.ephemeralMessage as { message?: Record<string, unknown> } | undefined;
    const viewOnce = current.viewOnceMessage as { message?: Record<string, unknown> } | undefined;
    const viewOnceV2 = current.viewOnceMessageV2 as { message?: Record<string, unknown> } | undefined;
    const documentCaption = current.documentWithCaptionMessage as { message?: Record<string, unknown> } | undefined;
    const next = ephemeral?.message || viewOnce?.message || viewOnceV2?.message || documentCaption?.message;
    if (!next) break;
    current = next;
  }

  const conversation = typeof current.conversation === "string" ? current.conversation : "";
  const extended = current.extendedTextMessage as { text?: string } | undefined;
  return (conversation || extended?.text || "").trim().slice(0, 3000);
}

export function normalizeInboundMessage(message: WAMessage): NormalizedInboundMessage | null {
  const jid = String(message.key.remoteJid || "");
  const messageId = String(message.key.id || "");
  if (message.key.fromMe || !jid || !messageId || !isDirectChatJid(jid)) return null;

  const text = unwrapTextContent(message.message);
  if (!text) return null;

  const eventId = digest(jid + "\u0000" + messageId);
  const chatHash = digest("seiton-whatsapp-chat-v1\u0000" + jid);
  return {
    eventId,
    messageId,
    chatId: jid,
    chatHash,
    pushName: String(message.pushName || "Pelanggan").trim().slice(0, 80),
    text
  };
}
