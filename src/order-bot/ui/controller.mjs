/**
 * High-performance Telegram Hybrid UI controller.
 * Keeps webhook latency < 150ms (cached) / < 350ms (D1) using Promise.all,
 * KV caching, Telegram file_id reuse, and ctx.waitUntil() background side effects.
 * Supports bilingual ('id' / 'en') flows, international checkout, and post-payment claim.
 */

import { SEITON_LOGO_URL } from "../utils.mjs";
import { getQrisCheckoutMode, isQrisCheckoutAvailable } from "../../../qris.mjs";
import {
  answerTelegramCallback,
  deleteTelegramMessage,
  deleteTelegramMessageById,
  sendTelegram,
  sendTelegramPhoto,
  updateTelegramMessage
} from "../telegram-api.mjs";
import { createLatencyTracker } from "./formatters.mjs";
import {
  loadIntlPaymentConfig,
  normalizeLang,
  renderLanguageSelectScreen,
  resolveMenuIntent
} from "./i18n.mjs";
import {
  CATALOG_PAGE_SIZE,
  HISTORY_PAGE_SIZE,
  STOCK_PAGE_SIZE,
  isMainMenuLabel,
  parseUiCallback
} from "./keyboards.mjs";
import {
  renderCatalogScreen,
  renderGuideScreen,
  renderHistoryScreen,
  renderHomeScreen,
  renderProductCheckoutScreen,
  renderSearchPromptScreen,
  renderSearchResultsScreen,
  renderStockScreen
} from "./screens.mjs";
import {
  clearQrisMessageRef,
  clearUiMode,
  getBannerFileId,
  getCatalogMapping,
  getCatalogSnapshot,
  getQrisMessageRef,
  getStoreStats,
  getUiMode,
  getUserLang,
  invalidateStoreUiCaches,
  listCustomerOrdersPage,
  runBackground,
  setBannerFileId,
  setCatalogMapping,
  setUiMode,
  setUserLang
} from "./state.mjs";

function bannerUrlFor(env) {
  return String(env?.BOT_BANNER_URL || SEITON_LOGO_URL || "").trim();
}

function storeNameFor(env) {
  return String(env?.BOT_STORE_NAME || "Seiton.id Store").trim();
}

function extractLargestPhotoFileId(telegramResponse) {
  const photos = telegramResponse?.result?.photo;
  if (!Array.isArray(photos) || !photos.length) return "";
  return String(photos[photos.length - 1]?.file_id || "");
}

export async function sendCustomerHome(env, ctx, chatId, fromUser, { forceLang = "" } = {}) {
  const tracker = createLatencyTracker("home");
  const userId = String(fromUser?.id || chatId);
  const bannerUrl = bannerUrlFor(env);

  runBackground(ctx, clearUiMode(env, userId), "ui_clear_mode_home");

  const [{ stats, cacheHit }, cachedBanner, langPref] = await tracker.measure("kv", () =>
    Promise.all([
      getStoreStats(env, { ctx }),
      bannerUrl ? getBannerFileId(env, bannerUrl) : Promise.resolve(null),
      forceLang ? Promise.resolve({ lang: normalizeLang(forceLang), chosen: true }) : getUserLang(env, userId)
    ])
  );
  tracker.markCacheHit(cacheHit);
  const lang = normalizeLang(langPref?.lang);

  const screen = renderHomeScreen(
    {
      user: {
        id: userId,
        firstName: [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(" ") || (lang === "en" ? "Customer" : "Pelanggan"),
        username: fromUser?.username || ""
      },
      stats,
      storeName: storeNameFor(env),
      lang
    },
    env
  );

  await tracker.measure("tg", async () => {
    if (bannerUrl && screen.text.length <= 1024) {
      const photoRef = cachedBanner?.fileId || bannerUrl;
      try {
        const res = await sendTelegramPhoto(env, chatId, photoRef, screen.text, screen.replyKeyboard, {
          parseMode: screen.parseMode
        });
        if (!cachedBanner?.fileId) {
          const newFileId = extractLargestPhotoFileId(res);
          if (newFileId) {
            runBackground(ctx, setBannerFileId(env, bannerUrl, newFileId), "ui_banner_file_id_cache");
          }
        }
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "ui_home_banner_fallback",
          message: String(error?.message || "BANNER_FAILED").slice(0, 120)
        }));
        await sendTelegram(env, chatId, screen.text, screen.replyKeyboard, { parseMode: screen.parseMode });
      }
    } else {
      await sendTelegram(env, chatId, screen.text, screen.replyKeyboard, { parseMode: screen.parseMode });
    }
  });

  tracker.emit({ banner_cached: Boolean(cachedBanner?.fileId), lang });
}

export async function showLanguageScreen(env, ctx, { chatId, userId, message = null, callbackId = "" }) {
  const langPref = await getUserLang(env, userId);
  const screen = renderLanguageSelectScreen(langPref.lang);
  if (message) {
    await Promise.all([
      callbackId ? answerTelegramCallback(env, callbackId) : Promise.resolve(),
      updateTelegramMessage(env, message, {
        text: screen.text,
        parseMode: screen.parseMode,
        replyMarkup: screen.inlineKeyboard,
        clearMedia: true
      })
    ]);
    return;
  }
  await sendTelegram(env, chatId, screen.text, screen.inlineKeyboard, { parseMode: screen.parseMode });
}

export async function showCatalogScreen(env, ctx, { chatId, userId, page = 0, message = null, callbackId = "", fallbackRowsReader = null }) {
  const tracker = createLatencyTracker("catalog");
  runBackground(ctx, clearUiMode(env, userId), "ui_clear_mode_catalog");

  const [{ items: allItems, cacheHit }, langPref] = await tracker.measure(
    "d1",
    () => Promise.all([
      getCatalogSnapshot(env, { ctx, fallbackRowsReader }),
      getUserLang(env, userId)
    ])
  );
  tracker.markCacheHit(cacheHit);
  const lang = normalizeLang(langPref?.lang);

  const totalItems = allItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / CATALOG_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
  const pageItems = allItems.slice(safePage * CATALOG_PAGE_SIZE, (safePage + 1) * CATALOG_PAGE_SIZE);

  runBackground(
    ctx,
    setCatalogMapping(env, userId, { page: safePage, skus: pageItems.map((item) => item.sku) }),
    "ui_catalog_mapping_put"
  );

  const screen = renderCatalogScreen({ items: pageItems, page: safePage, totalPages, totalItems, lang }, env);

  await tracker.measure("tg", async () => {
    if (message) {
      await Promise.all([
        callbackId ? answerTelegramCallback(env, callbackId) : Promise.resolve(),
        updateTelegramMessage(env, message, {
          text: screen.text,
          parseMode: screen.parseMode,
          replyMarkup: screen.inlineKeyboard,
          clearMedia: true
        })
      ]);
      return;
    }
    await sendTelegram(env, chatId, screen.text, screen.replyKeyboard, { parseMode: screen.parseMode });
    if (totalPages > 1) {
      const navHint = lang === "en"
        ? `<i>📄 Catalog page navigation (${safePage + 1}/${totalPages}):</i>`
        : "<i>📄 Navigasi halaman katalog (" + (safePage + 1) + "/" + totalPages + "):</i>";
      await sendTelegram(
        env,
        chatId,
        navHint,
        screen.inlineKeyboard,
        { parseMode: "HTML" }
      );
    }
  });
  tracker.emit({ page: safePage, items: pageItems.length, lang });
}

export async function showStockScreen(
  env,
  ctx,
  { chatId, userId, tab = "avail", page = 0, message = null, callbackId = "", bypassCache = false, fallbackRowsReader = null }
) {
  const tracker = createLatencyTracker(bypassCache ? "stock_refresh" : "stock");
  if (!message && userId) {
    runBackground(ctx, clearUiMode(env, userId), "ui_clear_mode_stock");
  }

  const [{ items: allItems, cacheHit }, langPref] = await tracker.measure(
    bypassCache ? "d1" : "kv",
    () => Promise.all([
      getCatalogSnapshot(env, { bypassCache, ctx, fallbackRowsReader }),
      getUserLang(env, userId)
    ])
  );
  tracker.markCacheHit(cacheHit);
  const lang = normalizeLang(langPref?.lang);

  const availItems = allItems.filter((item) => item.stock === null || item.stock > 0);
  const emptyItems = allItems.filter((item) => item.stock !== null && item.stock <= 0);
  const activeTab = tab === "empty" ? "empty" : "avail";
  const targetList = activeTab === "empty" ? emptyItems : availItems;
  const totalPages = Math.max(1, Math.ceil(targetList.length / STOCK_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
  const pageItems = targetList.slice(safePage * STOCK_PAGE_SIZE, (safePage + 1) * STOCK_PAGE_SIZE);

  const screen = renderStockScreen(
    {
      tab: activeTab,
      items: pageItems,
      availCount: availItems.length,
      emptyCount: emptyItems.length,
      page: safePage,
      totalPages,
      lang
    },
    env
  );

  const toast = bypassCache ? (lang === "en" ? "✅ Stock refreshed" : "✅ Stok diperbarui") : "";
  await tracker.measure("tg", async () => {
    if (message) {
      await Promise.all([
        callbackId ? answerTelegramCallback(env, callbackId, toast) : Promise.resolve(),
        updateTelegramMessage(env, message, {
          text: screen.text,
          parseMode: screen.parseMode,
          replyMarkup: screen.inlineKeyboard,
          clearMedia: true
        })
      ]);
      return;
    }
    await sendTelegram(env, chatId, screen.text, screen.inlineKeyboard, { parseMode: screen.parseMode });
  });
  tracker.emit({ tab: activeTab, page: safePage, avail: availItems.length, empty: emptyItems.length, lang });
}

export async function showProductCheckout(
  env,
  ctx,
  { chatId, userId = "", sku, qty = 1, message = null, callbackId = "", backCallback = "cat:page:0", fallbackRowsReader = null, getAvailablePaymentMethods }
) {
  const tracker = createLatencyTracker("checkout_card");
  const normalizedSku = String(sku || "").trim().toUpperCase();

  const [{ items, cacheHit }, availableMethods, intlConfig, langPref] = await tracker.measure("d1", () =>
    Promise.all([
      getCatalogSnapshot(env, { ctx, fallbackRowsReader }),
      getAvailablePaymentMethods(env),
      loadIntlPaymentConfig(env),
      getUserLang(env, userId || chatId)
    ])
  );
  tracker.markCacheHit(cacheHit);
  const lang = normalizeLang(langPref?.lang);

  const product = items.find((item) => String(item.sku || "").toUpperCase() === normalizedSku);
  if (!product) {
    const msg = lang === "en" ? "⚠️ Product not found or unavailable." : "⚠️ Produk tidak ditemukan atau sudah tidak tersedia.";
    if (callbackId) await answerTelegramCallback(env, callbackId, msg, true);
    else await sendTelegram(env, chatId, msg);
    return;
  }

  const screen = renderProductCheckoutScreen(
    {
      product,
      qty,
      availableMethods,
      qrisMode: getQrisCheckoutMode(env),
      backCallback,
      intlConfig,
      lang
    },
    env
  );

  const photo = product.photoUrl && /^https:\/\//i.test(product.photoUrl) && screen.text.length <= 1024
    ? product.photoUrl
    : null;

  await tracker.measure("tg", async () => {
    if (message) {
      await Promise.all([
        callbackId ? answerTelegramCallback(env, callbackId) : Promise.resolve(),
        updateTelegramMessage(env, message, {
          text: screen.text,
          parseMode: screen.parseMode,
          photo,
          clearMedia: !photo,
          replyMarkup: screen.inlineKeyboard
        })
      ]);
      return;
    }
    if (photo) {
      try {
        await sendTelegramPhoto(env, chatId, photo, screen.text, screen.inlineKeyboard, { parseMode: screen.parseMode });
        return;
      } catch (error) {
        console.warn(JSON.stringify({ level: "warn", event: "ui_product_photo_fallback", sku: product.sku, message: String(error?.message || "PHOTO_ERR").slice(0, 120) }));
      }
    }
    await sendTelegram(env, chatId, screen.text, screen.inlineKeyboard, { parseMode: screen.parseMode });
  });
  tracker.emit({ sku: product.sku, qty: screen.clampedQty, lang });
}

export async function showHistoryScreen(env, ctx, { chatId, userId, page = 0, message = null, callbackId = "" }) {
  const tracker = createLatencyTracker("history");
  if (!message && userId) {
    runBackground(ctx, clearUiMode(env, userId), "ui_clear_mode_history");
  }

  const [pageData, langPref] = await tracker.measure("d1", () =>
    Promise.all([
      listCustomerOrdersPage(env, userId, page, HISTORY_PAGE_SIZE),
      getUserLang(env, userId)
    ])
  );
  const lang = normalizeLang(langPref?.lang);
  const screen = renderHistoryScreen(
    {
      ...pageData,
      qrisAvailable: isQrisCheckoutAvailable(env),
      lang
    },
    env
  );

  await tracker.measure("tg", async () => {
    if (message) {
      await Promise.all([
        callbackId ? answerTelegramCallback(env, callbackId) : Promise.resolve(),
        updateTelegramMessage(env, message, {
          text: screen.text,
          parseMode: screen.parseMode,
          replyMarkup: screen.inlineKeyboard,
          clearMedia: true
        })
      ]);
      return;
    }
    await sendTelegram(env, chatId, screen.text, screen.inlineKeyboard, { parseMode: screen.parseMode });
  });
  tracker.emit({ page: pageData.page, count: pageData.orders.length, total: pageData.totalCount, lang });
}

export async function showGuideScreen(env, ctx, { chatId, userId, message = null, callbackId = "" }) {
  const tracker = createLatencyTracker("guide");
  if (!message && userId) {
    runBackground(ctx, clearUiMode(env, userId), "ui_clear_mode_guide");
  }
  const langPref = await getUserLang(env, userId);
  const lang = normalizeLang(langPref?.lang);
  const screen = renderGuideScreen(env, lang);
  await tracker.measure("tg", async () => {
    if (message) {
      await Promise.all([
        callbackId ? answerTelegramCallback(env, callbackId) : Promise.resolve(),
        updateTelegramMessage(env, message, {
          text: screen.text,
          parseMode: screen.parseMode,
          replyMarkup: screen.inlineKeyboard,
          clearMedia: true
        })
      ]);
      return;
    }
    await sendTelegram(env, chatId, screen.text, screen.inlineKeyboard, { parseMode: screen.parseMode });
  });
  tracker.emit({ lang });
}

export async function openSearchMode(env, ctx, { chatId, userId, message = null, callbackId = "" }) {
  runBackground(ctx, setUiMode(env, userId, { mode: "WAITING_SEARCH" }), "ui_set_search_mode");
  const langPref = await getUserLang(env, userId);
  const lang = normalizeLang(langPref?.lang);
  const screen = renderSearchPromptScreen(env, lang);
  if (message) {
    await Promise.all([
      callbackId ? answerTelegramCallback(env, callbackId) : Promise.resolve(),
      updateTelegramMessage(env, message, {
        text: screen.text,
        parseMode: screen.parseMode,
        replyMarkup: screen.inlineKeyboard,
        clearMedia: true
      })
    ]);
    return;
  }
  await sendTelegram(env, chatId, screen.text, screen.inlineKeyboard, { parseMode: screen.parseMode });
}

export async function handleSearchQueryText(env, ctx, { chatId, userId, query, fallbackRowsReader = null }) {
  const tracker = createLatencyTracker("search_results");
  runBackground(ctx, clearUiMode(env, userId), "ui_clear_mode_search_done");

  const [{ items: allItems, cacheHit }, langPref] = await tracker.measure("kv", () =>
    Promise.all([
      getCatalogSnapshot(env, { ctx, fallbackRowsReader }),
      getUserLang(env, userId)
    ])
  );
  tracker.markCacheHit(cacheHit);
  const lang = normalizeLang(langPref?.lang);

  const needle = String(query || "").trim().toLowerCase();
  const matches = allItems.filter((item) => {
    const haystack = [item.sku, item.name, item.description].join(" ").toLowerCase();
    return haystack.includes(needle);
  });

  const screen = renderSearchResultsScreen({ query, items: matches, lang }, env);
  await tracker.measure("tg", () =>
    sendTelegram(env, chatId, screen.text, screen.inlineKeyboard, { parseMode: screen.parseMode })
  );
  tracker.emit({ query_len: needle.length, matches: matches.length, lang });
}

export async function cleanupStoredQrisMessage(env, orderId) {
  const ref = await getQrisMessageRef(env, orderId);
  if (!ref?.chatId || !ref?.messageId) return false;
  await deleteTelegramMessageById(env, ref.chatId, ref.messageId);
  await clearQrisMessageRef(env, orderId);
  return true;
}

/**
 * Handles customer private Reply Keyboard actions, dynamic numeric keypad (1..9),
 * language switching, and WAITING_SEARCH text input. Returns true when handled.
 */
export async function handleCustomerHybridMessage(env, ctx, message, text, deps) {
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const trimmed = String(text || "").trim();
  const intent = resolveMenuIntent(trimmed);

  if (intent === "MAIN_MENU" || trimmed === "/start") {
    await sendCustomerHome(env, ctx, chatId, message.from);
    return true;
  }
  if (intent === "LANGUAGE" || trimmed === "/lang" || trimmed === "/language" || trimmed === "/bahasa") {
    await showLanguageScreen(env, ctx, { chatId, userId });
    return true;
  }
  if (intent === "LIST_PRODUCTS") {
    await showCatalogScreen(env, ctx, { chatId, userId, page: 0, fallbackRowsReader: deps.readTelegramCatalogRows });
    return true;
  }
  if (intent === "CHECK_STOCK") {
    await showStockScreen(env, ctx, { chatId, userId, tab: "avail", page: 0, fallbackRowsReader: deps.readTelegramCatalogRows });
    return true;
  }
  if (intent === "HISTORY") {
    await showHistoryScreen(env, ctx, { chatId, userId, page: 0 });
    return true;
  }
  if (intent === "HOW_TO_ORDER") {
    await showGuideScreen(env, ctx, { chatId, userId });
    return true;
  }
  if (intent === "SEARCH_PRODUCTS") {
    await openSearchMode(env, ctx, { chatId, userId });
    return true;
  }

  // Always check active WAITING_SEARCH mode before falling through to Messaging Core.
  const activeMode = await getUiMode(env, userId);
  if (activeMode?.mode === "WAITING_SEARCH" && trimmed && !trimmed.startsWith("/") && !isMainMenuLabel(trimmed)) {
    await handleSearchQueryText(env, ctx, {
      chatId,
      userId,
      query: trimmed,
      fallbackRowsReader: deps.readTelegramCatalogRows
    });
    return true;
  }

  // Numeric keypad selection (1..9) mapped to current user's List Produk page.
  if (/^[1-9]$/.test(trimmed)) {
    const mapping = await getCatalogMapping(env, userId);
    const idx = Number(trimmed) - 1;
    const sku = mapping?.skus?.[idx];
    if (sku) {
      await showProductCheckout(env, ctx, {
        chatId,
        userId,
        sku,
        qty: 1,
        backCallback: "cat:page:" + Number(mapping.page || 0),
        fallbackRowsReader: deps.readTelegramCatalogRows,
        getAvailablePaymentMethods: deps.getAvailablePaymentMethods
      });
      return true;
    }
  }

  return false;
}

/**
 * Handles new hybrid UI callbacks with parallel answerCallbackQuery + in-place edit.
 * Returns true if handled; false to delegate to legacy/admin callbacks.
 */
export async function handleCustomerHybridCallback(env, ctx, query, deps) {
  const data = String(query?.data || "");
  const message = query?.message || null;
  const chatId = String(message?.chat?.id || query?.from?.id || "");
  const userId = String(query?.from?.id || "");
  const callbackId = String(query?.id || "");
  const admin = deps.isAdmin(userId, env);

  // Non-admin Home button returns upgraded hybrid Beranda card + persistent Reply Keyboard.
  if (data === "nav:home" && !admin) {
    await Promise.all([
      answerTelegramCallback(env, callbackId),
      deleteTelegramMessage(env, message)
    ]);
    await sendCustomerHome(env, ctx, chatId, query.from);
    return true;
  }

  if (data === "nav:orders") {
    await showHistoryScreen(env, ctx, { chatId, userId, page: 0, message, callbackId });
    return true;
  }

  if (data.startsWith("cat:page:")) {
    const page = Math.max(0, Number(data.slice("cat:page:".length)) || 0);
    await showCatalogScreen(env, ctx, {
      chatId,
      userId,
      page,
      message,
      callbackId,
      fallbackRowsReader: deps.readTelegramCatalogRows
    });
    return true;
  }

  const parsed = parseUiCallback(data);
  if (!parsed) return false;

  if (parsed.type === "LANG_OPEN") {
    await showLanguageScreen(env, ctx, { chatId, userId, message, callbackId });
    return true;
  }

  if (parsed.type === "LANG_SET") {
    const newLang = normalizeLang(parsed.lang);
    await setUserLang(env, userId, newLang);
    const toast = newLang === "en" ? "🇬🇧 Language set to English" : "🇮🇩 Bahasa Indonesia dipilih";
    await Promise.all([
      answerTelegramCallback(env, callbackId, toast),
      deleteTelegramMessage(env, message)
    ]);
    await sendCustomerHome(env, ctx, chatId, query.from, { forceLang: newLang });
    return true;
  }

  if (parsed.type === "CLAIM_BOT" && typeof deps.handleClaimProductBot === "function") {
    await deps.handleClaimProductBot(env, ctx, query, parsed.orderId);
    return true;
  }

  if (parsed.type === "NOOP") {
    const langPref = await getUserLang(env, userId);
    const isEn = normalizeLang(langPref?.lang) === "en";
    const toast = parsed.reason === "min"
      ? (isEn ? "Minimum quantity is 1 unit" : "Jumlah minimal 1 unit")
      : parsed.reason === "max"
        ? (isEn ? "Reached maximum available stock" : "Mencapai batas stok tersedia")
        : "";
    await answerTelegramCallback(env, callbackId, toast);
    return true;
  }

  if (parsed.type === "SEARCH_OPEN") {
    await openSearchMode(env, ctx, { chatId, userId, message, callbackId });
    return true;
  }

  if (parsed.type === "SEARCH_CANCEL") {
    runBackground(ctx, clearUiMode(env, userId), "ui_clear_mode_cancel");
    const langPref = await getUserLang(env, userId);
    const isEn = normalizeLang(langPref?.lang) === "en";
    await Promise.all([
      answerTelegramCallback(env, callbackId, isEn ? "Search cancelled" : "Pencarian dibatalkan"),
      deleteTelegramMessage(env, message)
    ]);
    await sendCustomerHome(env, ctx, chatId, query.from);
    return true;
  }

  if (parsed.type === "STOCK_TAB" || parsed.type === "STOCK_REFRESH") {
    await showStockScreen(env, ctx, {
      chatId,
      userId,
      tab: parsed.tab,
      page: parsed.page,
      message,
      callbackId,
      bypassCache: parsed.type === "STOCK_REFRESH",
      fallbackRowsReader: deps.readTelegramCatalogRows
    });
    return true;
  }

  if (parsed.type === "PROD_VIEW") {
    await showProductCheckout(env, ctx, {
      chatId,
      userId,
      sku: parsed.sku,
      qty: 1,
      message,
      callbackId,
      backCallback: "stock:tab:avail:0",
      fallbackRowsReader: deps.readTelegramCatalogRows,
      getAvailablePaymentMethods: deps.getAvailablePaymentMethods
    });
    return true;
  }

  if (parsed.type === "CHK_QTY") {
    await showProductCheckout(env, ctx, {
      chatId,
      userId,
      sku: parsed.sku,
      qty: parsed.qty,
      message,
      callbackId,
      backCallback: "cat:page:0",
      fallbackRowsReader: deps.readTelegramCatalogRows,
      getAvailablePaymentMethods: deps.getAvailablePaymentMethods
    });
    return true;
  }

  if (parsed.type === "HIST_PAGE") {
    await showHistoryScreen(env, ctx, { chatId, userId, page: parsed.page, message, callbackId });
    return true;
  }

  if (parsed.type === "CHK_PAY") {
    const langPref = await getUserLang(env, userId);
    const isEn = normalizeLang(langPref?.lang) === "en";
    await answerTelegramCallback(env, callbackId, isEn ? "Creating order…" : "Memproses pesanan…");
    const customerName = [query.from?.first_name, query.from?.last_name].filter(Boolean).join(" ");
    const result = await deps.createOrder(env, {
      sku: parsed.sku.toUpperCase(),
      quantity: parsed.qty,
      paymentMethod: parsed.method,
      channel: "telegram",
      customerId: userId,
      customerName,
      idempotencyKey: [
        "telegram", userId, chatId,
        String(message?.message_id || query.id || ""),
        parsed.sku.toUpperCase(), String(parsed.qty), parsed.method
      ].join(":")
    });
    runBackground(ctx, invalidateStoreUiCaches(env), "ui_invalidate_after_order");
    await deps.deliverOrderCheckout(env, ctx, message, chatId, parsed.method, result, userId);
    return true;
  }

  return false;
}
