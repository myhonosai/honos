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
