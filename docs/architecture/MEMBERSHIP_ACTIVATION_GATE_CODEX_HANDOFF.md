# Membership activation gate: Codex frontend handoff (E1a)

The backend for E1a is in [MEMBERSHIP_ACTIVATION_GATE.md](MEMBERSHIP_ACTIVATION_GATE.md). This note covers only what the frontend must change. Claude did **not** edit `apps/web`, which remains Codex-owned.

## What breaks today

`apps/web/src/components/membership-activation-http.ts` → `activateKnownMembership()` posts `{ expectedVersion }` to `…/activate`. Its caller is `membership-activation-workbench.tsx`. After 0177 that call returns:

```
400 { "code": "ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED" }
```

This happens before any database work. The success parser also expects the old response (`id`, `planCode`, `createdAt`, `state`, `version`); the new response is the activation receipt. The frontend has no cancellation caller, and the cancellation contract is unchanged.

The backend was deliberately **not** relaxed to accept the old body.

## New flow

1. **Preview** (read-only; repeat whenever the dates change):
   ```
   POST /v1/organizations/:org/schools/:school/billing/memberships/:id/activation-preview
   X-HON-Human-Command: billing.membership.activation.preview
   (no Idempotency-Key — sending one returns 409 IDEMPOTENCY_KEY_NOT_ACCEPTED)
   body: {}  or  { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" | null }
   ```
2. **Show the staff member:**
   - participant, plan, source;
   - the school timezone and today's date there;
   - suggested dates with their basis, and the proposed dates;
   - the projected status: SCHEDULED, IN_EFFECT or ENDED;
   - every warning (each needs its own acknowledgement control) and any blocks (disable confirm);
   - the "not evaluated" list: agreement, payment, recurring payment authorization, financial responsibility, school policy. State it plainly: activation does **not** record an agreement, consent or payment.
3. **Override** (only if `availableOverrides` includes `CRM_IDENTITY_REVIEW_PENDING`): ask for a reason (10–500 characters) and a second explicit confirmation that the review **remains unresolved**. If `overridableWarnings` is non-empty but `availableOverrides` is empty, explain that someone with the override permission must confirm.
4. **Missing birth date:** offer the optional staff adult attestation (method plus attestation) and say a reminder will be created.
5. **Backdated start or reason `OTHER`:** require `reasonText`.
6. **Dates different from the suggestion:** require `dateAdjustmentReason`. The server derives `dateSource`; send exactly what the preview returned in `proposedDates.dateSource`.
7. **Confirm:**
   ```
   POST …/:id/activate
   X-HON-Human-Command: billing.membership.activate
   Idempotency-Key: <one key per confirmation attempt; reuse it only to retry the identical body>
   body: { expectedVersion, previewDigest, startDate, endDate, dateSource, [dateAdjustmentReason],
           acknowledgedWarnings, overrides, [adultVerification], reasonCode, [reasonText], confirmation }
   ```
   Use the types and validators in `@hon/contracts` (`packages/contracts/src/membership-activation.ts`): `ConfirmMembershipActivationInput`, `validateConfirmMembershipActivationInput`, `verifyMembershipActivationPreview`, `verifyMembershipActivationReceipt`.

## Handling responses

- `ACTIVATION_PREVIEW_STALE` (409): something changed (the DRAFT, its records, the school timezone or date). Preview again and show the differences. Never auto-retry the confirmation.
- `VERSION_CONFLICT` / `MEMBERSHIP_NOT_DRAFT` (409): reload.
- `IDEMPOTENCY_KEY_REUSED` (409): a new key is needed for a changed body.
- 422 codes mean the confirmation did not match the preview. Show which one:

  | Code | Meaning |
  |---|---|
  | `ACTIVATION_ACKNOWLEDGEMENT_REQUIRED` | Not every warning was acknowledged. |
  | `ACTIVATION_OVERRIDE_REQUIRED` | An override is needed. |
  | `ACTIVATION_REASON_TEXT_REQUIRED` | Reason text is needed. |
  | `DATE_SOURCE_MISMATCH` | The date source differs from the preview's. |
  | `ADULT_VERIFICATION_NOT_APPLICABLE` | An adult attestation was sent although the birth date is known. |
  | `ACTIVATION_BLOCKED` | The preview has blocks. |
- 403 `ACTIVATION_OVERRIDE_FORBIDDEN`: this staff member cannot document the override.
- On success, show the confirmed dates in **school time**. Show "Confirmed — starts on <date>" when `effectiveStatusAtActivation` is SCHEDULED, and list the follow-up reminders (`followUps`).

## Wording guardrails

- ACTIVE means "confirmed by staff", not "paid", "signed" or "benefits available now".
- The end date is the **last day** of the membership (inclusive).
- Don't claim future-dated memberships are hidden from reports. The operations report and parent billing view still show lifecycle state (E1b).

## Suggested tests

- Preview → confirm happy path.
- Each warning's acknowledgement.
- Override present vs absent.
- Stale preview recovery.
- Legacy-body regression (the old call must be gone).
- DST and school-timezone date display.
- No Idempotency-Key on preview.


## Connected CRM membership review (frontend integration, 2026-11-02)

The original handoff above is historical. Current main already implements the E1a two-step UI and backend. This frontend increment reuses those routes and services; it adds no domain logic, migration, entitlement or provider authority.

### Actual contract and workflow inventory

| Step | Authoritative support | Connected staff interaction |
| --- | --- | --- |
| Adult/guardian registration | Existing CRM registration and 0174/0176 recovery | Existing explicit commands and Resume Setup, unchanged |
| Canonical billing account / guardian payer | Existing account create/reuse and explicit guardian designation | Existing exact-request commands, unchanged |
| Membership DRAFT | Existing catalog/version-bound adult and per-child commands; legacy free-text adult route preserved | Existing picker and creation receipts, unchanged |
| Current creator DRAFT | Adult confirmation/recovery and child recovery with creator-visible receipt | New localized **Review membership activation** action; hidden for historical receipts and another staff member's redacted DRAFT |
| Activation review | `POST .../billing/memberships/:id/activation-preview` | Explicit protected preview; no automatic read on CRM handoff, no idempotency key for this read |
| Activation command | `POST .../billing/memberships/:id/activate` | Existing digest-bound closed body, direct-human marker, independent final confirmation and immutable UUID request key |
| Current lifecycle observation | `GET .../billing/memberships/:id/activation-context` | Explicit **Check current membership status** and privacy restoration; scope, identity and permission independently reverified |
| School operations | Existing class-bookings and attendance screens | Navigation after receipt only; links do not create a booking, record attendance or establish membership eligibility |

The CRM handoff carries only organization, school and membership **selectors in mounted private memory**. It does not pass a receipt or claimed permission as authority. The activation UI pins the original signed identity, independently verifies it before and after protected reads, and rechecks before commands and before displaying a returned receipt. Backend authorization remains decisive. Bound selector fields are read-only. Returning remounts an empty CRM; there is no automatic replay or restoration read.

### Privacy and recovery

Blur, hidden visibility, pagehide, confirmed shared session invalidation and school-context invalidation conceal the activation area immediately and invalidate pending reads. Command ownership is separate from read invalidation, so an in-flight command can settle behind the shield. Unknown results retain the identical frozen request, serialized body and key in memory. Staff must explicitly verify session/exact-school activation authority before revealing data and explicitly choose any exact retry. Failed retry preflight does not discard the prior uncertain request. Discard and Return are blocked while a command is unsettled; deliberate abandonment cannot undo any server action. Discarding a concealed CRM-bound view returns to a new empty CRM rather than revealing its selectors.

Full document destruction, sign-out/remount or closing the tab destroys in-memory retry evidence. `beforeunload` warns where supported; it does not provide durable recovery. Existing CRM privacy restoration still depends on its authorized, filtered 50-row lead list. No retry key or sensitive fact is placed in storage, URLs or telemetry.

### Truthful status and remaining dependencies

- A registration, canonical account, saved card or DRAFT is not payment, agreement, recurring authorization or financially complete enrollment.
- An activation receipt records historical confirmed dates and `effectiveStatusAtActivation`. A future start is displayed as scheduled, not currently IN_EFFECT. A later lifecycle context read reports only lifecycle state/version; ACTIVE alone does not establish current effective dates, benefits or payment.
- Current registration recovery is deliberately DRAFT-specific. After activation it may require staff review; it is **not** a durable lead/student-to-active-membership reader. Cross-session active-membership lookup/reconciliation remains a backend contract dependency. This change does not manufacture that response or automatically recreate records.
- PR #104 remains separate at `c4b607ae9e05cbb67e54753ebccd5db02b5e232c`. Its date history/revision/effective-status routes are not copied or linked before merge. During its later normal reconciliation, its activation-http transpilation in `membership-dates-api-verification.mjs` must also rewrite the new `./session-invalidation` import, as the current E1a API harness does. No #104 branch changes are included here.
- New handoff and activation captions support EN/KO/ES; activation supports Modern/Classic/Big Button. Older surrounding CRM text has inherited localization gaps; this is not a claim of full-product translation coverage.
- Known-minor guardian requirements, missing-DOB warnings/reminders, delegated activation/override capabilities, immutable original terms and cancellation contracts remain backend-owned and unchanged.
- Persistent migration verification, broader effective-status consumers, payment schedules, agreements, parent provisioning and deployment remain separate gates. No real provider, customer or production activation was performed.

### Verification boundaries

`school-membership-integration-api-verification.mjs` uses actual frontend transports, actual signed-session Nest routes and the restricted runtime against a guard-marked disposable PostgreSQL database. It exercises adult and per-child plan-bound DRAFTs through explicit activation, creator redaction, concurrent exact retries, stale facts, unknown committed outcomes, two organizations, revoked access and unchanged unrelated financial/AI/entitlement tables. These are synthetic records with real database effects confined to that disposable fixture.

`school-membership-journey-browser.mjs` runs mounted production Next components with signed synthetic localhost API fixtures. Browser screenshots and accessibility scans establish UI behavior; they do not establish API/database authorization. The dedicated exact-head draft-safe workflow runs the full repository checks and canonical PostgreSQL proof registry; the existing CRM browser workflow retains adult/family/activation regressions. Report CI results separately from local checks; no skipped job is a passing test.
