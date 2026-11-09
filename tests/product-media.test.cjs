const test = require("node:test");
const assert = require("node:assert/strict");

let media;
test.before(async () => {
  media = await import("../product-media.mjs");
});

function jpegBytes() {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}
function pngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}
function webpBytes() {
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x08, 0, 0, 0,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
  ]);
}

function createBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes, options) {
      const body = Uint8Array.from(bytes);
      const object = {
        key,
        size: body.length,
        body,
        options,
        httpEtag: '"etag-test"',
        httpMetadata: options.httpMetadata,
        writeHttpMetadata(headers) {
          headers.set("Content-Type", this.httpMetadata.contentType);
          headers.set("Cache-Control", this.httpMetadata.cacheControl);
        }
      };
      objects.set(key, object);
      return object;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        ...object,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(object.body);
            controller.close();
          }
        })
      };
    },
    async head(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { ...object, body: undefined };
    },
    async delete(key) {
      objects.delete(key);
    }
  };
}

test("detects JPEG, PNG and WebP from bytes rather than filenames", () => {
  assert.deepEqual(media.inspectProductImage(jpegBytes()), {
    extension: "jpg", contentType: "image/jpeg", size: 6
  });
  assert.equal(media.inspectProductImage(pngBytes()).contentType, "image/png");
  assert.equal(media.inspectProductImage(webpBytes()).contentType, "image/webp");
});

test("rejects forged MIME types, malformed signatures, and oversized uploads", () => {
  assert.throws(
    () => media.inspectProductImage(jpegBytes(), "image/png"),
    /signature/
  );
  assert.throws(
    () => media.inspectProductImage(new Uint8Array([0, 1, 2, 3])),
    /signature/
  );
  assert.throws(
    () => media.inspectProductImage(new Uint8Array(media.MAX_PRODUCT_IMAGE_BYTES + 1)),
    /maksimal 5 MB/
  );
});

test("stores generated opaque keys and server-controlled HTTP metadata", async () => {
  const bucket = createBucket();
  const result = await media.storeProductImage(bucket, jpegBytes(), "image/jpeg", "telegram");
  assert.match(result.key, /^products\/[0-9a-f-]{36}\.jpg$/i);
  assert.equal(result.contentType, "image/jpeg");
  assert.equal(result.size, jpegBytes().length);
  assert.equal(bucket.objects.get(result.key).options.httpMetadata.cacheControl,
    "public, max-age=31536000, immutable");
  assert.deepEqual(bucket.objects.get(result.key).options.customMetadata, {
    purpose: "product-image",
    source: "telegram"
  });
  assert.equal(bucket.objects.get(result.key).options.httpMetadata.contentType, "image/jpeg");
});

test("does not trust or retain the uploader's filename", async () => {
  const bucket = createBucket();
  const result = await media.storeProductImage(bucket, pngBytes(), "image/png", "admin");
  assert.doesNotMatch(result.key, /filename|\\.exe|\\.png\\.exe/i);
  assert.match(result.key, /^products\/[0-9a-f-]{36}\.png$/i);
});

test("recognizes only generated product media keys and constructs a safe display URL", async () => {
  const key = "products/550e8400-e29b-41d4-a716-446655440000.webp";
  assert.equal(media.isProductMediaKey(key), true);
  assert.equal(media.isProductMediaKey("../private/object.webp"), false);
  assert.equal(media.isProductMediaKey("other/550e8400-e29b-41d4-a716-446655440000.webp"), false);
  assert.equal(
    media.productMediaPublicUrl(key, "https://automate-bot.seiton.biz.id"),
    "https://automate-bot.seiton.biz.id/media/products/550e8400-e29b-41d4-a716-446655440000.webp"
  );
  assert.equal(
    media.productMediaPublicUrl("https://images.example/product.jpg"),
    "https://images.example/product.jpg"
  );
  assert.equal(media.productMediaPublicUrl(""), "");
});

test("serves public product images with immutable cache and nosniff headers", async () => {
  const bucket = createBucket();
  const uploaded = await media.storeProductImage(bucket, pngBytes(), "image/png");
  const request = new Request("https://automate-bot.seiton.biz.id/media/" + uploaded.key);
  const response = await media.serveProductMedia(request, bucket, uploaded.key);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("etag"), '"etag-test"');
  assert.equal((await response.arrayBuffer()).byteLength, pngBytes().length);
});

test("media serving rejects invalid paths, missing objects and unsupported methods", async () => {
  const bucket = createBucket();
  const invalid = await media.serveProductMedia(
    new Request("https://example.test/media/../../secret"),
    bucket,
    "../../secret"
  );
  assert.equal(invalid.status, 404);

  const missingKey = "products/550e8400-e29b-41d4-a716-446655440000.jpg";
  const missing = await media.serveProductMedia(
    new Request("https://example.test/media/" + missingKey),
    bucket,
    missingKey
  );
  assert.equal(missing.status, 404);

  const post = await media.serveProductMedia(
    new Request("https://example.test/media/" + missingKey, { method: "POST" }),
    bucket,
    missingKey
  );
  assert.equal(post.status, 405);
});

test("HEAD returns metadata without an image body", async () => {
  const bucket = createBucket();
  const uploaded = await media.storeProductImage(bucket, webpBytes(), "image/webp");
  const response = await media.serveProductMedia(
    new Request("https://example.test/media/" + uploaded.key, { method: "HEAD" }),
    bucket,
    uploaded.key
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(await response.text(), "");
});

test("deletion helper accepts only generated product image keys", async () => {
  const bucket = createBucket();
  const uploaded = await media.storeProductImage(bucket, jpegBytes(), "image/jpeg");
  assert.equal(await media.deleteProductMediaObject(bucket, "https://remote.example/file.jpg"), false);
  assert.equal(await media.deleteProductMediaObject(bucket, uploaded.key), true);
  assert.equal(bucket.objects.has(uploaded.key), false);
});

test("deletes the newly uploaded object when persisting product metadata fails", async () => {
  const bucket = createBucket();
  await assert.rejects(
    media.uploadThenPersistProductImage(
      bucket,jpegBytes(),"image/jpeg","admin",
      async () => { throw new Error("D1 write failed"); }
    ),
    /D1 write failed/
  );
  assert.equal(bucket.objects.size,0);
});

test("keeps the newly uploaded object when product metadata persistence succeeds", async () => {
  const bucket = createBucket();
  const outcome = await media.uploadThenPersistProductImage(
    bucket,pngBytes(),"image/png","telegram",
    async key => ({savedKey:key})
  );
  assert.equal(outcome.result.savedKey,outcome.uploaded.key);
  assert.equal(bucket.objects.has(outcome.uploaded.key),true);
});
