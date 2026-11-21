import { TELEGRAM_API, SEITON_LOGO_URL } from "./utils.mjs";
import { customerMenuText, adminMenuText, customerMenuKeyboard, adminMenuKeyboard } from "./keyboards.mjs";

async function sendTelegramPhoto(env, chatId, photo, caption, replyMarkup = null) {
  const payload = { chat_id: chatId, photo, caption: String(caption).slice(0,1024), disable_notification: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendPhoto", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram sendPhoto gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}

async function sendSeitonWelcome(env, chatId, isAdminUser = false) {
  const text = isAdminUser ? adminMenuText() : customerMenuText();
  const keyboard = isAdminUser ? adminMenuKeyboard() : customerMenuKeyboard();
  try {
    await sendTelegramPhoto(env, chatId, SEITON_LOGO_URL, text, keyboard);
  } catch (error) {
    console.warn(JSON.stringify({level:"warn",event:"telegram_brand_image_fallback",message:String(error?.message||"IMAGE_SEND_FAILED").slice(0,100)}));
    await sendTelegram(env, chatId, text, keyboard);
  }
}

async function sendTelegramPhotoBlob(env, chatId, blob, caption, replyMarkup = null) {
  if (!env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN belum diatur");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", blob, "seiton-qris.png");
  form.append("caption", String(caption || "").slice(0,1024));
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendPhoto", {
    method: "POST",
    body: form
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok || result.ok === false) {
    throw new Error("Telegram QRIS image gagal dikirim (" + response.status + ")");
  }
  return result;
}

async function telegramApiRequest(env, method, payload) {
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok || result.ok === false) {
    const description = String(result.description || "Telegram API error");
    if (description.toLowerCase().includes("message is not modified")) return result;
    throw new Error(method + " gagal (" + response.status + "): " + description.slice(0, 300));
  }
  return result;
}

async function deleteTelegramMessage(env, message) {
  if (!message?.chat?.id || !message?.message_id) return false;
  try {
    await telegramApiRequest(env, "deleteMessage", {
      chat_id: message.chat.id, message_id: message.message_id
    });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "telegram_delete_before_replace", message: error.message }));
    return false;
  }
}

// Keeps a single interactive screen in the chat. Text/photo type changes replace
// the old message because Telegram cannot convert a text message into a photo message.
async function updateTelegramMessage(env, message, options) {
  const text = String(options.text || "");
  const photo = options.photo || null;
  const replyMarkup = options.replyMarkup ?? null;
  if (!message?.chat?.id || !message?.message_id) {
    if (photo) return sendTelegramPhoto(env, message?.chat?.id, photo, text, replyMarkup);
    return sendTelegram(env, message?.chat?.id, text, replyMarkup);
  }
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  const markup = replyMarkup || { inline_keyboard: [] };

  // Photo -> photo: replace the media and keep the same Telegram message.
  if (hasPhoto && photo) {
    return telegramApiRequest(env, "editMessageMedia", {
      chat_id: chatId,
      message_id: messageId,
      media: { type: "photo", media: photo, caption: text.slice(0, 1024) },
      reply_markup: markup
    });
  }

  // Photo -> text screen: edit the caption in-place whenever possible.
  // This missing case caused each checkout step to create another message.
  if (hasPhoto && !photo && !options.clearMedia && text.length <= 1024) {
    return telegramApiRequest(env, "editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: text,
      reply_markup: markup
    });
  }

  // Text -> text: edit the existing message instead of sending another one.
  if (!hasPhoto && !photo) {
    if (text.length <= 4096) {
      return telegramApiRequest(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        reply_markup: markup
      });
    }
    await deleteTelegramMessage(env, message);
    return sendTelegram(env, chatId, text.slice(0, 4096), replyMarkup);
  }

  // Telegram cannot convert a text message into a photo or remove photo media.
  // Delete the old UI message before sending the replacement.
  await deleteTelegramMessage(env, message);
  if (photo) return sendTelegramPhoto(env, chatId, photo, text, replyMarkup);
  return sendTelegram(env, chatId, text.slice(0, 4096), replyMarkup);
}

async function answerTelegramCallback(env, callbackId, message = "") {
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/answerCallbackQuery", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: message, show_alert: false })
  });
  if (!response.ok) throw new Error("Telegram answerCallbackQuery gagal (" + response.status + ")");
}

async function sendTelegramDocument(env, chatId, csv, filename, caption = "") {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  form.set("document", new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendDocument", { method: "POST", body: form });
  if (!response.ok) throw new Error("Telegram sendDocument gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}


async function sendTelegramDocumentById(env, chatId, fileId, caption = "") {
  const payload = { chat_id: chatId, document: fileId };
  if (caption) payload.caption = String(caption).slice(0, 1024);
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendDocument", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram sendDocument bukti gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}

async function sendTelegram(env, chatId, text, replyMarkup = null) {
  if (!env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN belum diatur");
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const response = await fetch(TELEGRAM_API + "/bot" + env.TELEGRAM_TOKEN + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram sendMessage gagal (" + response.status + "): " + (await response.text()).slice(0,300));
}



export {
  sendTelegramPhoto, sendSeitonWelcome, sendTelegramPhotoBlob, telegramApiRequest,
  deleteTelegramMessage, updateTelegramMessage, answerTelegramCallback,
  sendTelegramDocument, sendTelegramDocumentById, sendTelegram
};
