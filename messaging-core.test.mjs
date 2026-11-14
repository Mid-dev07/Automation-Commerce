import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInboundEvent } from "./messaging-core.mjs";

const telegramEvent = {
  channel: "telegram",
  eventId: "telegram-update-1001",
  conversationId: "telegram-chat-42",
  senderId: "42",
  externalMessageId: "telegram-message-1001",
  text: "Halo, saya ingin melihat katalog.",
  customerName: "Pelanggan"
};

test("Telegram inbound events remain supported", () => {
  const event = normalizeInboundEvent(telegramEvent);
  assert.equal(event.channel, "telegram");
  assert.equal(event.eventId, "telegram-update-1001");
  assert.equal(event.text, "Halo, saya ingin melihat katalog.");
});

test("WhatsApp events are rejected while official channel onboarding is paused", () => {
  assert.throws(
    () => normalizeInboundEvent({ ...telegramEvent, channel: "whatsapp" }),
    /MESSAGING_UNSUPPORTED_CHANNEL/
  );
});

test("unknown channels are rejected before persistence", () => {
  assert.throws(
    () => normalizeInboundEvent({ ...telegramEvent, channel: "email" }),
    /MESSAGING_UNSUPPORTED_CHANNEL/
  );
});
