# HON Staff app S1 — Today (spec)

Status: S1a (server) built 2026-11-22; S1b (app screen) next PR. Owner ask: David, 2026-11-22 ("Ok let's build", "Ok"
to Today next). Plan: `/mnt/project-files/staff-app/STAFF_APP_PLAN.md` phase S1. Builds on S0
(`STAFF_MOBILE_SIGN_IN.md`). **Security-material: widens the staff app route allow-list; goes on the pre-launch risk
list with S0.**

## What Today does
For the school the person chose at sign-in (memory only, never authority):
1. Today's classes, from the school-local today, in start order (the existing forward-paging class list).
2. Tap a class: its roster (booked and recorded students) and mark each one Present, Late, Excused or Absent.
   **Add a student** (owner, 2026-11-22 04:16Z: "For roster, have way to add student by searching"): search the school's
   active students by name and mark one present as a walk-in (a booking is never required to attend).
3. My clock: clocked in or out right now, and a button to clock in or out.

Nothing else: no booking, no class changes, no timesheet edits or approvals, no other person's clock.

## Routes added to the staff app allow-list (S1a)
`STAFF_MOBILE_ROUTES` in `apps/api/src/foundation/hon-identity.service.ts`. From S1 every entry also names its exact
methods (S0 entries keep any method, as reviewed). Paths are anchored, segment-exact, with UUID segments only, query
ignored, matched case-sensitively (an upper-cased path fails closed).

| Method | Path under `/v1/organizations/:org/schools/:school` | Permission the route re-decides live |
|---|---|---|
| GET | `/schedule/sessions/list` | `schedule.session.read` |
| GET | `/schedule/sessions/:session/roster` | `attendance.record` |
| GET, POST | `/schedule/sessions/:session/attendance` | `attendance.record` |
| GET, POST | `/staff/time/clock` | `staff.time.clock` (own clock only) |
| GET | `/pickers/students?for=attendance&search=` | `attendance.record`; the controller refuses every other `for` from a native session (403 `MOBILE_SESSION_SCOPE`) |

Still refused with 403 `MOBILE_SESSION_SCOPE`: every other method on these paths, the other pick lists (enrollments,
staff, ranks, testing), timesheet weeks, entries and
approvals, bookings, people, and every other organization, HQ and parent route. The family app reaches none of them.

## Transport guards
- **Class list** (`ClassSessionsReadHumanUiGuard`, and `ClassSessionPagesHumanUiGuard` which extends it) was
  browser-only. New native rule, only when the identity guard verified a staff bearer (`honChannel === 'MOBILE'` and
  `honMobileApp === 'STAFF'`): GET only, **no** Origin and **no** `Sec-Fetch-*` header at all (a browser always sends
  them), the exact `X-HON-Human-Read: class-sessions`, no other `x-hon-*` header, no authority header except the
  verified `Authorization` bearer, the same proxy-host and selector rules. Web, family and unmarked requests are
  unchanged: Authorization stays refused for them.
- **Roster**: identity guard only (unchanged).
- **Attendance** (`AttendanceHumanUiGuard`) and **clock** (`StaffTimeRead/PunchHumanUiGuard`): unchanged. Their GETs
  already pass, and their POSTs already have the native rule from the family app (M2): POST, no Origin or
  Sec-Fetch-Site, exact `X-HON-Human-Command` (`attendance`, `staff_time.punch`), JSON body. Idempotency keys are
  required as on the web.

Sign-in grants nothing. Each route resolves school and permission from the database on every call (forced RLS,
definer functions). A person without the permission gets the same 403 as on the web; the app shows it per section.

## S1b app (next PR)
`apps/staff-mobile`: a Today screen in the Atoms layout with HON colours. Its own closed verifiers for the class page,
roster page, attendance record and clock (from `@hon/contracts` where they exist: `verifyCurrentSchoolClassSessionItems`,
`verifyMyTimeClock`, `verifyTimeEntryReceipt`). Each section has its own "not available for your role" state (review
P3 from S0b), 401 wipes the token. One idempotency key per unchanged mark or punch, reused on retry. A changed mark
re-reads the record first and sends its version (same as the web roster).

## Tests
- API `apps/api/test/staff-mobile-today.test.cjs`: each route and method admitted for the staff app and marked STAFF;
  other methods, look-alikes, non-UUID and neighbouring routes refused; family refused; class-list native rule (no
  browser metadata, exact read header, authority headers, proxy host, body/selector rules); Authorization admitted only
  for the verified staff app; attendance and punch native command rule with exact command names.
- Existing `class-sessions-read.test.cjs` (browser rule) unchanged and passing.
