# Phase 3 — R2 product media

Date: 2026-11-09  
Status: implementation on a feature branch; awaiting GitHub CI and owner review.

## 1. Storage contract

The verified Worker binding is named `PRODUCT_MEDIA` and points to the `seiton-product-media` bucket. The repository's root Wrangler config now declares that binding for local/preview/release configuration. This is a source-code change only; it does not mutate the production Cloudflare setting.

Product image object keys use this generated format:

```
products/<uuid-v4>.(jpg|png|webp)
```

The uploader's filename is never used. The image object key is stored in `catalog_products.photo_url` in D1. Google Sheets remains a reporting mirror and receives an empty `foto_url` cell for R2-backed images, so R2 object keys are not copied there. Existing HTTPS photo URLs remain supported.

The dashboard API creates a separate display URL, with a `photo_r2` boolean that tells the product editor whether the URL represents an R2 object key. The Telegram catalog uses the same Worker media route.

## 2. Validation and upload limits

`product-media.mjs` validates the bytes, rather than trusting the filename or MIME header:

- JPEG: `FF D8 FF`
- PNG: standard 8-byte PNG signature
- WebP: `RIFF` + `WEBP` and a recognized `VP8 `, `VP8L`, or `VP8X` chunk

The maximum file size is 5 MiB (5 × 1024 × 1024 bytes). A non-empty declared MIME type must match the detected signature. Only JPEG, PNG, and WebP are accepted.

Telegram downloads use `getFile`, reject unsafe file paths and stream at most 5 MiB into memory. Admin dashboard uploads use authenticated multipart form data and the same signature validator.

## 3. Save ordering and failure behavior

Both Telegram and web admin paths follow the same sequence:

1. Verify admin identity and require the D1 transaction store to be READY.
2. Validate the file and upload it to R2 under a generated key.
3. Save the new key to D1 with the existing product metadata.
4. Only after D1 commits, attempt to delete the previous R2 object.
5. If D1 persistence fails, attempt to delete the newly uploaded R2 object and preserve the old D1 photo reference.

The shared `uploadThenPersistProductImage()` helper tests the critical mid-failure path. Cleanup failures are logged without leaking credentials or file contents; the scheduled orphan collector provides a second cleanup attempt.

Post-commit readback and Google Sheets mirroring are best-effort. A reporting read/mirror failure cannot turn an already-committed D1 write into an apparent failed save that deletes the newly committed image.

## 4. Image delivery

The Worker serves `GET` and `HEAD` requests from `/media/products/<uuid>.<ext>`. Only generated product media keys are accepted. Responses use the stored image content type and these headers:

- `Cache-Control: public, max-age=31536000, immutable`
- `X-Content-Type-Options: nosniff`
- `Content-Disposition: inline`
- `Referrer-Policy: no-referrer`
- `ETag` when returned by R2

Keys are immutable and random; replacing a product image creates a new key and updates D1 before the previous object is removed. Existing external HTTPS URLs remain displayed as before.

## 5. Orphan object cleanup

The existing five-minute scheduled Worker performs a bounded collector pass only when D1 is READY and the R2 binding exists.

- It lists only the `products/` prefix.
- It scans at most two pages (100 objects/page) per scheduled invocation.
- It skips objects newer than one hour.
- It queries D1 references by exact object key and deletes only unreferenced generated product media keys.
- The continuation cursor is stored in the existing `app_meta` table; no schema migration is introduced.

An object that is uploaded but not committed to D1 is therefore not deleted immediately by the sweeper, allowing the save path time to complete. Immediate cleanup is attempted first.

## 6. User-facing integrations

### Telegram admin

The admin catalog item now has an `Upload Foto` action. The admin replies to the bot's prompt with a photo or a JPEG/PNG/WebP document. The bot confirms success only after the R2 upload and D1 update have completed.

The legacy product text form still supports external HTTPS URLs. For an R2-backed image it displays `__KEEP__` so editing name/price/stock does not accidentally overwrite the stored key. `__REMOVE__` removes the image. New image uploads use the dedicated upload action.

### Web admin panel

The product editor now accepts a JPEG/PNG/WebP file and posts multipart data to the authenticated `/api/admin/products/photo` endpoint. Existing R2 images show a preview. An optional checkbox removes the current image; leaving the photo field unchanged preserves an R2 image.

## 7. Tests and verification scope

The new `tests/product-media.test.cjs` covers:

- JPEG, PNG, and WebP signature recognition.
- MIME/signature mismatch, malformed data, and size limit rejection.
- Random key generation, metadata, and ignoring uploader filenames.
- Public URL creation and key validation.
- GET/HEAD media delivery, missing objects, invalid keys, wrong methods, and cache/security headers.
- Successful persistence and cleanup of a newly uploaded object when metadata persistence fails.

Worker and transaction contract tests cover R2 binding configuration, upload authorization/routes, Telegram integration, R2 display URLs, D1 key validation, the Sheets mirror key exclusion, and the scheduled orphan collector.

A successful test suite does not replace a preview smoke test against an isolated R2 bucket and a test D1 database. The project has not yet exercised a real Cloudflare R2 binding in a deployed preview runtime.

## 8. Production safety and rollout gate

No Worker deployment was performed. No live bucket configuration or access policy was modified. No remote D1 migration or production data update was run, and no secrets were read or changed.

Before release, review the PR, confirm the production `PRODUCT_MEDIA` binding still points to `seiton-product-media`, run an isolated preview with test products, verify browser image loading and Telegram photo sending, and then request a separate production deployment approval.
