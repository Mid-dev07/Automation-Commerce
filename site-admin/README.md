# Seiton owner admin Worker

Source for the production owner pricing panel at https://admin.seiton.biz.id/.

## Bindings

- `ORDER_BACKEND`: service binding to `seiton-order-bot` production.
- `SITE_DB`: D1 database `seiton-site-content-prod`.

## Login request forwarding

The owner panel reads the edge-provided `CF-Connecting-IP` from the public request and forwards it as `CF-Connecting-IP` and `X-Real-IP` to the backend through its service binding. The backend continues to derive its own HMAC client key with its existing `TELEGRAM_WEBHOOK_SECRET` binding. No additional shared secret is required.

The owner panel fails closed if the edge-provided client IP is absent. It does not use a shared `unknown` identity.

Only an upstream HTTP 401 increments the owner panel's password-failure counter. HTTP 429 is returned with its retry interval. Upstream 5xx or malformed responses return HTTP 503 and do not consume password-failure attempts.

## Deployment

Deploy with:

```sh
npx wrangler deploy --config site-admin/wrangler.jsonc
```

Then verify that the `seiton-site-admin` custom domain / DNS Worker association remains attached to `admin.seiton.biz.id`.
