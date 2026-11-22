import { TELEGRAM_API, SEITON_LOGO_URL } from "./utils.mjs";
import { customerMenuText, adminMenuText, customerMenuKeyboard, adminMenuKeyboard } from "./keyboards.mjs";
import { hasButtonStyles, stripButtonStyles } from "./ui/keyboards.mjs";

function isButtonStyleReject(status, description) {
  if (status !== 400) return false;
  const text = String(description || "").toLowerCase();
  return text.includes("style") || text.includes("reply_markup") || text.includes("button") || text.includes("unknown field");
}

async function telegramApiRequest(env, method, payload, { allowStyleFallback = true } = {}) {
  if (!env?.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN belum diatur");
  const sendOnce = async (bodyPayload) => {
    const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload)
    });
    let result = {};
    try { result = await response.json(); } catch { result = { ok: response.ok, description: "Non-JSON response" }; }
    return { response, result };
  };

  let { response, result } = await sendOnce(payload);
  if (!response.ok || result.ok === false) {
    const description = String(result.description || "Telegram API error");
    if (description.toLowerCase().includes("message is not modified")) return result;
    if (allowStyleFallback && payload?.reply_markup && hasButtonStyles(payload.reply_markup) && isButtonStyleReject(response.status, description)) {
      const stripped = { ...payload, reply_markup: stripButtonStyles(payload.reply_markup) };
      const retry = await sendOnce(stripped);
      response = retry.response;
      result = retry.result;
      if (response.ok && result.ok !== false) return result;
      const retryDesc = String(result.description || "Telegram API error");
      if (retryDesc.toLowerCase().includes("message is not modified")) return result;
      throw new Error(method + " gagal (" + response.status + "): " + retryDesc.slice(0, 300));
    }
    throw new Error(method + " gagal (" + response.status + "): " + description.slice(0, 300));
  }
  return result;
}

async function sendTelegramPhoto(env, chatId, photo, caption, replyMarkup = null, options = {}) {
  const payload = {
    chat_id: chatId,
    photo,
    caption: String(caption || "").slice(0, 1024),
    disable_notification: options.disableNotification ?? true
  };
  if (options.parseMode) payload.parse_mode = options.parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramApiRequest(env, "sendPhoto", payload);
}

async function sendSeitonWelcome(env, chatId, isAdminUser = false) {
  const text = isAdminUser ? adminMenuText() : customerMenuText();
  const keyboard = isAdminUser ? adminMenuKeyboard() : customerMenuKeyboard();
  const opts = isAdminUser ? { parseMode: "HTML" } : {};
  try {
    return await sendTelegramPhoto(env, chatId, SEITON_LOGO_URL, text, keyboard, opts);
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "telegram_brand_image_fallback", message: String(error?.message || "IMAGE_SEND_FAILED").slice(0, 100) }));
    return sendTelegram(env, chatId, text, keyboard, opts);
  }
}

async function sendTelegramPhotoBlob(env, chatId, blob, caption, replyMarkup = null, options = {}) {
  if (!env?.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN belum diatur");
  const sendBlob = async (markup) => {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", blob, "seiton-qris.png");
    form.append("caption", String(caption || "").slice(0, 1024));
    if (options.parseMode) form.append("parse_mode", options.parseMode);
    if (markup) form.append("reply_markup", JSON.stringify(markup));
    const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendPhoto", {
      method: "POST",
      body: form
    });
    let result = {};
    try { result = await response.json(); } catch { result = { ok: response.ok, description: "Non-JSON response" }; }
    return { response, result };
  };
  let { response, result } = await sendBlob(replyMarkup);
  if ((!response.ok || result.ok === false) && replyMarkup && hasButtonStyles(replyMarkup) && isButtonStyleReject(response.status, result.description)) {
    ({ response, result } = await sendBlob(stripButtonStyles(replyMarkup)));
  }
  if (!response.ok || result.ok === false) {
    throw new Error("Telegram QRIS image gagal dikirim (" + response.status + ")");
  }
  return result;
}

async function deleteTelegramMessageById(env, chatId, messageId) {
  if (!chatId || !messageId) return false;
  try {
    await telegramApiRequest(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId
    }, { allowStyleFallback: false });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "telegram_delete_before_replace", message: String(error?.message || error).slice(0, 160) }));
    return false;
  }
}

async function deleteTelegramMessage(env, message) {
  if (!message?.chat?.id || !message?.message_id) return false;
  return deleteTelegramMessageById(env, message.chat.id, message.message_id);
}

// Keeps a single interactive screen in the chat. Text/photo type changes replace
// the old message because Telegram cannot convert a text message into a photo message.
async function updateTelegramMessage(env, message, options) {
  const text = String(options.text || "");
  const photo = options.photo || null;
  const replyMarkup = options.replyMarkup ?? null;
  const parseMode = options.parseMode || null;
  if (!message?.chat?.id || !message?.message_id) {
    if (photo && text.length <= 1024) return sendTelegramPhoto(env, message?.chat?.id, photo, text, replyMarkup, { parseMode });
    return sendTelegram(env, message?.chat?.id, text.slice(0, 4096), replyMarkup, { parseMode });
  }
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  const markup = replyMarkup || { inline_keyboard: [] };

  // Photo -> photo: replace the media and keep the same Telegram message.
  if (hasPhoto && photo) {
    const media = { type: "photo", media: photo, caption: text.slice(0, 1024) };
    if (parseMode) media.parse_mode = parseMode;
    return telegramApiRequest(env, "editMessageMedia", {
      chat_id: chatId,
      message_id: messageId,
      media,
      reply_markup: markup
    });
  }

  // Photo -> text screen: edit the caption in-place whenever possible.
  if (hasPhoto && !photo && !options.clearMedia && text.length <= 1024) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      caption: text,
      reply_markup: markup
    };
    if (parseMode) payload.parse_mode = parseMode;
    return telegramApiRequest(env, "editMessageCaption", payload);
  }

  // Text -> text: edit the existing message instead of sending another one.
  if (!hasPhoto && !photo) {
    if (text.length <= 4096) {
      const payload = {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        reply_markup: markup
      };
      if (parseMode) payload.parse_mode = parseMode;
      return telegramApiRequest(env, "editMessageText", payload);
    }
    await deleteTelegramMessage(env, message);
    return sendTelegram(env, chatId, text.slice(0, 4096), replyMarkup, { parseMode });
  }

  // Telegram cannot convert a text message into a photo or remove photo media.
  // Delete the old UI message before sending the replacement.
  await deleteTelegramMessage(env, message);
  if (photo && text.length <= 1024) return sendTelegramPhoto(env, chatId, photo, text, replyMarkup, { parseMode });
  return sendTelegram(env, chatId, text.slice(0, 4096), replyMarkup, { parseMode });
}

async function answerTelegramCallback(env, callbackId, message = "", showAlert = false) {
  if (!callbackId) return null;
  try {
    return await telegramApiRequest(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: String(message || "").slice(0, 200),
      show_alert: Boolean(showAlert)
    }, { allowStyleFallback: false });
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "telegram_answer_callback_failed", message: String(error?.message || error).slice(0, 120) }));
    return null;
  }
}

async function sendTelegramDocument(env, chatId, csv, filename, caption = "") {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  form.set("document", new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendDocument", { method: "POST", body: form });
  if (!response.ok) throw new Error("Telegram sendDocument gagal (" + response.status + "): " + (await response.text()).slice(0, 300));
}

async function sendTelegramDocumentById(env, chatId, fileId, caption = "") {
  const payload = { chat_id: chatId, document: fileId };
  if (caption) payload.caption = String(caption).slice(0, 1024);
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendDocument", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram sendDocument bukti gagal (" + response.status + "): " + (await response.text()).slice(0, 300));
}

async function sendTelegram(env, chatId, text, replyMarkup = null, options = {}) {
  const payload = {
    chat_id: chatId,
    text: String(text || "").slice(0, 4096),
    disable_web_page_preview: true
  };
  if (options.parseMode) payload.parse_mode = options.parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramApiRequest(env, "sendMessage", payload);
}

export {
  sendTelegramPhoto, sendSeitonWelcome, sendTelegramPhotoBlob, telegramApiRequest,
  deleteTelegramMessage, deleteTelegramMessageById, updateTelegramMessage, answerTelegramCallback,
  sendTelegramDocument, sendTelegramDocumentById, sendTelegram
};
