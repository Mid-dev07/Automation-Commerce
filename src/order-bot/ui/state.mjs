/**
 * KV-backed UI state, short-TTL store/catalog caches, and indexed D1 queries
 * for low-latency Telegram interactions (< 150ms cached, < 350ms D1-backed).
 */

import { parseCatalogProduct } from "../utils.mjs";

const CATALOG_MAPPING_TTL_SECONDS = 15 * 60;
const UI_MODE_TTL_SECONDS = 5 * 60;
const STORE_STATS_TTL_SECONDS = 90;
const CATALOG_SNAPSHOT_TTL_SECONDS = 60;
const BANNER_FILE_ID_TTL_SECONDS = 7 * 24 * 60 * 60;
const QRIS_MSG_TTL_SECONDS = 24 * 60 * 60;

const PAID_SQL_STATUSES = "('DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED')";

function uiKv(env) {
  return env?.MUSE_KV || null;
}

export function runBackground(ctx, promise, eventName = "telegram_ui_bg") {
  const safe = Promise.resolve(promise).catch((error) => {
    console.warn(JSON.stringify({
      level: "warn",
      event: eventName,
      message: String(error?.message || error).slice(0, 180)
    }));
  });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(safe);
  }
  return safe;
}

async function kvGetJson(env, key) {
  const kv = uiKv(env);
  if (!kv) return null;
  try {
    return await kv.get(key, "json");
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "ui_kv_get_failed", key, message: String(error?.message || error).slice(0, 120) }));
    return null;
  }
}

async function kvPutJson(env, key, value, expirationTtl) {
  const kv = uiKv(env);
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl });
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "ui_kv_put_failed", key, message: String(error?.message || error).slice(0, 120) }));
  }
}

async function kvDelete(env, key) {
  const kv = uiKv(env);
  if (!kv) return;
  try {
    await kv.delete(key);
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "ui_kv_delete_failed", key, message: String(error?.message || error).slice(0, 120) }));
  }
}

export function getUiMode(env, userId) {
  return kvGetJson(env, "ui:mode:" + String(userId));
}

export function setUiMode(env, userId, modePayload) {
  return kvPutJson(env, "ui:mode:" + String(userId), modePayload, UI_MODE_TTL_SECONDS);
}

export function clearUiMode(env, userId) {
  return kvDelete(env, "ui:mode:" + String(userId));
}

export function getCatalogMapping(env, userId) {
  return kvGetJson(env, "ui:catalog:" + String(userId));
}

export function setCatalogMapping(env, userId, mapping) {
  return kvPutJson(env, "ui:catalog:" + String(userId), mapping, CATALOG_MAPPING_TTL_SECONDS);
}

export function getQrisMessageRef(env, orderId) {
  return kvGetJson(env, "ui:qris_msg:" + String(orderId));
}

export function setQrisMessageRef(env, orderId, ref) {
  return kvPutJson(env, "ui:qris_msg:" + String(orderId), ref, QRIS_MSG_TTL_SECONDS);
}

export function clearQrisMessageRef(env, orderId) {
  return kvDelete(env, "ui:qris_msg:" + String(orderId));
}

function simpleUrlKey(url) {
  let hash = 2166136261;
  const text = String(url || "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "ui:banner_file_id:" + (hash >>> 0).toString(16);
}

export function getBannerFileId(env, bannerUrl) {
  return kvGetJson(env, simpleUrlKey(bannerUrl));
}

export function setBannerFileId(env, bannerUrl, fileId) {
  if (!fileId) return Promise.resolve();
  return kvPutJson(env, simpleUrlKey(bannerUrl), { fileId, url: bannerUrl }, BANNER_FILE_ID_TTL_SECONDS);
}

export async function invalidateStoreUiCaches(env) {
  await Promise.all([
    kvDelete(env, "stats:store"),
    kvDelete(env, "ui:catalog_snapshot")
  ]);
}

/**
 * Aggregated store metrics for Beranda (/start). Cached in KV for 90s.
 * Uses 2 parallel single-pass SQL queries (0 N+1 queries).
 */
export async function getStoreStats(env, { bypassCache = false, ctx = null } = {}) {
  if (!bypassCache) {
    const cached = await kvGetJson(env, "stats:store");
    if (cached && typeof cached === "object") {
      return { stats: cached, cacheHit: true };
    }
  }
  const empty = { totalRevenue: 0, successTx: 0, soldUnits: 0, activeProducts: 0, totalUsers: 0 };
  if (!env?.DB) return { stats: empty, cacheHit: false };
  try {
    const [orderRow, prodRow] = await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(*) AS success_tx, COALESCE(SUM(total),0) AS total_revenue, " +
        "COALESCE(SUM(quantity),0) AS sold_units, COUNT(DISTINCT customer_id) AS total_users " +
        "FROM orders WHERE UPPER(status) IN " + PAID_SQL_STATUSES
      ).first(),
      env.DB.prepare("SELECT COUNT(*) AS active_products FROM catalog_products WHERE active = 1").first()
    ]);
    const stats = {
      totalRevenue: Number(orderRow?.total_revenue || 0),
      successTx: Number(orderRow?.success_tx || 0),
      soldUnits: Number(orderRow?.sold_units || 0),
      activeProducts: Number(prodRow?.active_products || 0),
      totalUsers: Number(orderRow?.total_users || 0)
    };
    runBackground(ctx, kvPutJson(env, "stats:store", stats, STORE_STATS_TTL_SECONDS), "ui_stats_cache_put");
    return { stats, cacheHit: false };
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "ui_store_stats_query_failed", message: String(error?.message || error).slice(0, 140) }));
    return { stats: empty, cacheHit: false };
  }
}

/**
 * Active catalog + sold unit counts in a SINGLE LEFT JOIN D1 query (0 N+1),
 * cached in KV for 60s. Falls back cleanly to legacy catalog rows when D1 is unavailable.
 */
export async function getCatalogSnapshot(env, { bypassCache = false, ctx = null, fallbackRowsReader = null } = {}) {
  if (!bypassCache) {
    const cached = await kvGetJson(env, "ui:catalog_snapshot");
    if (cached && Array.isArray(cached.items)) {
      return { items: cached.items, cacheHit: true };
    }
  }

  let items = [];
  if (env?.DB) {
    try {
      const readinessRow = await env.DB.prepare(
        "SELECT value FROM app_meta WHERE key = 'transaction_store_state' LIMIT 1"
      ).first();
      if (String(readinessRow?.value || "").toUpperCase() === "READY") {
        const result = await env.DB.prepare(
          "SELECT p.sku, p.name, p.price, p.stock, p.active, p.photo_url, p.description, " +
          "COALESCE(s.sold_units, 0) AS sold_units " +
          "FROM catalog_products p " +
          "LEFT JOIN (" +
          "  SELECT UPPER(sku) AS sku_upper, SUM(quantity) AS sold_units " +
          "  FROM orders WHERE UPPER(status) IN " + PAID_SQL_STATUSES + " GROUP BY UPPER(sku)" +
          ") s ON UPPER(p.sku) = s.sku_upper " +
          "WHERE p.active = 1 " +
          "ORDER BY p.name COLLATE NOCASE"
        ).all();
        items = (result.results || []).map((row) => ({
          sku: String(row.sku || "").trim(),
          name: String(row.name || row.sku || "").trim(),
          price: Number(row.price || 0),
          stock: row.stock === null || row.stock === undefined ? null : Number(row.stock),
          active: Boolean(row.active),
          photoUrl: String(row.photo_url || "").trim(),
          description: String(row.description || "").trim(),
          soldUnits: Number(row.sold_units || 0)
        }));
        runBackground(ctx, kvPutJson(env, "ui:catalog_snapshot", { items }, CATALOG_SNAPSHOT_TTL_SECONDS), "ui_catalog_cache_put");
        return { items, cacheHit: false };
      }
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "ui_catalog_snapshot_d1_failed", message: String(error?.message || error).slice(0, 140) }));
    }
  }

  if (typeof fallbackRowsReader === "function") {
    const rows = await fallbackRowsReader(env);
    items = (rows || [])
      .filter((r) => r?.[0])
      .map((r) => parseCatalogProduct(r))
      .filter((p) => p.active && p.priceValid && p.stockValid)
      .map((p) => ({ ...p, soldUnits: 0 }));
  }
  return { items, cacheHit: false };
}

/**
 * Paginated per-customer order history query (eliminates old 5,000-row scan).
 */
export async function listCustomerOrdersPage(env, customerId, page = 0, pageSize = 5) {
  const safePage = Math.max(0, Number(page) || 0);
  const safeSize = Math.max(1, Math.min(20, Number(pageSize) || 5));
  if (!env?.DB) return { orders: [], totalCount: 0, page: 0, totalPages: 1 };
  const [countRow, listResult] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS cnt FROM orders WHERE customer_id = ?").bind(String(customerId)).first(),
    env.DB.prepare(
      "SELECT order_id, sku, product_name, quantity, total, payment_method, status, payment_confirmation_status, receipt_code, created_at " +
      "FROM orders WHERE customer_id = ? ORDER BY created_ms DESC LIMIT ? OFFSET ?"
    ).bind(String(customerId), safeSize, safePage * safeSize).all()
  ]);
  const totalCount = Number(countRow?.cnt || 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / safeSize));
  return {
    orders: listResult.results || [],
    totalCount,
    page: Math.min(safePage, totalPages - 1),
    totalPages
  };
}
