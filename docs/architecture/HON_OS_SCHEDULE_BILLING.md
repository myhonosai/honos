# HON OS schedule billing — piece 1 (migration 0230)

**Status:** draft, owner-authorized build of piece 1 of five (owner decisions 2026-11-09). Source only. This authorizes no live provider operation, checkout, charge, refund, paid-access activation, founder sale, deployment, or customer-data action. Merge requires explicit owner approval.

**Replaces:** the unmerged Commercial B2 draft (PR #90, draft migration `0191`). Its schedule-binding work is rebuilt here on current main as `0230_hon_os_schedule_billing.sql`; 0191 on main belongs to the D7 owner-invitation flow (#88).

## Owner decisions this piece implements

| Decision | Effect here |
|---|---|
| Five pieces, in order, each merged with owner approval | Piece 1 = schedule tracking only. Access hook is a stub; HQ queue, legacy founder/lifetime stop, founder counting and screens come later. |
| Founder pricing recurs while subscribed ($199.20/mo or $1,494/yr), standard $249/$2,097 after cancel/lapse | One locked price per binding: `saas_schedule_requirements` refuses intro periods or initial ≠ renewal (`SAAS_SCHEDULE_PRICE_NOT_LOCKED`) and exposes `lockedPriceMinor`, `priceRule = LOCKED_WHILE_SUBSCRIBED`. No release/step-up path exists. Founder generations stay refused by 0189 until piece 4 adds founder terms V2 and the 50-spot allocation. |
| Failed access switch-on: keep payment, HQ reviews access, no auto-refund | Billing and access are separate outcomes. See "First payment". |
| OD-4: unpaid sign-up expires after 7 days; school may cancel before first payment at no cost (2026-11-09T04:20Z) | `saas_billing_lifecycle_policy` ships version 1 with `unpaid_window_minutes = 10080` and an approval reference to the owner decision (immutable). School command `cancel_saas_schedule_binding` (below). |
| 7-day grace, then read-only suspension | Not changed here: the existing B6A/CRM suspension rules (0192) stay the authority. `invoice.payment_failed` is stored as `ATTEMPT_FAILED` and never suspends by itself. |

## Binding lifecycle

Statuses: `PENDING_PROVIDER_BINDING`, `BOUND_TEST_ONLY`, `ACTIVE`, `NEEDS_REVIEW`, `EXPIRED_UNPAID`, `VOIDED_PROVIDER_FAILED`, `CANCELLED_BEFORE_PAYMENT`. The first four are live and block a second lifecycle for the organization (with the existing checkout, subscription, `PAYMENT_ACTIVE` and access-exception conflicts). The last three are terminal and release the organization.

Every change goes through `saas_schedule_binding_transition`, which bumps `version` by one and writes the claim, audit row and `saas.schedule_binding.transitioned` outbox event. The update trigger allows only a closed table of (from, to, columns) transitions; a deferred constraint trigger refuses a commit whose latest version has no matching audit row.

- **Start** (school, `billing.hon.purchase`): rederives the immutable B1 generation, opens a TEST-only binding through the injected deterministic provider. Production default stays `UnconfiguredSubscriptionScheduleProvider`.
- **Observation**: provider confirms the exact references and terms → `BOUND_TEST_ONLY`.
- **Reconciliation worker** (`record_saas_schedule_binding_reconciliation`): for a pending binding, provider `NOT_FOUND` → `VOIDED_PROVIDER_FAILED`; `TERMS_MISMATCH` → `NEEDS_REVIEW`; unknown → 503, nothing written.
- **Expiry worker** (`record_saas_schedule_binding_expiry`): `BOUND_TEST_ONLY` → `EXPIRED_UNPAID` only when the policy's 7-day window (10080 minutes, measured from sign-up, i.e. binding creation) has elapsed since `bound_at`, the provider confirms `CANCELLED_NOTHING_COLLECTED`, and no non-failure provider event is stored. A missing policy row fails closed (`SAAS_BILLING_POLICY_UNAVAILABLE`).
- **Cancel before first payment** (school, `billing.hon.purchase`, `POST /v1/schools/:schoolId/hon-os-subscription-schedule-bindings/:bindingId/cancel`, human command `saas-schedule-binding-cancel`): the API reads the binding through the exact-school read, asks the provider to cancel, and records only a confirmed `CANCELLED_NOTHING_COLLECTED`. The database rechecks purchaser authority after the organization lock and refuses (`SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE`) unless the binding is `BOUND_TEST_ONLY` with matching provider references and no stored money evidence. Result: `CANCELLED_BEFORE_PAYMENT`, audited as `saas.schedule_binding.cancel`; exact-key replay returns the receipt. A pending binding is left to the reconciliation worker; a paid subscription follows the normal cancellation terms, not this path.
- The workers are privileged runtime calls with no HTTP route.

## Evidence ingest and first payment

`ingest_saas_schedule_evidence` finds the binding by provider references (a payload `bindingId` must agree, otherwise 55P03 → 409 `SAAS_OUTCOME_UNKNOWN`). Lock order: event lock → `saas.organization:<org>` advisory lock → binding `FOR UPDATE`.

- Exact paid period at the locked price on a bound or active binding → paid period recorded. The first one moves `BOUND_TEST_ONLY → ACTIVE` (billing outcome).
- Then the access hook `saas_schedule_after_paid_period` runs inside an exception sub-block. In this piece it is a stub returning `NOT_ATTEMPTED`. If it raises or returns a broken contract, the payment and `ACTIVE` billing status stand, the receipt reports `access.accessActivation = NEEDS_REVIEW` with reason `ACCESS_HOOK_FAILED`, and a reconciliation row is written for HQ (piece 3 adds the queue).
- Wrong amount, overlapping period or reversal on a collecting binding → binding `NEEDS_REVIEW` + reconciliation row. A late earlier non-overlapping period is recorded normally.
- A covered period that is not exactly one billing interval of the locked terms (one calendar month or year, within one day) → `PERIOD_INTERVAL_MISMATCH` review; it is never counted, so one payment can never cover more than one interval.
- Events for review or terminal bindings are stored, not refused (`BINDING_NOT_COLLECTING`, `PAID_AFTER_TERMINAL`), so money is never lost from the ledger.
- Money stored for review on an ended binding (expired, voided, cancelled) counts as a billing conflict: the organization cannot start a new binding (`SAAS_BILLING_REVIEW_PENDING`) until HQ resolves it, so late money is never followed by a second charge.
- `invoice.payment_failed` → `ATTEMPT_FAILED`, no reconciliation row, no status change.

`saas_org_billing_conflict` is a STABLE read-only probe (proved inside a READ ONLY transaction); `saas_schedule_binding_available` refuses with `SAAS_BILLING_REVIEW_PENDING` while a review is open.

## Security boundary

Forced RLS on all five tables; immutability triggers on events, paid periods and reconciliations; all functions revoked from PUBLIC/anon/authenticated/service_role. `hon_runtime` gets EXECUTE on exactly eight procedures (start, cancel, observation, two workers, two reads, ingest), restored in `infra/postgres/010_supabase_hon_runtime.sql` after the global SaaS revoke. Hooks, transition helper, conflict probe and guards are unreachable. Receipts and views always report `checkoutAvailable: false`, `billingEnabled: false`, `accessDecidedSeparately: true`.

## Not in this piece (follow-ups)

- Founder spot race at #50 (piece 4): recommended to count at first payment and refuse the founder sign-up before charging once 50 are paid.
- Scheduling the expiry worker (no job runner here); it is a privileged call with no route.
- Piece 2: real access switch-on in the hook (B6A `PAYMENT_ACTIVE`), migration 0235, see [HON_OS_SCHEDULE_PAID_ACCESS.md](HON_OS_SCHEDULE_PAID_ACCESS.md).
- Piece 3: HQ review queue (payment problems, refunds), stopping founder and lifetime sales in the legacy checkout.
- Piece 4: founder terms V2 (new pricing-terms version; 0188 history untouched) and counting the 50 spots (new founder-plan sales only).
- Piece 5: screens.
- Dedicated webhook role for ingest (SF-2).

## Evidence

- Disposable proof: `packages/database/scripts/test-saas-schedule-billing-integrity.mjs` (groups: lineage, locked-price evidence, hook isolation, lifecycle, RLS).
- API: `apps/api/test/saas-schedule-billing.test.cjs`.
- Staging pins: `commercial-staging-manifest.json` ceiling 0230.
