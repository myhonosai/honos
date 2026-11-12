# HON OS schedule billing — piece 2 (migration 0235): access after the first verified payment

Piece 2 of the owner's five-piece paid-activation plan (2026-11-09). It replaces the piece-1 stub access hook
(`hon.saas_schedule_after_paid_period`, 0230) with the real access switch-on. It depends on piece 1 (0230) and is not
deployed. The paid-access program stays **INACTIVE** (0170 CHECK), so in the shipped posture every first payment is
recorded and lands in HQ access review. Turning the program on needs a separate owner-approved migration.

## Owner decisions this piece implements

| Decision | How |
| --- | --- |
| Billing and access are separate outcomes; a failed switch-on keeps the payment, goes to HQ review, no auto-refund | The hook never raises for a business refusal. It writes a `NEEDS_REVIEW` access transition with a reason. An unexpected error is rolled back to its own savepoint and recorded as `ACCESS_ACTIVATION_ERROR`. The 0230 ingest already isolates the whole hook (`ACCESS_HOOK_FAILED`). |
| Failed payment: 7 days of full access, then read-only | Access is a time window on the one access authority, `organization_entitlements`: paid period end + 7 days (`hon.saas_schedule_access_grace()`). With no renewal it lapses by time (no job). The read-only state itself needs the `PAST_DUE_SUSPENSION` writer (0192), which is a follow-up. |
| Locked founder price, founder spots | Not active here. A founder binding is refused with `FOUNDER_UNAVAILABLE` until piece 4 (founder generations are already refused by 0189). |
| AI team included, creative credits separate | No AI or creative credits are granted. The creative wallet stays INACTIVE and is keyed on v1 subscriptions (follow-up). |

## Behaviour

- **First qualifying paid period** of an organization in `AWAITING_FIRST_PAYMENT` (D7 sign-up or D9 HQ provisioning):
  entitlement becomes `COMPLETE ACTIVE`, `effective_from` = period start, `effective_until` = period end + 7 days.
  Access state becomes `PAYMENT_ACTIVE` with `activation_source = SCHEDULE_BINDING`, the binding, the first paid period
  and `paid_through`. One `SCHEDULE_FIRST_PAYMENT_ACTIVATION / APPLIED` transition (unique per organization, per binding and
  per paid period).
- **Refusals** (in check order), each recorded as an HQ access review: `ACCESS_PROGRAM_INACTIVE`, `BILLING_NOT_ACTIVE`,
  `ACCESS_STATE_NOT_ELIGIBLE` (no awaiting row, e.g. a legacy org), `EXCEPTION_ACTIVE`, `BILLING_REVIEW_PENDING`,
  `FOUNDER_UNAVAILABLE`, `ACCESS_ACTIVATION_ERROR` (amount or unexpected error), `PAID_PERIOD_NOT_STARTED`, `PAID_PERIOD_ELAPSED`.
- **While a review is open**, later payments are still recorded and return `ACTIVATION_PENDING`.
- **HQ-owner retry** `POST /v1/hq/saas/subscription-schedule-bindings/:bindingId/access-retry` with
  `{ expectedBindingVersion }` (idempotency key required). Human HQ owner only, rechecked after the organization lock.
  Requires the program active, an `ACTIVE` binding with an open review and no applied activation, and no refund or
  dispute on the binding. It activates on the latest period that has started, then applies renewals paid while waiting.
- **Renewals** extend `effective_until` and `paid_through` forward only (`EXTENDED`). A late earlier period is
  `ALREADY_COVERED`. A period starting after the current window has lapsed is reviewed (`PAID_PERIOD_GAP`), never bridged.
  A renewal for an organization whose access no longer follows this binding is reviewed (`ACCESS_STATE_NOT_ELIGIBLE`).
  A renewal while the paid-access program is off is kept as money and reviewed (`ACCESS_PROGRAM_INACTIVE`), never extended.
  Renewals applied by an HQ retry are isolated one by one: a failure is reviewed (`ACCESS_ACTIVATION_ERROR`) without undoing the activation.
- **Reads**: school and HQ binding reads add `access: { accessActivation, reason, paidThrough, accessUntil }`.

## Data and security changes

- `saas_access_states`: `activation_source`, `binding_id`, `first_paid_period_id`, `paid_through`. 0172's two v1-only
  CHECKs are replaced by a state/source shape CHECK: the v1 checkout shape (NULL source) is unchanged.
- `guard_saas_access` additionally allows a schedule-backed extension that only moves `paid_through` forward. Nothing
  else on the row may change, and rows are never deleted (owner included).
- `saas_access_transitions`: `binding_id`, `paid_period_id`, kinds `SCHEDULE_FIRST_PAYMENT_ACTIVATION` and
  `SCHEDULE_RENEWAL_EXTENSION`.
- `hon_runtime` gains EXECUTE on `retry_saas_schedule_access` only (restored in `infra/postgres/010` after the global
  SaaS revoke). The activation, hook, grace and access-read helpers stay unreachable.

## Not in this piece

- Piece 3: HQ review queue for access reviews, payment problems, refunds and disputes; v1 founder/lifetime sales stop.
- Piece 4: founder 50-spot counting (spot-#50 race to raise with the owner).
- Piece 5: screens.
- `PAST_DUE_SUSPENSION` read-only writer after the grace window; creative-wallet monthly grants for schedule-paid schools.
- Turning the paid-access program on (separate owner-approved migration).

## Evidence

- Disposable proof `packages/database/scripts/test-saas-schedule-billing-integrity.mjs`, group 5 (shipped hook) plus
  the piece-1 groups against the stub.
- API: `apps/api/test/saas-schedule-billing.test.cjs` (closed views, retry input and receipt).
- Staging pins: `packages/database/scripts/commercial-staging-manifest.json` (0235 target and chain).
