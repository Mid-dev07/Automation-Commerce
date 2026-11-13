const CATEGORIES = new Set(["muse_starter", "muse_bisnis"]);
const PRODUCT_SKU = {
  muse_starter: "MUSE-STARTER",
  muse_bisnis: "MUSE-BISNIS"
};
const PRODUCT_LABEL = {
  muse_starter: "Akun Muse Starter",
  muse_bisnis: "Paket Muse Bisnis (Full Setup)"
};

function clean(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

export function normalizeDigitalCategory(value) {
  const category = clean(value, 40).toLowerCase();
  if (!CATEGORIES.has(category)) throw new Error("DIGITAL_CATEGORY_INVALID");
  return category;
}

export function parseDigitalStockLines(input, categoryValue) {
  const category = normalizeDigitalCategory(categoryValue);
  const raw = Array.isArray(input) ? input.join("\n") : String(input ?? "");
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 100) throw new Error("DIGITAL_STOCK_BATCH_INVALID");
  const seen = new Set();
  return lines.map((line, index) => {
    const parts = line.split("|");
    if (parts.length < 3) throw new Error("DIGITAL_STOCK_LINE_" + (index + 1) + "_INVALID");
    const email = clean(parts[0], 254).toLowerCase();
    const password = String(parts[1] ?? "").trim();
    const note = clean(parts.slice(2).join("|"), 300);
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.biz\.id$/i.test(email)) {
      throw new Error("DIGITAL_STOCK_EMAIL_INVALID_" + (index + 1));
    }
    if (password.length < 8 || password.length > 256 || /[\r\n]/.test(password)) {
      throw new Error("DIGITAL_STOCK_PASSWORD_INVALID_" + (index + 1));
    }
    if (note.length > 300) throw new Error("DIGITAL_STOCK_NOTE_INVALID_" + (index + 1));
    if (seen.has(email)) throw new Error("DIGITAL_STOCK_DUPLICATE_IN_BATCH");
    seen.add(email);
    return { category, email, password, note };
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
async function encryptionKey(env) {
  if (!env.MUSE_STOCK_ENCRYPTION_KEY) throw new Error("MUSE_STOCK_ENCRYPTION_KEY_MISSING");
  const raw = base64ToBytes(env.MUSE_STOCK_ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error("MUSE_STOCK_ENCRYPTION_KEY_INVALID");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function sha256Hex(value) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function encryptPayload(env, value) {
  const key = await encryptionKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(JSON.stringify(value))
  );
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), nonce: bytesToBase64(nonce) };
}
async function decryptPayload(env, ciphertext, nonceValue) {
  const key = await encryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(nonceValue) },
    key,
    base64ToBytes(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
function nowIso() { return new Date().toISOString(); }

async function syncStockCount(db, category) {
  const sku = PRODUCT_SKU[category];
  const now = nowIso();
  await db.prepare(`
    UPDATE catalog_products
    SET stock = MAX(0,
      (SELECT COUNT(*) FROM digital_stock_accounts
       WHERE category=? AND status='AVAILABLE')
      -
      (SELECT COUNT(*) FROM orders
       WHERE sku=? AND stock_reserved=1
         AND status NOT IN ('DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED',
                            'DIBATALKAN','CANCELLED','CANCELED'))
    ),
    active = CASE WHEN (
      (SELECT COUNT(*) FROM digital_stock_accounts
       WHERE category=? AND status='AVAILABLE')
      -
      (SELECT COUNT(*) FROM orders
       WHERE sku=? AND stock_reserved=1
         AND status NOT IN ('DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED',
                            'DIBATALKAN','CANCELLED','CANCELED'))
    ) > 0 THEN 1 ELSE 0 END,
    updated_at=?
    WHERE sku=?
  `).bind(category, sku, category, sku, now, sku).run();
}

export async function addDigitalStockD1(env, categoryValue, input, actor) {
  const category = normalizeDigitalCategory(categoryValue);
  const rows = parseDigitalStockLines(input, category);
  const inserts = [];
  for (const row of rows) {
    const emailHash = await sha256Hex(row.email);
    const encrypted = await encryptPayload(env, { email: row.email, password: row.password, note: row.note });
    inserts.push(env.DB.prepare(`
      INSERT OR IGNORE INTO digital_stock_accounts
      (stock_id,category,email_hash,email_domain,encrypted_payload,payload_nonce,status,created_at)
      VALUES(?,?,?,?,?,?,'AVAILABLE',?)
    `).bind(
      "stk_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      category,
      emailHash,
      row.email.split("@")[1],
      encrypted.ciphertext,
      encrypted.nonce,
      nowIso()
    ));
  }
  const results = await env.DB.batch(inserts);
  const added = results.reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);
  if (added) await syncStockCount(env.DB, category);
  if (env.MUSE_KV) {
    await env.MUSE_KV.put("stock:summary:" + category, JSON.stringify({
      category, available: await digitalStockCount(env.DB, category), updated_at: nowIso()
    }), { expirationTtl: 86400 });
  }
  return {
    category,
    added,
    duplicate: rows.length - added,
    available: await digitalStockCount(env.DB, category),
    actor: clean(actor, 128)
  };
}

async function digitalStockCount(db, category) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM digital_stock_accounts WHERE category=? AND status='AVAILABLE'"
  ).bind(category).first();
  return Number(row?.count || 0);
}

export async function listDigitalStockD1(db) {
  const rows = await db.prepare(`
    SELECT category,status,COUNT(*) AS count,
      GROUP_CONCAT(DISTINCT email_domain) AS domains
    FROM digital_stock_accounts
    GROUP BY category,status
    ORDER BY category,status
  `).all();
  const output = {};
  for (const category of CATEGORIES) {
    output[category] = { available: 0, claimed: 0, revoked: 0, domains: [] };
  }
  for (const row of rows.results || []) {
    const item = output[row.category];
    if (!item) continue;
    if (row.status === "AVAILABLE") item.available = Number(row.count || 0);
    if (row.status === "CLAIMED") item.claimed = Number(row.count || 0);
    if (row.status === "REVOKED") item.revoked = Number(row.count || 0);
    if (row.status === "AVAILABLE" && row.domains) item.domains = String(row.domains).split(",").sort();
  }
  return output;
}

export async function deleteDigitalStockD1(env, categoryValue, emailValue, actor) {
  const category = normalizeDigitalCategory(categoryValue);
  const email = clean(emailValue, 254).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^`{|}~-]+@[a-z0-9.-]+\.biz\.id$/i.test(email)) {
    throw new Error("DIGITAL_STOCK_EMAIL_INVALID");
  }
  const emailHash = await sha256Hex(email);
  const result = await env.DB.prepare(`
    UPDATE digital_stock_accounts
    SET status='REVOKED',revoked_at=?
    WHERE category=? AND email_hash=? AND status='AVAILABLE'
  `).bind(nowIso(), category, emailHash).run();
  if (Number(result.meta?.changes || 0) === 1) await syncStockCount(env.DB, category);
  return { removed: Number(result.meta?.changes || 0) === 1, category, actor: clean(actor, 128) };
}

export async function claimDigitalStockD1(env, categoryValue, orderId) {
  const category = normalizeDigitalCategory(categoryValue);
  const id = clean(orderId, 80);
  if (!id) throw new Error("DIGITAL_ORDER_ID_REQUIRED");
  const existing = await env.DB.prepare(
    "SELECT order_id,category,status,stock_id FROM digital_fulfillments WHERE order_id=?"
  ).bind(id).first();
  if (existing) {
    if (existing.status === "WAITING_STOCK") {
      // Retry the claim below after new inventory has been added.
    } else if (existing.stock_id && ["CLAIMED","DELIVERED"].includes(existing.status)) {
      const stock = await env.DB.prepare(
        "SELECT encrypted_payload,payload_nonce FROM digital_stock_accounts WHERE stock_id=? AND claimed_order_id=?"
      ).bind(existing.stock_id, id).first();
      if (stock && existing.status === "CLAIMED") {
        return { status: existing.status, alreadyClaimed: true, credentials: await decryptPayload(env, stock.encrypted_payload, stock.payload_nonce), category };
      }
      return { status: existing.status, alreadyClaimed: true, credentials: null, category };
    } else {
      throw new Error("DIGITAL_FULFILLMENT_STATE_INVALID");
    }
  }

  const order = await env.DB.prepare(
    "SELECT order_id,sku,customer_id,channel,status,payment_confirmation_status FROM orders WHERE order_id=?"
  ).bind(id).first();
  if (!order || String(order.sku || "").toUpperCase() !== PRODUCT_SKU[category]) throw new Error("DIGITAL_ORDER_NOT_FOUND");
  if (!["DIBAYAR","DIPROSES","DIKIRIM","SELESAI","PAID","COMPLETED"].includes(String(order.status || "").toUpperCase())) {
    throw new Error("DIGITAL_ORDER_NOT_PAID");
  }
  if (String(order.payment_confirmation_status || "").toUpperCase() !== "DISETUJUI") {
    throw new Error("DIGITAL_PAYMENT_NOT_CONFIRMED");
  }

  const now = nowIso();
  const picked = await env.DB.prepare(`
    UPDATE digital_stock_accounts
    SET status='CLAIMED',claimed_order_id=?,claimed_at=?
    WHERE stock_id=(
      SELECT stock_id FROM digital_stock_accounts
      WHERE category=? AND status='AVAILABLE'
      ORDER BY created_at,stock_id LIMIT 1
    )
    AND status='AVAILABLE'
    RETURNING stock_id,encrypted_payload,payload_nonce
  `).bind(id, now, category).all();

  const item = picked.results?.[0];
  if (!item) {
    await env.DB.prepare(`
      INSERT INTO digital_fulfillments(order_id,category,status,updated_at)
      VALUES(?,?,'WAITING_STOCK',?)
      ON CONFLICT(order_id) DO UPDATE SET status='WAITING_STOCK',updated_at=excluded.updated_at
    `).bind(id, category, now).run();
    return { status: "WAITING_STOCK", alreadyClaimed: false, credentials: null, category };
  }

  await env.DB.prepare(`
    INSERT INTO digital_fulfillments(order_id,category,status,stock_id,claimed_at,updated_at)
    VALUES(?,?,'CLAIMED',?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET
      status='CLAIMED',stock_id=excluded.stock_id,claimed_at=excluded.claimed_at,updated_at=excluded.updated_at
  `).bind(id, category, item.stock_id, now, now).run();
  await syncStockCount(env.DB, category);
  return {
    status: "CLAIMED",
    alreadyClaimed: false,
    credentials: await decryptPayload(env, item.encrypted_payload, item.payload_nonce),
    category,
    customerId: order.customer_id,
    channel: order.channel
  };
}

export async function markDigitalDeliveredD1(db, orderId) {
  const now = nowIso();
  const result = await db.prepare(`
    UPDATE digital_fulfillments
    SET status='DELIVERED',delivery_attempts=delivery_attempts+1,delivered_at=?,updated_at=?
    WHERE order_id=? AND status='CLAIMED'
  `).bind(now, now, clean(orderId, 80)).run();
  return Number(result.meta?.changes || 0) === 1;
}

export async function getDigitalOrderD1(env, orderId) {
  const id = clean(orderId, 80);
  const row = await env.DB.prepare(`
    SELECT f.order_id,f.category,f.status,f.stock_id,f.delivery_attempts,f.claimed_at,f.delivered_at,
      s.encrypted_payload,s.payload_nonce,o.customer_id,o.customer_name,o.total,o.status AS order_status,
      o.payment_confirmation_status
    FROM digital_fulfillments f
    LEFT JOIN digital_stock_accounts s ON s.stock_id=f.stock_id
    LEFT JOIN orders o ON o.order_id=f.order_id
    WHERE f.order_id=?
  `).bind(id).first();
  if (!row) return null;
  const credentials = row.encrypted_payload && row.status !== "WAITING_STOCK"
    ? await decryptPayload(env, row.encrypted_payload, row.payload_nonce) : null;
  return { ...row, credentials };
}

export async function createOtpPortalAccess(env, emailValue, orderId, ownerChatId) {
  if (!env.OTP_KV) throw new Error("OTP_KV_BINDING_MISSING");
  const email = clean(emailValue, 254).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^`{|}~-]+@[a-z0-9.-]+\.biz\.id$/i.test(email)) {
    throw new Error("OTP_MAILBOX_DOMAIN_INVALID");
  }
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64(tokenBytes).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  const tokenHash = await sha256Hex(token);
  const emailHash = await sha256Hex(email);
  const value = {
    email,
    token_hash: tokenHash,
    order_id: clean(orderId, 80),
    owner_chat_id: clean(ownerChatId, 80),
    created_at: nowIso()
  };
  await env.OTP_KV.put("mailbox:" + emailHash, JSON.stringify(value), { expirationTtl: 30 * 86400 });
  return "https://otp.seiton.biz.id/?email=" + encodeURIComponent(email) + "#token=" + encodeURIComponent(token);
}
