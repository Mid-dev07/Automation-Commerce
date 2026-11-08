const ALLOWED_CHANNELS = new Set(["telegram", "whatsapp"]);
const ALLOWED_PAYMENTS = new Set(["QRIS", "TRANSFER", "COD"]);

function clean(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function timestamp(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("MESSAGING_INVALID_TIMESTAMP");
  return parsed.toISOString();
}

function changed(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export function normalizeInboundEvent(input) {
  if (!input || typeof input !== "object") throw new Error("MESSAGING_INVALID_EVENT");

  const channel = clean(input.channel, 20).toLowerCase();
  const eventId = clean(input.eventId, 180);
  const conversationId = clean(input.conversationId, 180);
  const senderId = clean(input.senderId, 180);
  const externalMessageId = clean(input.externalMessageId || input.messageId, 180);
  const text = clean(input.text, 2000);

  if (!ALLOWED_CHANNELS.has(channel)) throw new Error("MESSAGING_UNSUPPORTED_CHANNEL");
  if (!eventId || !conversationId || !senderId || !externalMessageId) {
    throw new Error("MESSAGING_MISSING_IDENTITY");
  }
  if (input.fromMe === true || input.isDirect === false) {
    throw new Error("MESSAGING_NON_CUSTOMER_EVENT");
  }
  if (input.eventType && !["message", "choice"].includes(input.eventType)) {
    throw new Error("MESSAGING_UNSUPPORTED_EVENT_TYPE");
  }
  if (!text && !clean(input.choiceId, 80)) throw new Error("MESSAGING_EMPTY_EVENT");

  return {
    tenantId: clean(input.tenantId || "seiton", 80),
    channel,
    eventId,
    externalMessageId,
    conversationId,
    senderId,
    customerName: clean(input.customerName || input.senderName || "Pelanggan", 100),
    text,
    choiceId: clean(input.choiceId, 80),
    eventType: input.eventType === "choice" ? "choice" : "message",
    occurredAt: timestamp(input.occurredAt)
  };
}

export function parseMessagingCommand(rawText) {
  const text = clean(rawText, 2000);
  const normalized = text.toUpperCase();

  if (/^\/?(?:START)(?:\s|$)/.test(normalized)) return { kind: "START" };
  if (/^\/?(?:STOP)(?:\s|$)/.test(normalized)) return { kind: "STOP" };
  if (/^\/?(?:MENU|HELP|BANTUAN)(?:\s|$)/.test(normalized)) return { kind: "MENU" };
  if (/^\/?(?:KATALOG|PRODUK|CATALOG)(?:\s|$)/.test(normalized)) return { kind: "CATALOG" };
  if (/^\/?(?:PESANAN|ORDERS)(?:\s|$)/.test(normalized)) return { kind: "ORDERS" };
  if (/^\/?(?:ADMIN|BANTUAN ADMIN)(?:\s|$)/.test(normalized)) return { kind: "HANDOFF" };

  const statusMatch = normalized.match(/^STATUS\s+([A-Z0-9._-]{4,80})$/);
  if (statusMatch) return { kind: "STATUS", orderId: statusMatch[1] };

  const buyMatch = normalized.match(/^BELI\s+([A-Z0-9._-]{1,40})\s+([1-9]\d{0,3})\s+(QRIS|TRANSFER|COD)$/);
  if (buyMatch) {
    const quantity = Number(buyMatch[2]);
    if (quantity <= 1000 && ALLOWED_PAYMENTS.has(buyMatch[3])) {
      return {
        kind: "BUY",
        sku: buyMatch[1],
        quantity,
        paymentMethod: buyMatch[3]
      };
    }
  }

  return { kind: "UNKNOWN" };
}

function textAction(text, target = {}) {
  return {
    channel: target.channel,
    recipientId: target.recipientId,
    type: "text",
    text: clean(text, 3500)
  };
}

function formatPrice(value) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

export async function routeMessagingCommand(event, command, mode, services) {
  const actions = [];
  let nextMode = mode || "BOT";
  let conversationState = command.kind;

  if (command.kind === "STOP") {
    nextMode = "OPTED_OUT";
    actions.push(textAction(
      "Permintaan berhenti diterima. Balasan otomatis Seiton dinonaktifkan untuk percakapan ini. Ketik START untuk mengaktifkannya kembali."
    ));
    return { actions, mode: nextMode, state: conversationState, handoff: false };
  }

  if (command.kind === "START") {
    nextMode = "BOT";
    actions.push(textAction("Layanan otomatis Seiton diaktifkan kembali. Ketik MENU untuk melihat pilihan."));
    return { actions, mode: nextMode, state: conversationState, handoff: false };
  }

  if (mode === "OPTED_OUT" || mode === "HUMAN") {
    return { actions, mode: nextMode, state: conversationState, handoff: false };
  }

  if (command.kind === "MENU" || command.kind === "UNKNOWN") {
    actions.push(textAction([
      "🛍️ SELAMAT DATANG DI SEITON.ID",
      "",
      "Ketik salah satu perintah:",
      "KATALOG — melihat produk dan harga",
      "PESANAN — melihat pesanan terakhir",
      "STATUS ID_PESANAN — memeriksa satu pesanan",
      "BELI SKU JUMLAH METODE — membuat pesanan",
      "ADMIN — meminta bantuan admin",
      "",
      "Contoh: BELI SEI-001 2 QRIS"
    ].join("\n")));
  } else if (command.kind === "CATALOG") {
    const products = await services.listProducts();
    const active = (products || []).filter(product =>
      product.active !== false &&
      product.priceValid !== false &&
      product.stockValid !== false
    ).slice(0, 20);

    if (!active.length) {
      actions.push(textAction("Katalog belum memiliki produk aktif."));
    } else {
      const lines = active.map(product => {
        const stock = product.stock == null ? "Tidak dibatasi" : String(product.stock);
        return [
          product.sku + " — " + product.name,
          "Harga: " + formatPrice(product.price),
          "Stok: " + stock
        ].join("\n");
      });
      actions.push(textAction(
        "🛍️ KATALOG SEITON\n\n" + lines.join("\n\n") +
        "\n\nUntuk memesan: BELI SKU JUMLAH QRIS / TRANSFER / COD"
      ));
    }
  } else if (command.kind === "ORDERS") {
    const orders = await services.listOrders(event.senderId);
    const mine = (orders || []).slice(0, 5);

    if (!mine.length) {
      actions.push(textAction("Belum ada pesanan yang tercatat untuk akun ini."));
    } else {
      const lines = mine.map(order =>
        [
          order.orderId,
          order.product,
          String(order.quantity) + " pcs",
          formatPrice(order.total),
          order.status
        ].join(" | ")
      );
      actions.push(textAction("📦 PESANAN TERAKHIR\n\n" + lines.join("\n")));
    }
  } else if (command.kind === "STATUS") {
    const order = await services.findOrder(command.orderId);
    if (!order || String(order.customerId) !== String(event.senderId)) {
      actions.push(textAction("Pesanan tidak ditemukan untuk akun ini."));
    } else {
      actions.push(textAction([
        "📦 STATUS PESANAN",
        "ID: " + order.orderId,
        "Produk: " + order.product,
        "Jumlah: " + order.quantity,
        "Total: " + formatPrice(order.total),
        "Pembayaran: " + order.paymentMethod,
        "Status: " + order.status
      ].join("\n")));
    }
  } else if (command.kind === "BUY") {
    const order = await services.createOrder({
      sku: command.sku,
      quantity: command.quantity,
      paymentMethod: command.paymentMethod,
      channel: event.channel,
      customerId: event.senderId,
      customerName: event.customerName,
      idempotencyKey: event.eventId
    });
    const reply = services.renderOrder
      ? services.renderOrder(order)
      : [
          "✅ PESANAN TERCATAT",
          "ID: " + order.orderId,
          "Produk: " + order.product,
          "Jumlah: " + order.quantity,
          "Total: " + formatPrice(order.total),
          "Status: " + order.status
        ].join("\n");
    actions.push(textAction(reply));
  } else if (command.kind === "HANDOFF") {
    nextMode = "HUMAN";
    const handoff = {
      handoffId: event.channel + ":" + event.eventId + ":handoff",
      tenantId: event.tenantId,
      sourceChannel: event.channel,
      conversationId: event.conversationId,
      customerId: event.senderId,
      customerName: event.customerName,
      sourceEventId: event.eventId
    };
    const adminTargets = services.getAdminTargets ? await services.getAdminTargets() : [];
    for (const recipientId of adminTargets) {
      actions.push(textAction(
        "📣 Permintaan bantuan pelanggan\nNama: " + event.customerName +
        "\nKanal: " + event.channel +
        "\nID pengirim: " + event.senderId +
        "\nConversation: " + event.conversationId,
        { channel: "telegram", recipientId }
      ));
    }
    actions.push(textAction(
      "Permintaan bantuan diteruskan kepada admin. Balasan otomatis dihentikan sementara agar admin dapat mengambil alih percakapan."
    ));
    return { actions, mode: nextMode, state: conversationState, handoff };
  }

  return { actions, mode: nextMode, state: conversationState, handoff: false };
}

export async function processMessagingEvent(env, input, services) {
  if (!env?.DB) throw new Error("MESSAGING_DATABASE_NOT_CONFIGURED");
  const event = normalizeInboundEvent(input);
  const db = env.DB;
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 30000).toISOString();

  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO messaging_inbound_events(" +
    "tenant_id,channel,event_id,external_message_id,conversation_id,sender_id,event_type," +
    "status,attempts,lease_until,received_at) VALUES(?,?,?,?,?,?,'message','PROCESSING',1,?,?)"
  ).bind(
    event.tenantId, event.channel, event.eventId, event.externalMessageId,
    event.conversationId, event.senderId, leaseUntil, now
  ).run();

  if (changed(inserted) !== 1) {
    const existing = await db.prepare(
      "SELECT status,lease_until FROM messaging_inbound_events " +
      "WHERE tenant_id=? AND channel=? AND event_id=?"
    ).bind(event.tenantId, event.channel, event.eventId).first();

    if (existing?.status === "PROCESSED") {
      return { accepted: true, duplicate: true, inProgress: false, actions: [] };
    }

    const expiredLease = !existing?.lease_until || existing.lease_until <= now;
    if (existing?.status !== "FAILED" && !(existing?.status === "PROCESSING" && expiredLease)) {
      return { accepted: true, duplicate: false, inProgress: true, actions: [] };
    }

    const reclaimed = await db.prepare(
      "UPDATE messaging_inbound_events SET status='PROCESSING',attempts=attempts+1," +
      "lease_until=?,error_code=NULL WHERE tenant_id=? AND channel=? AND event_id=? " +
      "AND (status='FAILED' OR (status='PROCESSING' AND lease_until<=?))"
    ).bind(
      leaseUntil, event.tenantId, event.channel, event.eventId, now
    ).run();

    if (changed(reclaimed) !== 1) {
      return { accepted: true, duplicate: false, inProgress: true, actions: [] };
    }
  }

  try {
    await db.prepare(
      "INSERT OR IGNORE INTO messaging_conversations(" +
      "tenant_id,channel,conversation_id,customer_id,customer_name,mode,state,created_at,updated_at) " +
      "VALUES(?,?,?,?,?,'BOT','IDLE',?,?)"
    ).bind(
      event.tenantId, event.channel, event.conversationId,
      event.senderId, event.customerName, now, now
    ).run();

    const conversation = await db.prepare(
      "SELECT mode FROM messaging_conversations WHERE tenant_id=? AND channel=? AND conversation_id=?"
    ).bind(event.tenantId, event.channel, event.conversationId).first();

    const command = event.eventType === "choice"
      ? { kind: clean(event.choiceId, 40).toUpperCase() }
      : parseMessagingCommand(event.text);
    const routed = await routeMessagingCommand(
      event, command, conversation?.mode || "BOT", services
    );
    const actions = routed.actions || [];
    const outboxStatements = actions.map((action, index) => {
      const targetChannel = action.channel || event.channel;
      const recipientId = action.recipientId || event.conversationId;
      const actionId = event.channel + ":" + event.eventId + ":" + index;
      const payload = JSON.stringify({ type: action.type, text: action.text });
      return db.prepare(
        "INSERT OR IGNORE INTO messaging_outbox(" +
        "action_id,tenant_id,channel,conversation_id,recipient_id,source_event_id," +
        "action_type,payload_json,status,attempts,available_at,created_at,updated_at) " +
        "VALUES(?,?,?,?,?,?,? ,?,'PENDING',0,?,?,?)"
      ).bind(
        actionId, event.tenantId, targetChannel, event.conversationId,
        recipientId, event.eventId, action.type || "text", payload, now, now, now
      );
    });

    const statements = [
      db.prepare(
        "UPDATE messaging_conversations SET mode=?,state=?,customer_name=?," +
        "last_inbound_at=?,opted_out_at=?,handoff_requested_at=?,updated_at=? " +
        "WHERE tenant_id=? AND channel=? AND conversation_id=?"
      ).bind(
        routed.mode,
        routed.state,
        event.customerName,
        now,
        routed.mode === "OPTED_OUT" ? now : null,
        routed.handoff ? now : null,
        now,
        event.tenantId,
        event.channel,
        event.conversationId
      ),
      ...outboxStatements,
      db.prepare(
        "UPDATE messaging_inbound_events SET status='PROCESSED',lease_until=NULL," +
        "processed_at=?,error_code=NULL WHERE tenant_id=? AND channel=? AND event_id=?"
      ).bind(now, event.tenantId, event.channel, event.eventId)
    ];

    await db.batch(statements);

    if (routed.handoff) {
      await db.prepare(
        "INSERT OR IGNORE INTO messaging_handoff_requests(" +
        "handoff_id,tenant_id,source_channel,conversation_id,customer_id,customer_name," +
        "source_event_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'OPEN',?,?)"
      ).bind(
        routed.handoff.handoffId, routed.handoff.tenantId, routed.handoff.sourceChannel,
        routed.handoff.conversationId, routed.handoff.customerId, routed.handoff.customerName,
        routed.handoff.sourceEventId, now, now
      ).run();
    }

    return { accepted: true, duplicate: false, inProgress: false, actions };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message)
      ? error.message
      : "MESSAGING_PROCESSING_FAILED";
    await db.prepare(
      "UPDATE messaging_inbound_events SET status='FAILED',lease_until=NULL," +
      "processed_at=?,error_code=? WHERE tenant_id=? AND channel=? AND event_id=?"
    ).bind(
      new Date().toISOString(), code, event.tenantId, event.channel, event.eventId
    ).run();
    throw error;
  }
}

export async function claimMessagingOutbox(env, channel, limit = 20) {
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 120000).toISOString();
  const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const result = await env.DB.prepare(
    "UPDATE messaging_outbox SET status='PROCESSING',attempts=attempts+1," +
    "lease_until=?,updated_at=? WHERE action_id IN (" +
    "SELECT action_id FROM messaging_outbox WHERE channel=? AND " +
    "((status='PENDING' AND available_at<=?) OR (status='PROCESSING' AND lease_until<=?)) " +
    "ORDER BY created_at LIMIT ?) RETURNING action_id,tenant_id,channel,conversation_id," +
    "recipient_id,source_event_id,payload_json,attempts"
  ).bind(leaseUntil, now, channel, now, now, boundedLimit).all();

  return result.results || [];
}

export async function completeMessagingOutbox(env, job, providerMessageId = null) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE messaging_outbox SET status='SENT',payload_json=NULL,lease_until=NULL," +
    "provider_message_id=?,processed_at=?,updated_at=?,error_code=NULL " +
    "WHERE action_id=? AND status='PROCESSING' AND attempts=?"
  ).bind(
    providerMessageId ? clean(providerMessageId, 180) : null,
    now, now, job.action_id, Number(job.attempts)
  ).run();
  return changed(result) === 1;
}

export async function failMessagingOutbox(env, job, errorCode = "PROVIDER_SEND_FAILED") {
  const attempts = Number(job.attempts) || 1;
  const retryDelay = Math.min(3600, 15 * Math.pow(2, Math.min(8, attempts - 1)));
  const nextAt = new Date(Date.now() + retryDelay * 1000).toISOString();
  const status = attempts >= 8 ? "FAILED" : "PENDING";
  const safeCode = /^[A-Z0-9_:-]{1,80}$/.test(errorCode) ? errorCode : "PROVIDER_SEND_FAILED";
  const result = await env.DB.prepare(
    "UPDATE messaging_outbox SET status=?,available_at=?,lease_until=NULL," +
    "updated_at=?,error_code=? WHERE action_id=? AND status='PROCESSING' AND attempts=?"
  ).bind(
    status, nextAt, new Date().toISOString(), safeCode, job.action_id, attempts
  ).run();
  return changed(result) === 1;
}
