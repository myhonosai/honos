# Adult CRM membership DRAFT current confirmation

**Status:** Implemented and validated on the isolated `manus/crm-enrollment-workflow` branch. This is an explicit, direct-human recovery read for the previously delivered adult CRM registration → membership DRAFT workflow. It is not a membership directory, replay shortcut, enrollment wizard, activation command, billing operation, or provider workflow.

## Purpose

A direct-human adult CRM DRAFT command returns a **historical creation receipt**. That receipt remains a valid idempotency response even if a separately governed lifecycle action later changes the membership. It must therefore never be treated as proof that the membership is currently `DRAFT`.

A staff member who originally created an adult CRM DRAFT may, after reload or navigation, explicitly ask HON to confirm whether the source-bound membership is still the exact current `DRAFT` created from that adult CRM conversion.

```text
untrusted studentProfileId text
  → explicit source-bound current-DRAFT confirmation request
  → current immutable source + current relation + current membership re-verification
  → RECORDED_DRAFT receipt only when every condition still holds
```

## Authority and selector boundary

The only browser input is one untrusted `studentProfileId` UUID. It may be an inert URL prefill from the verified adult registration receipt, but it causes no mounting I/O, scope resolution, idempotency-key allocation, confirmation, activation, retry, or other effect.

The fixed function must rederive the relation from the selected student through the immutable adult `REGISTERED` CRM conversion. It must require the same active ordinary direct-human principal that recorded the immutable source link, the exact current organization/school, active `billing.membership.create` permission, active Essential/Core/Complete entitlement, HUMAN_UI source, a sole active human principal, no HQ or family context, and no Action Engine or delegation context. This creator-owned restriction prevents the read from becoming a general staff membership lookup. A different otherwise authorized staff member receives no receipt or match explanation.

The database reads the exact source only through conversion → immutable `crm_adult_membership_draft_sources` → source membership. It must never look up a generic membership, newest membership, account, person, source, conversion, plan, term, or membership ID supplied by the browser.

## Current-DRAFT proof

The confirmation succeeds only when the private immutable source, freshly re-derived adult relation, and current membership agree exactly:

1. one current-school immutable `ADULT` conversion with response `outcome = REGISTERED`, the same original lead-contact person, an active non-family student, and exactly one canonical billing account;
2. one immutable source for that conversion, current school and original actor, whose source receipt has exactly the original six allowed receipt fields;
3. one exact source membership in the current school, still `DRAFT`, still tied to the re-derived canonical account and participant, with unchanged plan, term values, source timestamp, and initial membership version; and
4. no second same-person membership, payment schedule, or invoice connected to that membership.

Every source, relation, receipt, membership, state, account, participant, plan, term, schedule, invoice, permission, entitlement, identity, tenant, lock, or final recheck failure is unavailable without a reason, count, identifier, or generic-membership signal. The read writes no audit event, outbox event, idempotency record, membership, account, enrollment, agreement, schedule, invoice, payment method, charge, provider record, communication, curriculum/attendance, AI, Action Engine, or automation work.

## API and closed result

The endpoint is a separate same-origin `POST` under the existing adult CRM DRAFT resource:

```text
/v1/organizations/:organizationId/schools/:schoolId/billing/
crm-adult-membership-drafts/confirmation
```

It accepts exactly `{ studentProfileId }`, requires exact `X-HON-Human-Command: crm-adult-membership-draft-confirmation`, JSON UTF-8, configured Origin and Fetch Metadata, no query, no extra `X-HON-*` headers, and no `Idempotency-Key`. It retains no-store, no-referrer and noindex response headers. It uses an ordinary scoped transaction solely for bounded SHARE locks and live rechecks; the function contains no DML.

Only a successful current observation returns a closed envelope with `replayed: false` and:

```json
{
  "state": "RECORDED_DRAFT",
  "receipt": {
    "membershipId": "uuid",
    "state": "DRAFT",
    "planCode": "opaque string",
    "termStartedAt": "UTC milliseconds or null",
    "termEndsAt": "UTC milliseconds or null",
    "recordedAt": "UTC milliseconds"
  }
}
```

A missing, foreign, ambiguous, nonadult, prior-actor, invalid, changed, activated, scheduled, invoiced, noncanonical, or otherwise unsafe relation returns only the existing non-disclosing unavailable outcome. It does not return an `ACTIVE` state, generic membership existence, source/payer/account/person/conversion details, currency, version, financial data, provider data, or reason.

## Workbench behavior

The existing adult CRM DRAFT workbench offers a separate explicit **Confirm current source-bound DRAFT** action beside its explicit readiness action. These two intents are mutually exclusive. A successful confirmation renders a card named **Current source-bound DRAFT confirmation**, not a historical creation receipt, suppresses the create command, and may offer only the already approved membership activation handoff whose URL carries the untrusted `membershipId` scalar alone.

The historical post-command receipt remains labelled historical. The workbench must not automatically confirm after a DRAFT command, must not turn confirmation into activation, and must not offer the link for unavailable, malformed, stale, error, or historical-only states. Selector edits, school selection, new intent, discard, unmount, focus/visibility invalidation, access loss, and every non-success outcome clear all derived readiness, current confirmation, command, historical receipt, and memory-only retry state as applicable; no refetch occurs merely because focus or visibility changes.

## Verification

Migration `0162_crm_adult_membership_draft_confirmation.sql` adds one fixed `SECURITY DEFINER` confirmation function and only its least-privilege runtime execute ACL. Runtime reconciliation, the canonical PostgreSQL verifier, the dedicated adult CRM function security verifier, API/contract/browser tests, and the existing marked disposable adult CRM integrity proof were extended. The proof snapshots all relevant HON tables around every success/failure path, blocks external transports, validates creator/tenant/relation/source/lifecycle/authority drift, verifies no generic fallback, and runs the canonical verifier against the exact final function body hash.

## Validation evidence

The dedicated marked disposable PostgreSQL proof passed 153 assertion groups and 284 organization/all-table no-effect snapshots across the adult-only relation, immutable source, creator ownership, live permission/entitlement/identity context, generic-fallback refusal, historical replay distinction, active/plan/schedule/invoice drift refusal, race/failure injection, function ACL/search-path/body-hash/signature/no-overload drift, and external-effect exclusion cases. Focused API tests (4) and browser transport/workbench/route/handoff tests (5 files / 20 tests) passed. `pnpm db:check` verified 162 migrations; the guarded dispatcher passed all 16 disposable proofs across 5 fixtures with 236 forced-RLS tracked tables; root `pnpm test` passed 433 tests; and root `pnpm check`, `pnpm build`, and `git diff --check` passed. No remote database, payment/provider, communication, deployment, shared visual component, portrait, or Claude experimental asset was changed.
