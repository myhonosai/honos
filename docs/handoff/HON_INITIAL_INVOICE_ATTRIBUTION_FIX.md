# Initial invoice attribution — review handoff

Owner-authorized follow-up to the NULL organization on `invoice.paid` recorded in [the original sandbox evidence](../evidence/stripe-sandbox/2026-10-19-core-monthly.md). Base: main `15631abddb494c81c5f004e9d8a5a7de553384ae`. No new real Stripe run, live payment, production database access, deployment or activation is part of this change.

## Change and authority

Migration **0173** replaces only `hon.ingest_saas_provider_event(jsonb,text)` through the trusted migration-owner path. **0158 is unchanged**; **0172 is reserved for Claude's unmerged PR #38**. The existing signature, SECURITY DEFINER/search path, owner and function-only runtime ACL remain. There are no new tables, routes, permissions, contracts, tenant selectors or entitlement transitions. No financial calculation, checkout activation helper, CRM, frontend, provider adapter or webhook signature code changes.

The initial invoice lookup uses only the configured provider and the server-bound Stripe subscription reference. Previously a missing lookup still finalized `ALREADY_APPLIED / FIRST_INVOICE_COVERED_BY_CHECKOUT`, with NULL organization/checkout/subscription and a permanently completed idempotency receipt.

Now a missing binding with pending CREATED/OPEN checkouts raises the existing `SAAS_PROVIDER_EVENT_NOT_READY` (55006). The API already returns 503; the transaction rolls back the event, request claim, audit/outbox and any writes. Stripe redelivery or a later explicit recovery can then record the fully attributed event after checkout completion commits. No automatic retry or provider call is added.

The pending check deliberately mirrors the existing renewal path: any open checkout for that provider is only a conservative reason to defer, never proof that an event belongs to its organization. With no possible pending checkout, an unknown subscription is `NEEDS_REVIEW / UNKNOWN_PROVIDER_SUBSCRIPTION`. An incomplete non-open mapping or missing matching provider-verified payment evidence is also reviewable. A covered invoice requires a completed checkout and payment evidence bound to the same invoice, organization, subscription, provider and TEST mode. It links references to that existing payment and never creates another payment.

## Regression verification

The existing CI already runs the extended B5 disposable PostgreSQL proof and API tests; no new workflow or provider secrets are needed. The proof includes:

- Checkout-first delivery: correct organization/checkout/subscription in event, saved receipt, audit and inert outbox; no duplicate payment.
- Invoice-first delivery: HTTP 503, zero committed event/request/audit/outbox, no early activation, then successful attributed retry.
- Concurrent invoice and checkout deliveries: either the committed mapping is visible or the invoice retries safely.
- Replayed and conflicting deliveries; distinct event IDs for the same covered invoice cannot duplicate accounting.
- Same-second newest-first Events API recovery: first pass defers, an explicit second pass attributes the event, later webhook/recovery replays safely.
- Injected failure after reference linking: references and receipt roll back; the identical delivery succeeds after the disposable fault is removed.
- Genuinely unknown subscription with another school's metadata: no guessed scope or reference link, visible review state.
- Existing cross-tenant/provider, purchaser permissions, RLS/ACL, refund-by-invoice linkage, financial guards and unchanged entitlement/CRM/Champions snapshots remain asserted.

The API regression uses a signed synthetic endive-shaped invoice to verify 503 followed by a successful explicit retry with the identical normalized event/digest. The sandbox harness now allows one explicit recovery dependency pass before asserting correct initial-invoice attribution; subsequent recovery still must leave counts unchanged. The harness is not executed by this change or by CI.

Final source SHA, CI links and actual results belong in the review PR. Local syntax/diff checks are distinct from full database verification; no result is claimed until its job passes.

## Coordination and remaining limits

PR #38 is read-only inspected and untouched. Its 0172 replaces `saas_activate_checkout`, not ingestion, so 0173 preserves that helper call and can follow 0172 without overwriting B6A. Its existing invoice-before-checkout test must adopt the new retry expectation when Claude synchronizes that branch; do not restore unattributed success to satisfy that old assertion. Re-run both sets of proofs after either branch is integrated. This PR does not enable B6A or implement its contracts.

Historical NULL-attribution provider events, completed receipts, audit and outbox are append-only and are **not backfilled**. Ordinary replay cannot repair them; any historical reporting/reconciliation work requires separate owner approval. Do not delete receipts, rewrite event bodies, disable guards or manufacture new event IDs to repair history. The original sandbox evidence remains unchanged and accurately describes the old behavior.

A genuinely unknown event may receive a transient retry while an unrelated checkout for the same provider is open. This conservative behavior already exists for renewals and is disclosed rather than assigning a tenant. Recovery is bounded and explicit. Full real-Stripe webhook forwarding and broader Stripe-version/payment-link compatibility remain separate work; this fix makes no new provider verification claim.
