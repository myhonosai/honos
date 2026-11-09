# Membership pause, cancellation and refund records (0224)

Owner policy, 2026-11-08 21:44Z (decision cards in the CRM and enrollment backend thread):

| | Decision | What 0224 does |
|---|---|---|
| P1 | Only school staff pause a membership, on the member's request | `billing.membership.pause` (staff-assignable, sensitive). No family or member route. |
| P2 | Each school sets its own pause limits | A versioned per-school policy: whether pauses are offered, the longest single pause, paused days per rolling 365 days, and an optional hold fee. |
| P3 | Cancellation takes effect immediately | The existing 0177 cancel command, unchanged contract, now also accepts a paused membership. |
| P4 | No automatic refund; staff can record one | `billing.membership.refund.record`: evidence of a refund the school made outside HON. |

**Nothing here moves money.** The hold fee is recorded policy only. No charge, invoice, schedule, provider call or refund is created, changed or sent. Live payments stay off until the owner approves them.

## Routes

All routes sit under `/v1/organizations/:organizationId/schools/:schoolId/billing`. Each route resolves its scope from the verified session. The protected database function then re-proves the direct human subject and the live school-scoped permission before the write, after every lock wait, on replay and before return.

| Method and path | Permission | Browser command header |
|---|---|---|
| `GET membership-pause-policy` | pause, pause_policy.manage or billing.membership.read | (GET) |
| `POST membership-pause-policy` | `billing.membership.pause_policy.manage` | `billing.membership.pause_policy.set` |
| `POST memberships/:id/pause` | `billing.membership.pause` | `billing.membership.pause` |
| `POST memberships/:id/resume` | `billing.membership.pause` | `billing.membership.resume` |
| `POST memberships/:id/cancel` (0177) | `billing.membership.cancel` | `billing.membership.cancel` (same-origin browser guard added with the staff screen; body and receipt unchanged) |
| `POST memberships/:id/refund-records` | `billing.membership.refund.record` | `billing.membership.refund.record` |
| `GET memberships/:id/pauses-and-refunds` | billing.membership.read, pause or refund.record | (GET) |

Every POST needs an `Idempotency-Key`. An exact retry returns the stored receipt with `replayed: true`. Reusing the key for a different body returns 409 `IDEMPOTENCY_KEY_REUSED`. Reads refuse an `Idempotency-Key` and any query string. Types and strict verifiers are in `@hon/contracts` (`membership-pauses.ts`).

## Rules

- **Policy:** `{ expectedVersion, pausesAllowed, maxPauseDays, maxPausedDaysPerYear, holdFee: { amountMinor, currency } | null }`.
  - `expectedVersion` is the current version, or 0 when the school has none.
  - Limits run from 1 to 365 days. One pause may not exceed the yearly cap.
  - A school with pauses off has no limits and no fee.
  - Until a school sets a policy, pausing is refused with 409 `MEMBERSHIP_PAUSE_NOT_OFFERED`.
- **Pause:** `{ expectedVersion, resumeOn, pauseReason }`.
  - Only an ACTIVE membership can be paused. The pause starts on the school's local today.
  - `resumeOn` must be after today and within `maxPauseDays`. Otherwise the pause is refused with 422 `MEMBERSHIP_PAUSE_TOO_LONG`.
  - **Rolling year (0231, owner decision 2026-11-09).** Only paused days that fall within the last 365 days (the school's local today included) count. A past pause that started before that window counts only its days inside it. Those days plus this pause must stay within `maxPausedDaysPerYear`. Otherwise the pause is refused with 422 `MEMBERSHIP_PAUSE_YEARLY_LIMIT`.
  - The window is taken at today. While the new pause runs, older days only leave the window, so the check is never looser than a day-by-day rolling count.
  - A membership with an ACTIVE payment schedule cannot be paused, because the schedule would keep charging. It returns 409 `MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT` until the billing arrangement workflow exists.
  - The membership goes from ACTIVE to FROZEN at version + 1. The hold fee in force is copied onto the pause row as evidence.
- **Resume:** `{ expectedVersion, resumeReason? }`. A FROZEN membership goes back to ACTIVE today, and its pause row is closed as RESUMED.
- **Cancel:** a FROZEN membership's open pause is closed as CANCELLED in the same step. The audit event records the real prior state.
- **Term dates never change on pause, resume or cancel.**
  - A paused membership's end date is not extended. Extending it is a follow-up policy question.
  - A pause past its `resumeOn` stays FROZEN until staff resume it. Nothing resumes it automatically.
- **Memberships frozen before 0224 have no pause row.** Resume and cancel refuse them with 409 `MEMBERSHIP_PAUSE_EVIDENCE_MISSING`, rather than invent evidence.
- **Refund record:** `{ amountMinor, currency, refundedOn, method, reason }`.
  - `method` is one of CASH, CHECK, CARD_TERMINAL, BANK_TRANSFER or OTHER.
  - Only a CANCELLED membership qualifies. Otherwise the record is refused with 409 `MEMBERSHIP_NOT_CANCELLED`.
  - `refundedOn` must fall between the membership's creation and the school's local today.

## Database boundary

- **Tables:** three new private tables with forced RLS and no runtime privilege.
  - `school_membership_pause_policies` and `membership_refund_records` are immutable.
  - `membership_pauses` can have only its end columns set, and only once.
- **Transition trigger:** the 0177/0178 trigger on `hon.memberships` gains three branches.
  - ACTIVE to FROZEN requires the open pause row for exactly that version step.
  - FROZEN to ACTIVE requires that row closed as RESUMED; FROZEN to CANCELLED requires it closed as CANCELLED.
  - Term dates must be unchanged in every one of these transitions.
  - Every earlier branch is unchanged. The migration refuses to run unless the four bodies it replaces hash to the reviewed 0177/0178 versions.
- **Runtime privileges:** the runtime gets EXECUTE on six new entry points. It keeps EXECUTE on cancel and gains nothing on `hon.memberships`.
- **Pinning:** `010` reconciles the grants. `011` pins every body hash, trigger and permission.
- **Lock order:** follows 0169/0177. Key reservation, IAM SHARE, the membership row FOR UPDATE, then policy and schedules SHARE (the row lock alone serializes one membership's pause, resume and cancel), then evidence, membership, audit and outbox.

## Proof

`packages/database/scripts/test-membership-pause-integrity.mjs` runs in `.github/scripts/run-db-proofs.sh` on the crm-lead-close fixture, over signed HTTP through the real Nest controllers. It covers:

- policy validation, versioning and replay;
- pause, resume and cancel effects;
- per-pause and per-year limits;
- the schedule block and the legacy FROZEN refusal;
- refund records, history, isolation, transport, and live loss of permission, school or entitlement;
- trigger refusals for direct owner writes, the exact runtime ACL, and no invoice, payment attempt or schedule change.

## Permissions

The three new permissions go to system OWNER roles only. Owners grant them to staff roles per school.

## Staff screen

`/staff/billing/membership-changes` (Memberships & Billing → Pause, cancel & refunds) is the only browser caller. It shows the school's pause rules (with a form to change them), a membership picker over the school's ACTIVE, paused and cancelled memberships, and for the chosen membership its pauses, refund records and only the actions its current state allows. Every command answer is followed by fresh reads; an unknown outcome keeps the exact request in memory so Try again replays the same key. Blur, a hidden tab, a school change or a session end hide it and drop any kept request.
