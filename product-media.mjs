export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
export const PRODUCT_MEDIA_PREFIX = "products/";

const MIME_BY_EXTENSION = Object.freeze({
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
});

const PRODUCT_MEDIA_KEY =
  /^products\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Data gambar harus berupa bytes.");
}

function startsWith(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function inspectProductImage(value, declaredMime = "") {
  const bytes = asBytes(value);
  if (!bytes.length) throw new Error("File gambar kosong.");
  if (bytes.byteLength > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("Ukuran gambar produk maksimal 5 MB.");
  }

  let extension = "";
  if (
    bytes.length >= 3 &&
    startsWith(bytes, [0xff, 0xd8, 0xff])
  ) {
    extension = "jpg";
  } else if (
    bytes.length >= 8 &&
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    extension = "png";
  } else if (
    bytes.length >= 16 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(ascii(bytes, 12, 4))
  ) {
    extension = "webp";
  } else {
    throw new Error("Signature gambar tidak valid. Gunakan JPEG, PNG, atau WebP.");
  }

  const contentType = MIME_BY_EXTENSION[extension];
  const declared = String(declaredMime || "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== contentType) {
    throw new Error("Tipe file tidak sesuai dengan signature gambar.");
  }

  return { extension, contentType, size: bytes.byteLength };
}

export function isProductMediaKey(value) {
  return PRODUCT_MEDIA_KEY.test(String(value || ""));
}

export function productMediaPublicUrl(value, origin = "https://automate-bot.seiton.biz.id") {
  const key = String(value || "");
  if (isProductMediaKey(key)) {
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    return new URL("/media/" + encoded, origin).toString();
  }
  if (/^https:\/\//i.test(key)) return key;
  return "";
}

export async function storeProductImage(bucket, value, declaredMime = "", source = "admin") {
  if (!bucket || typeof bucket.put !== "function") {
    throw new Error("Binding R2 PRODUCT_MEDIA belum tersedia.");
  }
  const bytes = asBytes(value);
  const image = inspectProductImage(bytes, declaredMime);
  const key = PRODUCT_MEDIA_PREFIX + crypto.randomUUID() + "." + image.extension;
  const stored = await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: image.contentType,
      cacheControl: "public, max-age=31536000, immutable"
    },
    customMetadata: {
      purpose: "product-image",
      source: source === "telegram" ? "telegram" : "admin"
    }
  });
  if (!stored) throw new Error("R2 tidak mengonfirmasi penyimpanan gambar.");
  return { key, contentType: image.contentType, size: image.size, etag: stored.httpEtag || stored.etag || "" };
}

export async function uploadThenPersistProductImage(bucket, value, declaredMime, source, persist) {
  if (typeof persist !== "function") throw new TypeError("Fungsi penyimpanan metadata produk wajib tersedia.");
  const uploaded = await storeProductImage(bucket,value,declaredMime,source);
  try {
    const result = await persist(uploaded.key);
    return { uploaded, result };
  } catch (error) {
    try {
      await deleteProductMediaObject(bucket,uploaded.key);
    } catch (cleanupError) {
      console.warn(JSON.stringify({
        level:"warn",
        event:"product_media_orphan_cleanup_deferred",
        key:uploaded.key,
        message:String(cleanupError?.message||cleanupError).slice(0,240)
      }));
    }
    throw error;
  }
}

export async function deleteProductMediaObject(bucket, key) {
  if (!isProductMediaKey(key)) return false;
  if (!bucket || typeof bucket.delete !== "function") {
    throw new Error("Binding R2 PRODUCT_MEDIA belum tersedia.");
  }
  await bucket.delete(key);
  return true;
}

export async function serveProductMedia(request, bucket, key) {
  if (!isProductMediaKey(key)) {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" }
    });
  }
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.head !== "function") {
    return new Response("Media storage unavailable", { status: 503 });
  }

  let object;
  try {
    object = request.method === "HEAD"
      ? await bucket.head(key)
      : await bucket.get(key);
  } catch {
    return new Response("Media storage unavailable", { status: 503 });
  }
  if (!object) return new Response("Not Found", { status: 404 });

  const contentType = String(object.httpMetadata?.contentType || "").toLowerCase();
  if (!Object.values(MIME_BY_EXTENSION).includes(contentType)) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  if (Number.isSafeInteger(Number(object.size))) {
    headers.set("Content-Length", String(Number(object.size)));
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  if (!object.body) {
    return new Response("Precondition Failed", { status: 412, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
