# Phase 4 — Wrangler configuration consolidation

Date: 2026-11-09  
Status: GitHub regression CI passed; awaiting owner review.

Latest verified CI run: `42618895591` — worker/cart regression **91/91 passed**, Messaging Core **26/26 passed**.

## 1. Goal

Make the root Worker configuration deterministic and reviewable by keeping one canonical Wrangler file. The repository previously contained both `wrangler.jsonc` and a partial `wrangler.toml`. The TOML file did not declare the D1, Durable Object, or R2 resources that are required by the Worker runtime.

Cloudflare supports both TOML and JSON/JSONC configuration formats and recommends JSONC for new projects. The repository now uses `wrangler.jsonc` as its sole root Worker configuration.

Reference: https://developers.cloudflare.com/workers/wrangler/configuration/

## 2. Changes

- Kept `wrangler.jsonc` as the only root Wrangler configuration.
- Removed the incomplete duplicate `wrangler.toml`.
- Moved the existing non-secret `GOOGLE_SHEETS_ID` variable into the canonical JSONC `vars` object without changing its value.
- Set the D1 binding's `migrations_dir` explicitly to `migrations`.
- Preserved the existing Worker name/entry point, production D1 binding, `PRODUCT_MEDIA` R2 binding, `ORDER_COORDINATOR` Durable Object, cron schedule, observability settings, and admin rate limiter.
- Added `tests/wrangler-config-contract.test.cjs` to check the canonical file, required bindings, migration directory, and retained non-secret variable without printing its value.
- Updated the cart regression workflow so changes to either Wrangler filename, the Phase 4 report, or tests trigger the regression suite.

## 3. Migration inventory and constraints

The backend branch contains:

- `migrations/0001_transaction_core.sql`
- `migrations/0002_multi_item_cart.sql`
- `migrations/0004_messaging_core.sql`
- `migrations/0005_messaging_handoff_audit.sql`
- `migrations/0006_messaging_handoff_resolution.sql`
- `migrations/0007_admin_login_security.sql`
- `migrations/0008_admin_web_sessions.sql`
- `migrations/0009_admin_activity_audit.sql`

There is no tracked `0003` migration in the audited repository state. This phase does not invent a missing migration, renumber existing files, or change SQL migration contents. The reason for the numbering gap remains unverified.

The production schema inspection previously confirmed that cart-related tables and triggers exist. It did **not** establish the contents of the production `d1_migrations` ledger or prove which repository migration files were applied. The existence of schema objects is not a substitute for migration-ledger evidence.

Cloudflare D1 records applied migrations in its migrations table. The next controlled verification should inspect the ledger using a read-only migration-list operation against a deliberately selected database. Do not run `wrangler d1 migrations apply` against production as part of this phase.

Reference: https://developers.cloudflare.com/d1/reference/migrations/

## 4. Safety and rollout status

- No Worker deployment or Wrangler deploy/dry-run command was executed.
- No Cloudflare resource or live binding was changed.
- No remote D1 migration list/apply command was executed from this phase.
- No D1 production rows or migration ledger were read or written in this phase.
- No secret values were read, added to the repository, or modified.
- The JSONC config still identifies the existing production D1 resource. No preview D1 ID was fabricated or substituted. A preview must use a separately provisioned and verified isolated database and bucket before any runtime smoke test.
- The feature branch is stacked on Phase 3. Keep it unmerged until the preceding Phase 3 branch has been reviewed and the owner approves the complete dependency chain.

## 5. Verification

The new contract test parses `wrangler.jsonc` as JSON and checks the required source configuration. The GitHub regression workflow also runs:

- JavaScript syntax checks for the Worker modules.
- `node --test tests/*.test.cjs`.
- `node --test tests/messaging-core.test.mjs`.

This static/CI coverage does not prove that Wrangler can deploy the Worker or that a Cloudflare preview runtime is healthy. A separate isolated preview smoke test and independent production release approval remain required.
