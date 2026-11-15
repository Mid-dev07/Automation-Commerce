# Owner Operations Runbook — Seiton.id

Snapshot: 15 November 2026  
Scope: single-owner operations, incident response, backup, restore, and reconciliation.

## 1. Daily operating routine

### Start of day
1. Open https://admin.seiton.biz.id and inspect the Owner Control Center.
2. Review service health and timestamps. Distinguish healthy, degraded, unavailable, and not verified.
3. Review QRIS/transfer claims against the actual merchant/bank transaction history.
4. Review CRM & Proyek for overdue deliverables, waiting DP, waiting customer materials, review, and final payment.
5. Review outbox health before relying on Google Sheets reports.

### End of day
1. Confirm each received payment has an order/project reference and is recorded in the correct ledger.
2. Confirm paid checkout orders have one receipt code and a known receipt delivery state.
3. Review stock exceptions, cancelled orders, refunds, and amount differences.
4. Record unresolved incidents and the next action.

### Weekly
1. Reconcile paid order totals against GoPay Merchant and bank history.
2. Compare D1 transaction counts with the Sheets mirror. D1 is authoritative; Sheets is reporting only.
3. Review failed/retried outbox work and webhook errors.
4. Review overdue projects, unpaid balances, and service availability.
5. Confirm access to the password manager and recovery methods for Cloudflare, GitHub, Google, and Telegram.

## 2. Known reconciliation item from the 15 November read-only check

At approximately 16:19 WIB on 15 November 2026, the production transaction D1 read-only check found:
- 5 rows in outbox with event_type CATALOG_MIRROR and status FAILED.
- 0 orders awaiting payment verification.
- Payment settings tables existed. QRIS was enabled; Transfer and COD were disabled. One active bank destination existed.

This is a dated snapshot, not a claim about the state after that check.

**Do not blindly reset failed mirror rows to PENDING.** First compare the authoritative product row in D1 with the exact product row in Sheets. Confirm that a retry will not append a duplicate. Preserve D1 as the source of truth. Record failed event counts before and after reconciliation.

## 3. D1 backup and point-in-time recovery

The production D1 databases inspected on 15 November report version=production, which supports D1 Time Travel. Time Travel is automatic; no manual enablement is required. Retention depends on the Cloudflare plan (documented as 7 days on Workers Free and 30 days on Workers Paid). Verify the actual account plan before relying on a specific recovery window.

Cloudflare reference: https://developers.cloudflare.com/d1/reference/time-travel/

Databases to include:
- seiton-transactions-prod
- seiton-site-content-prod
- seiton-mail-automation-prod

Before a destructive migration or manual correction:
1. Capture the current D1 bookmark for the exact database.
2. Export the database to a durable destination if retention longer than Time Travel is required.
3. Record database name/ID, timestamp (UTC), migration commit, and change owner.
4. Apply schema changes first in an isolated preview database.
5. Compare table names, indexes, triggers, row counts, and critical invariants afterward.

Example commands (run from a trusted local project with Wrangler authenticated):

```bash
npx wrangler d1 time-travel info seiton-transactions-prod
npx wrangler d1 export seiton-transactions-prod --output=backups/seiton-transactions-prod.sql
```

D1 Time Travel restore overwrites the selected database in place and cancels in-flight queries. It is a destructive recovery action, not a routine rollback. A restore requires explicit owner approval, a current bookmark/export, a maintenance window, and post-restore validation. Never test restore against the live transaction database.

For long-term exports, evaluate Cloudflare's D1 export-to-R2 Workflow: https://developers.cloudflare.com/workflows/examples/backup-d1/

## 4. R2 product media

R2 bucket seiton-product-media stores product media and must be treated as production data. The runtime audit confirms the binding exists, but this runbook does not claim that a second backup bucket or replication policy is configured.

Before calling media recovery complete:
- Inventory object count and total bytes.
- Decide a separate backup destination and retention period.
- Copy objects with keys and metadata preserved.
- Test restoring representative product images and confirm URLs/keys resolve.
- Document recovery of media references from D1.

Do not delete, rename, or overwrite production media as part of a restore test.

## 5. Secrets and access recovery

- Keep API tokens, webhook secrets, QRIS payloads, service-account JSON keys, mailbox tokens, and encryption keys in a password manager or approved secret manager.
- Never copy secret values to GitHub, issue comments, Sheets, logs, runbooks, or AI prompts.
- Maintain a second owner-controlled recovery method for email, Cloudflare, GitHub, Google, and Telegram.
- Revoke old sessions and rotate affected credentials after suspected exposure.
- A source-code rollback does not restore secrets, D1 rows, R2 objects, KV contents, or Durable Object state.

## 6. Incident thresholds and response

- Any failed SHEET_MIRROR or CATALOG_MIRROR outbox row: investigate before depending on the reporting mirror.
- A payment verification waiting more than 2 hours: inspect the merchant ledger and contact the customer if necessary.
- Telegram webhook last error or persistent pending updates: verify Telegram connectivity and Worker logs.
- Order Worker health not READY: pause checkout changes and inspect D1 readiness.
- Order is paid but QRIS ledger is not PAID, or vice versa: stop manual correction and reconcile against merchant transaction evidence.
- Receipt delivery failure: retry the notification with the same receipt code; never approve again to regenerate a code.

AI may summarize and classify an incident, but must not approve payments, issue refunds, alter QRIS flags, or change production secrets.

## 7. Restore acceptance checklist

- [ ] Database name and environment verified.
- [ ] Pre-restore bookmark/export retained.
- [ ] Restore target is isolated unless an approved incident recovery is underway.
- [ ] Schema, indexes, triggers, and migration compatibility checked.
- [ ] Order IDs, order-item counts, inventory movements, and payment ledger counts checked.
- [ ] QRIS expected-amount uniqueness and receipt/reference uniqueness checked.
- [ ] Admin login, Telegram webhook health, and checkout preview verified.
- [ ] Sheets mirror reconciled after D1 is healthy.
- [ ] R2 media references load.
- [ ] Recovery event and owner approval recorded.


## 8. Opt-in operational alerts

The code branch introduces owner notifications for:
- Failed `SHEET_MIRROR` or `CATALOG_MIRROR` outbox work.
- Payment-verification claims waiting more than two hours.

These alerts are deliberately disabled unless `OPERATIONAL_ALERTS_ENABLED=true` is explicitly configured on the order Worker. The feature also requires `migrations/0014_operational_alert_state.sql` to exist in the transaction D1 database. Do not enable the variable or deploy the migration as part of a source-only update. Run preview/UAT first and verify Telegram owner notifications. Notifications contain counts only; they do not include customer names, payment references, proof, or amounts.
