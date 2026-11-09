# Seiton owner admin Worker

Source for the production owner pricing panel at https://admin.seiton.biz.id/.

## Bindings

- `ORDER_BACKEND`: service binding to `seiton-order-bot` production.
- `SITE_DB`: D1 database `seiton-site-content-prod`.

## Required secret

Set `SITE_ADMIN_LOGIN_SHARED_SECRET` as a Worker secret in **both** `seiton-site-admin` and `seiton-order-bot`. The same random value must be used on each Worker. Do not put the secret in this repository or in frontend code.

The panel signs a pseudonymous client identifier with HMAC-SHA-256. The backend verifies the signature before using the client key for rate limiting. This avoids depending on `CF-Connecting-IP` being forwarded through an internal service binding.

## Login failure semantics

Only an upstream HTTP 401 increments the owner panel's password-failure counter. HTTP 429 is returned with its retry interval. Upstream 5xx or malformed responses return HTTP 503 and do not consume password-failure attempts.

## Deployment

Deploy with:

```sh
npx wrangler deploy --config site-admin/wrangler.jsonc
```

Then verify that the `seiton-site-admin` custom domain / DNS Worker association remains attached to `admin.seiton.biz.id`.
