# CRM trial authority hold (0629)

Source: launch-readiness review pinned to main `0d476427`, finding **P1 — trial scheduling can outlive staff authorization**. Owner instruction (David, 2026-11-22): fix the review's findings before more features.

## Problem (verified on main `fadf2c0`)

`TrialAppointmentService.schedule` took the per-lead advisory lock, then re-resolved authority with `hon.resolve_authorized_scope` (a plain MVCC read). Statements after that re-check can still wait:

- `INSERT ... ON CONFLICT DO NOTHING` on `hon.idempotency_records` waits for any uncommitted row with the same key;
- the follow-up `SELECT ... FOR UPDATE` on that record waits too.

Nothing held the authority rows during those waits, so a grant revocation, a school or organization suspension, or an entitlement change could commit and the trial still committed afterwards. Tenant-only RLS does not refuse the later write. `TrialAppointmentOutcomeService.record` had the same shape after its appointment row lock. This is stale same-school authority, not a tenant escape.

## Contract

- **TA1 Hold.** `hon.hold_crm_trial_authority(subject)` (SECURITY DEFINER, fixed search path) takes `FOR SHARE` row locks on the organization, school, user, the user's human principals, the actor's grants at this school, their roles and role permissions, and the organization's entitlement row. Order matches the platform IAM lock order (organization → school → user → principals → grants → roles → role permissions → entitlement), the same order the attendance and staff-role functions use, so it cannot form a lock cycle with them. Until the trial transaction ends, an `UPDATE` or `DELETE` of any of those rows waits. A change committed before the hold is visible to the re-check that follows it. New grants are `INSERT`s and only add authority, so they are not held.
- **TA2 Checks.** The hold decides nothing by itself. Lock order in both commands: command serialization lock (lead advisory lock, or the appointment row lock) → hold → `assertCurrentCrmAuthority` + entitlement → idempotency reservation and writes → `assertCurrentCrmAuthority` again just before returning (new command and exact replay). With the hold in place the final check cannot change its answer. It stays as the explicit final check the review asked for.
- **TA3 Refusals.** The hold refuses (42501 `CRM_TRIAL_FORBIDDEN`) a missing tenant context, a non-`HUMAN_USER`/`HUMAN_UI` command, an action-request or delegated command, and a subject that is not the transaction's own principal, before it locks anything. The API maps only that refusal to 403. Any other 42501, such as a missing EXECUTE grant, surfaces as a server error so a misconfiguration is never mistaken for a refusal.
- **TA4 Grants.** The runtime gets EXECUTE on this one function only (`010` section; `011` pins body md5, volatility, definer posture, search path and ACL).

## Proofs

- `apps/api/test/crm-trial-authority-hold.test.cjs`: statement order for schedule (new and replay) and outcome, 403 on a refused hold, 403 when the final check fails.
- `packages/database/scripts/test-crm-trial-appointment-integrity.mjs` (disposable PostgreSQL, real controllers):
  - (a) a command blocked on its idempotency reservation makes a grant revocation, a school suspension and an entitlement suspension each time out (`lock_timeout`, 55P03) instead of committing underneath it. With the hold disabled, this proof fails with "A role grant revocation committed underneath a trial command".
  - (b) a revocation or school suspension that is pending when the command reaches the hold makes it wait. Once that change commits, the command is refused with 403 and writes nothing.
  - The hold refuses another person's subject and a non-human source. The 0629 `011` section passes against the fixture.

## Not changed

The kiosk trial path (WK4, kiosk principal), lead reads and pipeline commands are untouched. They already re-check inside their own transactions and were not part of this finding.
