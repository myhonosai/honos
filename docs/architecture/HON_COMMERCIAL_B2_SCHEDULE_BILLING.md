# Commercial B2 — Schedule Binding and Verified Billing Evidence

**Status:** Owner-authorized implementation planning and draft-slice scope. This document authorizes no live provider operation, paid checkout, charge, refund execution, paid-access activation, trial conversion, deployment, or customer-data action.

**Branch:** `manus/commercial-b2-a2p-0191`<br>
**Base:** `codex/a2p-1-backend` / PR #82 head `e35754188a618167305696a3e021fcc629f4fc3b` (unmodified dependency base)<br>
**Migration coordination:** PR #82 / PR #83 retain the physical `0190_a2p_registration_preparation.sql` claim. PR #88 also currently has a physical `0191` migration. The owner-proposed allocation is #82 `0190`, #88 `0191`, and #90 `0192`, but no allocation change is approved yet: this dependent B2 draft retains its current `0191` filename and refuses to apply unless the `0190_a2p_registration_preparation.sql` ledger record already exists. After allocation approval and #82 landing, the separately authorized renumber/rebase/revalidation step must use canonical main before any merge.

## 1. Scope and reuse

This is a new **Commercial B2** slice. The older merged PR #15 named “B2” remains the reusable generic HON invoice and payment-evidence foundation. This slice must extend it; it must not replace or duplicate its invoice numbering, immutable evidence, provider-event safety, RLS, audit, or reconciliation patterns.

Commercial B2 starts from one immutable B1 `saas_subscription_generations` record. That record already pins the accepted A2 organization, school, disclosure, initial amount, renewal amount, billing interval, and `DISTINCT_VERIFIED_PAID_PERIODS` rule. The B2 slice will add a schedule-binding lifecycle and append-only verified-period/reconciliation evidence. It will not rewrite a generation, A2 acceptance, legacy subscription, legacy checkout, historical invoice, or historical payment evidence.

The legacy B5 Checkout/Stripe test-mode surface is also reusable only as a security and event-reconciliation precedent. Its checkout/invoice/subscription rows encode a single accepted price and legacy period semantics. They cannot become the authoritative schedule-B2 period ledger.

## 2. Required behavior

A binding may be established only after the server rederives the complete immutable generation and accepted terms. It must prove the exact organization/school, provider mode, account reference, subscription reference, schedule reference, accepted initial/renewal amount, interval, disclosure, and generation/acceptance/schedule digests.

The binding and evidence model must enforce one live HON subscription lifecycle per eligible organization. Existing HON OS/legacy checkout or subscription, B6A awaiting-payment/access state, and applicable exception lifecycle remain conflict inputs. All participants must serialize through the same organization-scoped coordination boundary and recheck their conflict set after waits.

A qualifying period is a distinct, authenticated, non-overlapping covered period with immutable matching payment evidence. A provider event, browser redirect, subscription identifier, invoice count, elapsed calendar time, free period, or failed/pending/unknown attempt is not a qualifying period by itself.

The required schedule logic is:

- Regular monthly: exact accepted monthly amount for every qualified period.
- Regular annual: exact accepted annual amount for every qualified period.
- Founder monthly: the accepted introductory amount applies to twelve **qualifying paid monthly periods**, then the accepted renewal amount may be considered only through the provider-gated release/reconciliation path.
- Founder annual: one qualifying paid annual period is required before the accepted renewal amount may be considered.

Founder acceptance/binding/release remains refused until Commercial C supplies durable founder allocation and promotion-history authority. Tests in this slice must demonstrate that refusal instead of fabricating allocation, inventory, promotion reuse, or an annual-founder success path.

## 3. Provider boundary

Stripe subscription schedules define time-based phases. Stripe documents that phase transitions occur automatically at a phase end date, while the HON commitment requires a transition only after verified qualifying paid periods. A calendar-only Stripe schedule therefore cannot satisfy the B2 contract.

For this slice, the only executable adapter is an explicitly injected deterministic `STRIPE_SIMULATED` test fake. It must be TEST-only, require an idempotent binding key, return the same binding on exact recovery, and never create a checkout, collect a payment, issue an invoice, advance a clock-driven phase, or perform network I/O.

The production default remains `UnconfiguredSubscriptionScheduleProvider`. A real Stripe test-mode schedule adapter is deliberately out of scope until a separate sandbox authorization proves that the provider mechanism can enforce the verified-paid-period gate without automatic calendar repricing or collection. Native calendar phase observations, automatic collection, live credentials/events, unsupported event versions, unknown provider outcomes, and schedule/account/subscription mismatches fail closed.

Provider invocation must never occur inside a database transaction. The server first commits a binding intent and its exact idempotency identity. A fresh intent may call `bindOrFindSchedule` outside locks, then records a signed, immutable observation in a second transaction. A repeated human command whose original receipt is still `PENDING_PROVIDER_BINDING` makes **no** second adapter call: it fails closed as reconciliation-required while returning no invented success. Once the observation is durable, the same command returns the stored `BOUND_TEST_ONLY` receipt without provider I/O. A future privileged reconciliation worker, not the human retry route, would have to prove an uncertain provider result using the original binding key before recording one observation; it may never create a second binding, payment, transition, checkout, or entitlement effect.

## 4. Proposed additive database boundary

The draft `0191` migration will be additive and will leave migrations `0155`, `0158`, `0172`, `0173`, and `0181`–`0189` byte-identical.

It should add private, FORCE-RLS append-only records for:

1. A one-to-one generation schedule binding, including the immutable accepted-term snapshot, TEST-only provider references, binding key/digest, lifecycle/review status, and organization-level live-lifecycle uniqueness.
2. Signature-authenticated provider-event observations with provider/event identity, canonical digest uniqueness, and a semantically parsed, bounded `provider_occurred_at` timestamp kept separately from local receipt time.
3. Schedule invoice/covered-period evidence with exact amount, currency, phase, provider invoice reference, and canonical period uniqueness.
4. Payment, refund, and dispute facts linked to the original bound schedule/invoice/payment evidence.
5. Reconciliation decisions that are immutable and explicitly distinguish applied, retryable-not-ready, unknown, and review-required outcomes.

Every table must deny direct runtime DML, force RLS, use immutable/no-truncate guards, constrain closed values, and be protected by deferred lineage/authority/audit/outbox verification. Only narrowly granted `SECURITY DEFINER` functions may create or read records. Provider identities must not become tenant authority; the binding itself supplies the only historical organization/school scope.

The human binding path follows the B1 lock safety posture: complete IAM authority locking with `NOWAIT`, request claim, offer validity recheck, and organization lifecycle coordination. The provider-ingestion path has no human authority and must not acquire B6A entitlement, founder-inventory, or broad IAM locks. It validates the configured TEST provider, claims the event, locks the bound schedule and evidence keys in a fixed order, then atomically writes its evidence/reconciliation result.

## 5. Reconciliation and no-effect rules

A duplicate provider event with the same digest returns the original receipt. The same provider event identity with a different digest is an immutable conflict. A late covered period that would precede an already recorded qualifying period is preserved as `NEEDS_REVIEW` with no count change; the system does not infer reordered pricing history. Missing predecessor binding or evidence is retryable and rolls back the claim so an authenticated redelivery can apply it later.

Failed, pending, unknown, mismatched, duplicate-covered-period, cancelled, reversed, refunded, disputed, or unlinked evidence cannot release a phase, increment a qualifying-period count, restore a promotion, issue a fresh schedule, activate paid access, mutate an entitlement, grant capabilities or AI credits, or execute a provider refund. It is preserved as immutable evidence with `NEEDS_REVIEW` or reconciliation-required status.

Refund/dispute/reversal impact on prior qualifying periods, cancellation timing, grace behavior, resubscription promotion reuse, and founder capacity disposition are intentionally unresolved owner policies. B2 records the evidence and holds the affected transition; it does not infer a policy or silently change counted-period history.

## 6. Required proofs

The B2 draft must add a dedicated disposable PostgreSQL integrity proof and preserve the complete legacy suite. The proof must cover exact initial/renewal amounts, regular monthly/annual behavior, founder refusal pending Commercial C, twelve qualifying monthly periods before a founder transition, annual founder gating, failed/pending/unknown outcomes, semantic invalid/future timestamp refusal, duplicate and out-of-order events, refund/dispute/reversal evidence, cancellation/renewal races, cross-organization authorization, restricted runtime direct-DML denial, rollback, exact-key recovery, RLS/ACL/trigger enforcement, and unchanged B6A INACTIVE posture.

It must be registered in the SaaS security inventory, commercial staging fixture/safety/manifest chain, full database-proof runner, and PR CI path filters. No historical migration checksum may change. The isolated commercial fixture must finish with no B2 rows, provider program disabled, paid access inactive, no entitlement/capability/credit effects, and no network/provider operation.

## 7. Separate gates and owner decisions

Commercial C remains the only future authority for founder allocation, promotion history, anti-reuse, concurrent capacity, and review disposition. D11-B remains the only future trial/signup/conversion authority. B6A remains inactive, and B6B owns later grace, suspension, cancellation, refund, and dispute access effects.

Before a real Stripe sandbox or any payable flow, the owner must separately authorize a restricted non-live Stripe account, test-only credentials, test webhook endpoint/signing secret, egress, supported endpoint API version, isolated provider data, and an end-to-end sandbox reconciliation proof. Those requirements do not authorize a live mode, customer charge, refund execution, deployment, or paid-access activation.

The owner still needs to decide the effect of partial/full refund, dispute, reversal, reinstatement, cancellation, and resubscription on qualifying periods, release eligibility, founder/promotion reuse, and review capacity. Until then every affected transition remains blocked for review.

## 8. References

- [Commercial A2 immutable pricing acceptance](HON_COMMERCIAL_A2_PRICING_ACCEPTANCE.md)
- [Commercial B1 provider schedule foundation](HON_COMMERCIAL_B1_PROVIDER_SCHEDULES.md)
- [Launch pricing and trial conversion dependency map](HON_LAUNCH_PRICING_AND_TRIAL_CONVERSION.md)
- [B6A inactive paid-access boundary](HON_PAID_ACCESS_B6A.md)
- [Stripe Subscription Schedules API](https://docs.stripe.com/api/subscription_schedules)
- [Stripe subscription schedule phases](https://docs.stripe.com/billing/subscriptions/subscription-schedules)
- [Stripe subscription webhook events](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe webhook delivery behavior](https://docs.stripe.com/webhooks)
