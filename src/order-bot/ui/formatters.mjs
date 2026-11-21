/**
 * Lightweight HTML & monospace table formatters for Telegram Bot API (parse_mode: "HTML").
 * Keeps mobile tables <= 32 chars wide and escapes all dynamic strings safely.
 */

export const MOBILE_TABLE_MAX_WIDTH = 32;

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatRp(amount) {
  const num = Number(amount);
  const safe = Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
  return "Rp " + new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(safe);
}

export function cleanSingleLine(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function truncateText(value, maxLen) {
  const limit = Math.max(1, Number(maxLen) || 1);
  const text = cleanSingleLine(value);
  if (text.length <= limit) return text;
  if (limit === 1) return "…";
  return text.slice(0, limit - 1).trimEnd() + "…";
}

export function padCell(value, width, align = "left") {
  const text = truncateText(value, width);
  const pad = Math.max(0, width - text.length);
  return align === "right" ? " ".repeat(pad) + text : text + " ".repeat(pad);
}

/**
 * Renders a compact monospace <pre> table with fixed column widths.
 * Total line length stays <= MOBILE_TABLE_MAX_WIDTH (32 chars) on mobile screens.
 */
export function renderMonospaceTable(columns, rows, separator = " ") {
  const header = columns
    .map((col) => padCell(col.label, col.width, col.align || "left"))
    .join(separator);
  const totalWidth = Math.min(MOBILE_TABLE_MAX_WIDTH, header.length);
  const divider = "─".repeat(totalWidth);
  const body = rows.map((row) =>
    columns
      .map((col, idx) => padCell(row[idx], col.width, col.align || "left"))
      .join(separator)
  );
  const lines = [header, divider, ...body];
  return "<pre>" + escapeHtml(lines.join("\n")) + "</pre>";
}

export function renderBlockquote(lines) {
  const filtered = (lines || []).filter((line) => line !== null && line !== undefined && line !== "");
  if (!filtered.length) return "";
  return "<blockquote>" + filtered.join("\n") + "</blockquote>";
}

export function renderHint(text) {
  return "<i>ℹ️ " + escapeHtml(text) + "</i>";
}

export function createLatencyTracker(screen) {
  const startedAt = Date.now();
  const metrics = {
    kv_ms: 0,
    d1_ms: 0,
    tg_ms: 0,
    cache_hit: false
  };
  return {
    async measure(bucket, fn) {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        const key = bucket + "_ms";
        if (key in metrics) metrics[key] += Date.now() - t0;
      }
    },
    markCacheHit(hit) {
      metrics.cache_hit = Boolean(hit);
    },
    emit(extra = {}) {
      console.log(JSON.stringify({
        level: "info",
        event: "telegram_ui_timing",
        screen,
        ...metrics,
        total_ms: Date.now() - startedAt,
        ...extra
      }));
    }
  };
}
