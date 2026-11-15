# Multi-tenant Readiness Gate — Seiton UMKM Workspace

Status: **Not approved for commercial multi-tenant release**  
Baseline: 15 November 2026

## 1. Current boundary

The production UMKM order workspace is a single-store deployment. It must not be represented as a SaaS product with tenant isolation. The current Owner Admin and order Worker are owner-operated systems.

The product direction is to give each UMKM buyer a separate login/owner identity and ensure tenant data is not mixed with the Seiton.id master owner account or another buyer.

## 2. Architecture decision required

Evaluate two models before implementation:

### A. Dedicated environment per customer
- Separate identity and admin credentials.
- Separate D1 database for catalogue, orders, inventory, payment ledger, and audit.
- Separate storage namespace for customer media.
- Separate configuration and secret namespace.
- Per-customer domain/routing and deployment lifecycle.
- Automated provisioning, upgrade, suspend, export, and offboarding.

Advantages: clearer data boundaries and customer-specific backup/restore.  
Costs: more resources, migrations, deployment orchestration, and support overhead.

### B. Shared application with strict tenant keys
- Every table includes a non-null tenant identifier.
- Every query and mutation is scoped by tenant from the authenticated session, never by a client-supplied tenant ID alone.
- Unique indexes include tenant ID where uniqueness is tenant-local.
- Storage object paths include a server-derived tenant namespace.
- Service credentials and provider settings are isolated per tenant.
- Cross-tenant support access uses explicit audited elevation.

Advantages: fewer deployments and simpler platform upgrades.  
Costs: every API, query, background job, webhook, cache key, export, and admin screen must enforce tenant scope.

Do not choose shared tenancy only to reduce hosting cost. Choose based on the ability to continuously test and enforce isolation.

## 3. Required identity and access model

- Each customer receives a dedicated tenant owner identity.
- Tenant login, recovery methods, admin sessions, and API credentials are separate from the Seiton master owner identity.
- Seiton support access is time-limited, least-privileged, explicit, and audited.
- Passwords, Telegram tokens, QRIS payloads, mailbox credentials, and third-party secrets are never shared between tenants.
- Offboarding revokes sessions and provider credentials, and exports customer-owned data before deletion according to contract and retention policy.

## 4. Isolation acceptance tests

The product cannot launch until all tests pass in staging with at least two synthetic tenants:

1. Tenant A cannot read, list, update, or delete Tenant B products.
2. Tenant A cannot read Tenant B orders by ID, search, export, or report filter.
3. Tenant A cannot access Tenant B payment proofs, QRIS payloads, bank settings, or receipt records.
4. Tenant A cannot alter Tenant B stock or trigger fulfillment for Tenant B.
5. A webhook with Tenant A credentials cannot create or update Tenant B data.
6. Queue/outbox retries and scheduled jobs preserve tenant identity.
7. Cache keys, R2 paths, download links, and analytics remain tenant-scoped.
8. CSV/export endpoints cannot omit tenant filters.
9. Support elevation is denied by default and leaves an immutable audit record.
10. Tenant offboarding revokes all sessions, API keys, storage access, and scheduled work.

## 5. Provisioning and commercial gates

- [ ] Customer terms define data controller/processor roles and data ownership.
- [ ] Data export format and delivery method are tested.
- [ ] Backup and tenant-specific restore are tested.
- [ ] Resource quotas and fair-use limits exist.
- [ ] Subscription, invoice, grace period, suspension, and reactivation policy are defined.
- [ ] Provider requirements (QRIS/acquirer, WhatsApp, Google, domain/email) are disclosed without promising bypasses.
- [ ] Incident response and notification responsibilities are agreed.
- [ ] Deletion and retention periods are agreed and implemented.
- [ ] At least two independent tenants pass the isolation test suite.

## 6. Release rule

Until every item is satisfied, sell only a separately scoped implementation/installation with explicit responsibility and account ownership. Do not claim the existing single-store workspace is a self-service multi-tenant SaaS.
