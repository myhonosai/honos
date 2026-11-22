# Class booking identity plane and lifecycle (0631)

Source: launch-readiness review pinned to main `0d476427`, finding **P2 — booking authority and lifecycle**. Owner instruction (David, 2026-11-22): fix the review's findings before more features.

## Problem (verified on main `0cab219`)

- `hon.lock_class_booking_session` (0118) is the command-side gate for staff booking (`ClassBookingService`), owner-launch first booking (0137, last replaced in 0538 to count kiosk trial seats). It checked subject, human source, a single active `HUMAN_USER` principal, active school and organization, `schedule.booking.manage` and entitlement. It did **not** apply the identity-plane exclusions that 0147 class-session discovery applies: no HQ operator grant, no active family access grant, no family/HQ/platform-shaped role held anywhere, and a granting role that is not itself family shaped. `hon.resolve_authorized_scope` (the API preflight) does not apply them either. So a mixed identity that also held booking permission could book sessions that discovery refuses to show it. This is not a family-only escalation: booking permission was still required.
- `ClassBookingService.create` refused `CANCELLED` sessions but accepted new bookings into `COMPLETED` ones, which the UI hides.

## Contract

- **BL1** The user has exactly one active principal of any type (0147's count). Non-human principals carry no `user_id`, so in practice this equals the old HUMAN_USER count; it is kept identical to discovery so the two cannot drift.
- **BL2** The lock refuses an HQ operator grant, an active family access grant, an active grant of a role whose code matches `^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)` (case-insensitive, at any school), and booking permission held only through such a role. It runs on both sides of the session row lock, as before. All callers of the lock get the same rule.
- **BL3** Signature, return facts, definer posture, search path, volatility, lock order and ACL are unchanged; 0631 restates the ACL.
- **BL4** A new staff booking into a `COMPLETED` session is refused with 409 `SESSION_COMPLETED`, after the lock and next to the `CANCELLED` check, so nothing is written. An exact idempotent replay returns its stored receipt before that check (after the lock re-checks live authority), so history stays replayable.

## Proofs

- `apps/api/test/class-booking.test.cjs`: COMPLETED refused with no insert, audit or outbox statement; exact replay into a COMPLETED session returns the receipt; CANCELLED unchanged.
- `packages/database/scripts/test-class-booking-identity-plane-integrity.mjs` (disposable CRM-close fixture, real service and lock): the four BL2 refusals with nothing written, the ended/revoked counterparts allowed, BL4 refusal and replay, the lock verifier with its negative mutations, and the 0631 `011` section. With the 0118 lock body restored the proof fails with "HQ operator grant: expected 403, got a booking".
- Existing callers re-run: parent class booking, kiosk trial class and trial seats, owner launch.

## Not changed

Owner-launch first booking (`hon.book_owner_launch_first_class`, last replaced in 0538) still refuses only `CANCELLED` itself; it was not part of this finding. It now gets the BL2 identity rule through the lock. Parent booking (0329) has its own family-plane path and does not call this lock; the kiosk tablet does not call it either.
