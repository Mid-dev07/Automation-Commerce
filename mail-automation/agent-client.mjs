const DEFAULT_BASE_URL = "https://mail.seiton.biz.id";
const MACHINE_API_PREFIX = "/api/v1/machine";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,160}$/;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const CLIENT_REF_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const MAILBOX_TTL_OPTIONS_SECONDS = new Set([
  600, 3600, 21600, 43200, 86400, 259200, 604800, 1209600, 2592000
]);

export class SeitonMailApiError extends Error {
  constructor(message, { status, payload, retryAfter } = {}) {
    super(message || "SeitonMail API request failed.");
    this.name = "SeitonMailApiError";
    this.status = Number(status || 0);
    this.payload = payload && typeof payload === "object" ? payload : {};
    this.retryAfter = retryAfter || null;
  }
}

export const TMailApiError = SeitonMailApiError;

function requireUuid(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new TypeError(`${fieldName} must be a valid mailbox/message UUID.`);
  }
  return normalized;
}

function requireClientRef(value) {
  const normalized = String(value ?? "").trim();
  if (!CLIENT_REF_PATTERN.test(normalized)) {
    throw new TypeError("clientRef is required and must use 1-100 URL-safe characters.");
  }
  return normalized;
}

export class SeitonMailClient {
  constructor({ token, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
      throw new TypeError("A valid SeitonMail machine Bearer token is required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }

    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(baseUrl);
    } catch {
      throw new TypeError("baseUrl must be an absolute HTTPS URL.");
    }
    if (parsedBaseUrl.protocol !== "https:" || parsedBaseUrl.username || parsedBaseUrl.password) {
      throw new TypeError("SeitonMail baseUrl must use HTTPS and must not contain credentials.");
    }

    this.token = token;
    this.baseUrl = parsedBaseUrl.origin;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = "GET", query, body, signal } = {}) {
    const url = new URL(path, this.baseUrl);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`
    };
    const init = { method, headers };
    if (signal !== undefined) init.signal = signal;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok || payload?.ok === false) {
      throw new SeitonMailApiError(
        payload?.error || `TMail API returned HTTP ${response.status}.`,
        {
          status: response.status,
          payload,
          retryAfter: response.headers.get("Retry-After")
        }
      );
    }
    return payload;
  }

  health({ signal } = {}) {
    return this.request(`${MACHINE_API_PREFIX}/health`, { signal });
  }

  createMailbox({ label = "Seiton agent", clientRef, ttlSeconds = 600, signal } = {}) {
    const normalizedClientRef = requireClientRef(clientRef);
    const normalizedLabel = String(label ?? "").trim().slice(0, 80);
    const normalizedTtlSeconds = Number(ttlSeconds);
    if (!Number.isSafeInteger(normalizedTtlSeconds) || !MAILBOX_TTL_OPTIONS_SECONDS.has(normalizedTtlSeconds)) {
      throw new RangeError("ttlSeconds must be one of the supported durations from 10 minutes to 30 days.");
    }
    return this.request(`${MACHINE_API_PREFIX}/mailboxes`, {
      method: "POST",
      body: {
        label: normalizedLabel,
        ttlSeconds: normalizedTtlSeconds,
        clientRef: normalizedClientRef
      },
      signal
    });
  }

  listMailboxes({ limit = 25, offset = 0, signal } = {}) {
    const safeLimit = Number(limit);
    const safeOffset = Number(offset);
    if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 50) {
      throw new RangeError("limit must be an integer between 1 and 50.");
    }
    if (!Number.isInteger(safeOffset) || safeOffset < 0 || safeOffset > 10000) {
      throw new RangeError("offset must be an integer between 0 and 10000.");
    }
    return this.request(`${MACHINE_API_PREFIX}/mailboxes`, {
      query: { limit: safeLimit, offset: safeOffset },
      signal
    });
  }

  listMessages({ mailboxId, after = 0, afterId, signal } = {}) {
    const id = requireUuid(mailboxId, "mailboxId");
    const safeAfter = Number(after);
    if (!Number.isSafeInteger(safeAfter) || safeAfter < 0) {
      throw new RangeError("after must be a non-negative safe integer timestamp.");
    }
    if (afterId && !UUID_PATTERN.test(String(afterId))) {
      throw new TypeError("afterId must be a valid message UUID.");
    }
    return this.request(`${MACHINE_API_PREFIX}/messages`, {
      query: { mailboxId: id, after: safeAfter, afterId },
      signal
    });
  }

  getMessage({ mailboxId, messageId, signal } = {}) {
    const mailbox = requireUuid(mailboxId, "mailboxId");
    const message = requireUuid(messageId, "messageId");
    return this.request(`${MACHINE_API_PREFIX}/messages/${message}`, {
      query: { mailboxId: mailbox },
      signal
    });
  }

  revokeMailbox(mailboxId, { signal } = {}) {
    const id = requireUuid(mailboxId, "mailboxId");
    return this.request(`${MACHINE_API_PREFIX}/mailboxes/${id}`, {
      method: "DELETE",
      signal
    });
  }
}

export const TMailClient = SeitonMailClient;

export { DEFAULT_BASE_URL };
