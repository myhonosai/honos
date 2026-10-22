# Membership activation gate (E1a, migration 0177)

Status: implemented on `claude/project-thread-qzchtw`, **not merged, not deployed**. Nothing here activates a real membership, collects money or changes HON's own SaaS billing.

E1a turns school membership activation into a **two-step, direct-human, school-scoped decision** backed by immutable evidence:

1. **Preview.** `POST …/billing/memberships/:membershipId/activation-preview` is read-only. The server evaluates one current-school membership and returns its facts, warnings, overrides, blocks, suggested and proposed dates, and a digest of everything it evaluated.
2. **Confirm.** `POST …/billing/memberships/:membershipId/activate` takes an exact confirmation of what was previewed. The database re-derives every fact under the canonical locks, refuses any difference, re-checks live authority, and records one decision, one initial effective period and the DRAFT→ACTIVE transition in a single transaction.

The pre-0177 body (`{ "expectedVersion": n }`) now fails closed with `400 ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED`. The backend gate was **not** weakened to keep the old frontend call working; see the [Codex handoff](MEMBERSHIP_ACTIVATION_GATE_CODEX_HANDOFF.md).

Related documents:
- [Deployment plan and remaining risks](MEMBERSHIP_ACTIVATION_GATE_DEPLOYMENT_AND_RISKS.md)
- [Lock order](CRM_OWNER_LAUNCH_LOCK_ORDER.md)

## Owner decisions implemented

| Decision | What 0177 does |
|---|---|
| D3 birth date | A missing birth date is the warning `BIRTH_DATE_MISSING` plus a staff work item (`Record birth date for an activated membership`). Staff may add an optional adult attestation (`adultVerification`), which is accepted **only** when the birth date is missing. HON never invents or stores a birth date. A known minor still needs an active family in which they are a STUDENT with a GUARDIAN of record (`MINOR_GUARDIAN_OF_RECORD_REQUIRED`). |
| D13 legacy DRAFTs | Every DRAFT (generic, Owner Launch, CRM adult, CRM plan, guardian/child) goes through the same gate. ACTIVE, CANCELLED and other non-DRAFT rows are untouched; nothing is backfilled. |
| D29 configurability | Warnings, confirmations, overrides and audit are data-driven codes. The school-configurable rules engine is E1c; until then every school uses `decisionBasis = STAFF_ACTIVATION_PRE_POLICY`. |
| D29a identity-review override | `CRM_IDENTITY_REVIEW_PENDING` is the only overridable warning. An override needs an explicit reason (10–500 characters), the secondary confirmation `I_ACKNOWLEDGE_THE_REVIEW_REMAINS_UNRESOLVED`, the school-scoped `billing.membership.activation.override` permission (in addition to activate), and it creates a HIGH-priority work item. The review is recorded as `resolved: false`. No person, account, family or CRM record is merged, relinked or changed. Replay and concurrency are exact (see proofs). |
| D30 activation | `billing.membership.activate` with server preview, warnings, final confirmation (`I_CONFIRM_MEMBERSHIP_ACTIVATION_AND_DATES_NO_AGREEMENT_CONSENT_OR_PAYMENT_RECORDED`), exact-request idempotency, and audit and outbox. |
| D30a permissions | Three new sensitive, staff-assignable permissions (assignment and revocation are described below). Only `…activation.override` is used in E1a. `…rules.manage` and `…change.approve` are reserved for E1c, and no function references them. |
| D37 E7 compatibility | Every decision records `decision_basis`, `membership_source`, the authorizing and override permissions, and `requirements_not_evaluated` (AGREEMENT, PAYMENT, RECURRING_PAYMENT_AUTHORIZATION, FINANCIAL_RESPONSIBILITY, SCHOOL_ACTIVATION_POLICY). This lets E7 retire the staff-activation path per school without reinterpreting history. |
| D40 dates | HON suggests dates and staff confirm them. A date that differs from the suggestion is `STAFF_ADJUSTED` and needs `dateAdjustmentReason`. The INITIAL effective period is immutable evidence. |
| D40a calendar | Dates are school-local `YYYY-MM-DD` in the school's IANA timezone. The end date is **inclusive**: its instant is the start of the next local day. The start of a local day is the earliest instant whose local date is that day, which handles 23- and 25-hour days, skipped midnights (Santiago), midnight DST changes (Havana) and 30-minute shifts (Lord Howe). |
| D41 option C | The runtime loses UPDATE, DELETE and TRUNCATE on `hon.memberships` and may INSERT only seven DRAFT columns, so state and version come from their defaults. Lifecycle changes run only in definer functions. A settings-free transition trigger refuses every transition that lacks the matching evidence rows. |

## Database objects

**Tables.** All three are private: FORCE RLS, no policies, no runtime grant, and immutable (UPDATE, DELETE and TRUNCATE raise `IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE`).
- `hon.membership_activation_decisions`: one row per activated membership. It holds the prior and next version, basis, source, actor, permissions, reason code and text, acknowledged warnings, overrides (with reasons), adult attestation, preview digest, the full evaluated facts, requirements not evaluated, the idempotency key and request fingerprint, request and correlation ids, and the receipt.
- `hon.membership_effective_periods`: `period_version` and `change_kind` (E1a writes only `INITIAL`; `CORRECTION`, `EXTENSION` and `EARLY_END` are reserved for E1b). Also local start and end dates, school timezone, projected instants, date source, suggested dates and basis, adjustment reason, actor, permission, a NULL `approval_reference` reserved for E1c, and the decision id.
- `hon.membership_activation_follow_ups`: links a decision to the work items it created.

**Trigger `membership_state_transition_guard`** (`BEFORE INSERT OR UPDATE` on `hon.memberships`). It is non-definer and reads **no** session or transaction setting, so nothing a caller can set authorizes a transition.
- INSERT must be DRAFT version 1. id, organization, school and created_at never change.
- A DRAFT may be edited in place. A non-DRAFT row accepts only no-op updates.
- A state change must keep account, participant and plan code, and must be version+1.
- DRAFT→ACTIVE requires the decision for exactly this version pair and an INITIAL v1 period whose projected instants equal the new term fields.
- ACTIVE→CANCELLED requires unchanged terms.
- Everything else raises `MEMBERSHIP_STATE_TRANSITION_DENIED`. This applies even to the BYPASSRLS table owner with forged settings (proven).

**Runtime entry points.** `SECURITY DEFINER`, `search_path=pg_catalog, hon`, EXECUTE for `hon_runtime` only:
- `hon.preview_school_membership_activation(subject, membership, jsonb)`: no DML, locks, audit or idempotency.
- `hon.activate_school_membership(subject, membership, jsonb, key, request, correlation)`.
- `hon.cancel_school_membership(subject, membership, jsonb, key, request, correlation)`: the unchanged public cancellation contract, now key-first with live `billing.membership.cancel` re-checks.

**Private helpers** (no runtime EXECUTE): `require_membership_lifecycle_actor`, `membership_lifecycle_permission`, `evaluate_membership_activation`, `membership_local_date`, `membership_local_day_start`, `membership_effective_status_at`, `membership_activation_text_ok`, `membership_activation_date`.

**Authority (every call, live, never cached).** The 0162 direct-human identity rules apply:
- verified subject equals the transaction subject;
- HUMAN_USER, HUMAN_UI source, no Action Engine request, no delegation;
- exactly one active principal;
- active organization and school;
- no HQ operator, family access or family/HQ/system role;
- an eligible staff member;
- an ACTIVE ESSENTIAL, CORE or COMPLETE entitlement;
- the exact permission through a current, unrevoked grant **at this school**.

Authority is re-checked after the IAM SHARE wait, on every replay (including the override permission if the replayed decision used one), and again after every write before returning.

**Lock order** (canonical, 0169):
1. Key reservation.
2. IAM SHARE.
3. people, student_profiles, families, family_members, CRM conversions, leads and billing_accounts SHARE.
4. memberships ROW EXCLUSIVE, then the row `FOR UPDATE`.
5. CRM DRAFT sources and plan tables SHARE.
6. Writes, with audit and outbox last.

## Preview and confirmation contract

Preview body: `{}` (use the suggestions) or `{ "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" | null }`. It never takes an Idempotency-Key, and the browser command header is `X-HON-Human-Command: billing.membership.activation.preview`.

Preview response (`MembershipActivationPreview` in `packages/contracts/src/membership-activation.ts`):
- `membershipId`, `state`, `version`, `billingAccountId`, `participantPersonId`, `participantDisplayName`, `planCode`.
- `source`: `GENERIC_LEGACY`, `OWNER_LAUNCH`, `CRM_ADULT_FREE_TEXT`, `CRM_ADULT_PLAN` or `CRM_GUARDIAN_CHILD_PLAN`.
- `plan`, `existingTerm`, `schoolTimezone`, `localToday`, `birthDateRecorded`, `knownMinor`.
- `suggestedDates` (with `startBasis` and `endBasis`), `proposedDates` (with `dateSource`).
- `projection`: the exact instants that would be stored.
- `effectiveStatusIfConfirmedNow`, `warnings`, `overridableWarnings`, `availableOverrides` (empty when this staff member lacks the override permission), `blocks`, `canConfirm`, `requirementsNotEvaluated`, `previewDigest`, `confirmation`.

Warnings (each must be acknowledged exactly): `LEGACY_FREE_TEXT_PLAN`, `CRM_IDENTITY_REVIEW_PENDING` (overridable), `BIRTH_DATE_MISSING`, `START_DATE_BACKDATED{days}`, `START_DATE_IN_FUTURE{days}`, `END_DATE_PASSED`, `FIXED_TERM_DIFFERS_FROM_PLAN{planEndDate}`, `OPEN_ENDED_PLAN_HAS_END_DATE`, `EXISTING_PAYMENT_SCHEDULE_NOT_EVALUATED`, `EXISTING_INVOICE_NOT_EVALUATED`.

Blocks (cannot be confirmed):

| Block | Cause |
|---|---|
| `MEMBERSHIP_NOT_DRAFT` | The membership is not a DRAFT. |
| `PLAN_BINDING_INVALID` | The bound plan version is missing or its plan code differs. |
| `PLAN_CURRENCY_MISMATCH` | The plan's currency differs from the billing account's. |
| `CRM_DRAFT_CHANGED` | The CRM receipt differs from the row, or the version is not 1. |
| `MINOR_GUARDIAN_OF_RECORD_REQUIRED` | A known minor has no guardian of record. |
| `START_DATE_OUT_OF_RANGE` | The start is before 2000-01-01 or more than 730 days after local today. |
| `END_DATE_BEFORE_START` | The end date is before the start date. |
| `END_DATE_OUT_OF_RANGE` | The end is more than 3,653 days after the start. |
| `FIXED_TERM_END_DATE_REQUIRED` | A fixed-term plan has no end date. |

Confirmation body (closed; `ConfirmMembershipActivationInput`):
- `expectedVersion` and `previewDigest`.
- `startDate`, `endDate` and `dateSource`, plus `dateAdjustmentReason` exactly when the source is STAFF_ADJUSTED.
- `acknowledgedWarnings`: exactly the warning codes.
- `overrides`: exactly the overridable codes, as `{code, reason, confirmation}`.
- `adultVerification` (optional): `{method: ID_CHECKED_IN_PERSON | DOCUMENT_REVIEWED | SELF_DECLARED_TO_STAFF, attestation: I_ATTEST_STAFF_VERIFIED_THE_PARTICIPANT_IS_AN_ADULT}`.
- `reasonCode`: one of ROUTINE_ENROLLMENT, DOCUMENTS_PENDING, PAPER_RECORDS_HELD_BY_SCHOOL, PAYMENT_HANDLED_OUTSIDE_HON, LEGACY_MEMBERSHIP, SCHOLARSHIP_OR_COMP, STAFF_FAMILY or OTHER.
- `reasonText`: required for OTHER and for a backdated start.
- `confirmation`.

Any key outside this closed list (payment, agreement, birth date, schedule and so on) is refused with 400. The Idempotency-Key header is required.

Receipt (`MembershipActivationReceipt`):
- `membershipId`, `state: ACTIVE`, `version`, `previousVersion`, `decisionId`, `decisionBasis`, `membershipSource`, `authorizingPermission`, `overridePermission`.
- `effectivePeriod{periodVersion, startDate, endDate, endDateInclusive: true, schoolTimezone, dateSource, termStartedAt, termEndsAt}`.
- `effectiveStatusAtActivation` (SCHEDULED, IN_EFFECT or ENDED), `acknowledgedWarnings`, `overridesUsed[{code, resolved: false}]`, `followUps[{kind, workItemId}]`, `adultVerification`, `reasonCode`, `requirementsNotEvaluated`, `recordedAt`.

Audit `billing.membership.activate` stores the prior `{state, version, terms}` and the receipt. Outbox `billing.membership.activated` is schema **v2** (receipt plus `executionAllowed: false, humanOnly: true`); no consumer acts on it.

Errors:

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED` |
| 403 | `MEMBERSHIP_ACTIVATION_FORBIDDEN`, `ACTIVATION_OVERRIDE_FORBIDDEN` |
| 404 | `BILLING_MEMBERSHIP_NOT_FOUND` |
| 409 | `MEMBERSHIP_NOT_DRAFT`, `VERSION_CONFLICT`, `ACTIVATION_PREVIEW_STALE`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`, `SCHOOL_TIMEZONE_INVALID`, `IDEMPOTENCY_KEY_NOT_ACCEPTED` (preview) |
| 422 | `ACTIVATION_BLOCKED`, `DATE_SOURCE_MISMATCH`, `ACTIVATION_ACKNOWLEDGEMENT_REQUIRED`, `ACTIVATION_OVERRIDE_REQUIRED`, `ADULT_VERIFICATION_NOT_APPLICABLE`, `ACTIVATION_REASON_TEXT_REQUIRED` |

**Idempotency.** The fingerprint is sha256 of `{command, membershipId, input}`. Any difference under the same key is `IDEMPOTENCY_KEY_REUSED`. The decision row is the lifetime record of its key, so an exact replay still returns the stored receipt after the 24-hour idempotency record has been purged, and only after live authority is re-proven.

## Dates (D40/D40a)

- **Suggested start.** The DRAFT's start in school time (`DRAFT_START_DATE`), else today in the school timezone (`TODAY_IN_SCHOOL_TIMEZONE`).
- **Suggested end:**
  - `PLAN_FIXED_TERM`: start + N months − 1 day.
  - `PLAN_OPEN_ENDED`: no end.
  - `DRAFT_END_DATE`: the local date of the DRAFT end instant minus 1 µs.
  - `NO_END_DATE`.
- **Month arithmetic** follows PostgreSQL month addition (clamped to the last day of the month), as the 0175 plan helper does:
  - 2027-01-31 + 1 month − 1 day = 2027-02-27;
  - 2027-03-31 → 2027-04-29;
  - 2028-02-29 + 12 months − 1 day = 2029-02-27.

  Staff can adjust with a reason, and the preview then shows `FIXED_TERM_DIFFERS_FROM_PLAN` with the plan end.
- **Projection.** `term_started_at` is the start of the local start day. `term_ends_at` is the start of the local day after the inclusive end date (NULL when open-ended). Examples:
  - America/Los_Angeles 2027-03-14 → 08:00Z;
  - 2027-11-07 inclusive → ends 2027-11-08T08:00Z;
  - America/Santiago 2026-09-06 → 04:00Z (local midnight does not exist);
  - America/Havana 2027-03-14 → 05:00Z.
- **Effective status.** `ACTIVE` is the confirmed lifecycle state. The derived effective status is SCHEDULED before the start, IN_EFFECT from the start to the end instant (exclusive), ENDED after, CANCELLED when cancelled, and UNDATED for pre-0177 ACTIVE rows without a start.
- **Validation.** An invalid school timezone fails closed (`SCHOOL_TIMEZONE_INVALID`). Calendar-invalid dates are refused (400).

### Future-dated memberships: what is and is not verified

- **Verified:** a future start is recorded as ACTIVE with effective status SCHEDULED, exact school-local instants, and the transition at the next local midnight across DST (proof section 4).
- **Verified:** no booking, attendance, ClassPass, kiosk or check-in path reads `hon.memberships`. A SCHEDULED membership therefore grants no benefit today. A static guard in the proof fails if any new function, view or API file starts reading memberships before it is reviewed for effective dates.
- **Not claimed.** These lifecycle-state readers still count or show a SCHEDULED membership as ACTIVE:
  - the operations report `membershipsActive`;
  - the parent billing view (`read_parent_billing_view`);
  - the school command center and health score;
  - retention signals;
  - renewal facts;
  - revenue planning.

  Aligning them with the effective status is E1b and Codex work. Until then, schools should be told that a future-dated activation is "confirmed, starts on <date>".

## Permissions (D30a): assignment and revocation

| Permission | Used by | Initially granted to |
|---|---|---|
| `billing.membership.activate` (existing) | preview and confirm | unchanged |
| `billing.membership.activation.override` | documenting a `CRM_IDENTITY_REVIEW_PENDING` override (always together with activate at the same school) | every role that held `billing.membership.activate` when 0177 ran, and every system OWNER role |
| `billing.membership.rules.manage` | reserved for E1c (unused) | same |
| `billing.membership.change.approve` | reserved for E1c (unused; E1c must enforce requester ≠ approver) | same |

**Assigning.**
- New organizations get all three automatically, because HQ provisioning grants the OWNER role every permission.
- For delegated staff, a school owner adds the permission to a school-scoped custom role (`iam.custom_role.create` or `iam.custom_role.update`, from 0059; all three are `is_staff_assignable`) and grants that role at the school (`iam.staff_role.grant`).
- Authority is always evaluated at the exact school of the request. A grant at another school, an HQ grant, a family grant or a family/HQ/system role never counts.

**Revoking.** Remove the permission from the role (`iam.custom_role.update`) or end the staff role grant (`iam.staff_role.revoke`). Both take effect immediately: the next preview, confirmation or replay re-checks live, including during a lock wait (proven). An override replay fails with `ACTIVATION_OVERRIDE_FORBIDDEN` once the override permission is gone.

**Required combinations.**
- override without activate grants nothing;
- activate without override cannot confirm a membership with a pending identity review;
- cancellation needs `billing.membership.cancel`.

## Proofs

- `packages/database/scripts/test-membership-activation-gate-integrity.mjs` (CI, `flexible-billing-accounts` fixture). Its 334 assertions cover:
  - exact bodies, ACLs and the `011` verifier section;
  - D41 privileges, and the trigger against the owner with forged settings;
  - the D30a mapping replayed in a rolled-back transaction;
  - owner, delegated, override and denied actors;
  - forged database markers;
  - revocation during the IAM wait and before replay;
  - D29a with concurrent same-key confirmation;
  - D3 and minors, dates and DST;
  - two-step staleness, idempotency (including purged records and pre-0177 keys) and parallel staff;
  - activation vs cancellation;
  - the cancellation fingerprint byte-compatibility and legacy replay;
  - 52 money, consent and automation tables unchanged across 153 guarded commands and previews (previews write nothing at all);
  - the static benefit-path guard.
- `test-crm-owner-launch-lock-order-integrity.mjs`: activation joins the matrix at seven stages (1,422 interleavings, zero failures).
- Updated to use two-step activation or owner fixture seeding:
  - `test-crm-lead-registration-recovery-integrity.mjs`;
  - `test-crm-guardian-child-enrollment-integrity.mjs`;
  - `test-crm-adult-membership-draft-integrity.mjs`;
  - `owner-launch-membership-draft-proof.mjs`;
  - `owner-launch-membership-draft-confirmation-proof.mjs`.
- `apps/api/test/membership-activation.test.cjs`: mocked API boundary (9 tests).
- The old manual proofs `test-billing-membership-activation-integrity.mjs` and `test-billing-membership-cancellation-integrity.mjs` were replaced by the new proof.
