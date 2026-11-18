# Staff shifts and time clock (SH / TC)

Status: spec and plan (2026-11-17). Owner request (David, 2026-11-17): "staff doesn't have scheduler for shifts and hour
tracking". Verified on main a1d8d29: no shift, time clock or timesheet table, function, route or screen exists. What exists
and is reused: staff eligibility and weekly availability (0077), the staff pick list rules (0404), the Roles & permissions
checklist (0412 + `staff-permissions/catalog.ts`), and the calendar date maths (`school-calendar/range.ts`).

Two migrations, two PRs:

| Piece | Migration | What |
|---|---|---|
| SH shift schedule | 0467 | Owners/managers put staff on shifts in a week view; staff see their own shifts. |
| TC time clock | 0478 | Staff clock in/out from their own signed-in phone or computer; hours only; owners review, correct, approve and export timesheets. |
| TC follow-up | 0501 | No self-approval: a timesheet manager cannot approve their own week; the school's system OWNER is exempt. |

Out of scope: payroll providers, pay rates and pay calculation, paid services, texting/emailing staff about shifts,
a shared front-desk PIN tablet, GPS/location checks. Nothing here sends a message, charges, or calls AI.

## 1. What people see

### Staff > Shifts (`/staff/team/shifts`)

- **Managers** (`staff.shift.manage`): a Monday-to-Sunday week, one row per staff member (from the school's eligible
  staff, display name only) and one column per day. Each shift shows its time (school time zone) and optional position
  ("Front desk", "Instructor"). Previous / This week / Next week. Total scheduled hours per person and per day.
- **Add shift**: pick the person, date, start and end (end after start on the same day, 15 minutes to 16 hours),
  optional position (up to 40 characters) and note (up to 300). **Edit** changes the same fields. **Cancel shift** keeps
  the row as cancelled (history stays; cancelled shifts are hidden by default).
- A shift that overlaps another scheduled shift of the same person is refused ("Overlaps another shift").
- A shift outside the person's saved weekly availability (0077) still saves but shows "Outside availability" (warning
  only, no block) — read is optional and is skipped when availability has never been saved.
- **Staff without manage** (`staff.shift.view_own`): the same week view with only their own row. Nothing to edit.

### Staff > Hours (`/staff/team/hours`)

- **Time clock** card for the signed-in staff member (`staff.time.clock`): status (Off the clock / On the clock since
  9:02 AM), today's shift if any, and one button at a time: Clock in or Clock out. The time is always the server's clock, never the device's. Below: this week's entries and hours.
- **Timesheets** for managers (`staff.timesheet.manage`): pick a week; one row per person with each entry (in, out,
  worked hours), the week total, scheduled hours for comparison, and two data checks: Still clocked in, and an entry
  over 16 h (usually a missed clock-out). No breaks, no overtime rules, no pay maths.
- **Fix an entry** (managers): add a missed entry or change an entry's in/out time, with a required reason.
  Every change is kept as an append-only revision (who, when, before, after, why).
- **Approve week** per person locks that person's entries for that week; **Reopen** unlocks it (both audited). Nobody approves their own week unless they hold the school's system OWNER role (0501, `TIMESHEET_SELF_APPROVAL`); reopening and fixing one's own entries are unchanged.
- **Export CSV** of the shown week (one line per entry plus a total line per person), built in the browser from the
  same verified read. Columns: Staff, Date, Clock in, Clock out, Worked hours, Scheduled hours, Notes. Cells that start with `= + - @` are prefixed so spreadsheets never run them.

Staff get these by role: owners hold all four permissions; an owner gives `staff.shift.view_own` and `staff.time.clock`
to instructor/front-desk roles with the existing Roles & permissions checklist (new plain labels are added there).

## 2. Design rules (both migrations)

- Private tables, forced RLS, no policies, no runtime table privilege; the runtime gets EXECUTE on fixed SECURITY DEFINER
  entry points only (the 0392 shape). Canonical runtime ACL mirrored in `infra/postgres/010` and verified in `011`.
- Direct human only: `HUMAN_USER`, `HUMAN_UI`, no action request, no delegation, external subject equals the session
  subject, actor re-proved after locks. Live ESSENTIAL/CORE/COMPLETE entitlement, active school and organization.
- The target of a shift or time entry must be eligible staff at this exact school (`hon.staff_member_eligible`).
- Commands are idempotent (`hon.idempotency_records`, fingerprinted input, exact replay, key reuse refused), versioned
  (expectedVersion, `VERSION_CONFLICT`), audited (`hon.audit_events`) with an inert outbox event.
- Times: shifts are stored as `timestamptz`; input is a school-local date + `HH:MM` start/end, converted with
  `hon.schools.timezone` in the database. Reads return both the instant (UTC ISO) and the school-local date/time.
- Per-person writes take `pg_advisory_xact_lock(hashtextextended('hon.staff_shifts:'||principal,0))` so two overlapping
  saves cannot both pass the overlap check.
- Read windows are bounded (one week per read, at most 500 shifts / 1,000 time entries).

## 3. SH (0467) data and functions

- Permissions: `staff.shift.manage` (sensitive, staff-assignable; OWNER), `staff.shift.view_own` (staff-assignable; OWNER).
- `hon.staff_shifts(id, organization_id, school_id, principal_id, starts_at, ends_at, local_date, position, note,
  status SCHEDULED|CANCELLED, version, created_by, updated_by, created_at, updated_at)`; CHECK 15 min..16 h; never
  deleted; scope, person, creator and creation time never change; each update is version+1.
- `hon.read_staff_shift_week(subject, weekStart date)` → `{ mode: MANAGE|OWN, weekStart, timezone, staff: [{principalId,
  displayName}], shifts: [...], availability: [{principalId, windows}] }`. weekStart must be a Monday.
- `hon.save_staff_shift(subject, input, key, request, correlation)`, input
  `{ shiftId|null, expectedVersion, staffPrincipalId, date, start, end, position|null, note|null, status }`.
  Create = shiftId null + expectedVersion 0 + SCHEDULED. A cancelled shift cannot be reopened or edited (add a new one).
  Errors: `VALIDATION_FAILED`, `STAFF_SHIFT_FORBIDDEN`, `STAFF_MEMBER_UNAVAILABLE`, `SHIFT_OVERLAP`, `VERSION_CONFLICT`,
  `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`, `TIER_ENTITLEMENT_REQUIRED`.

## 4. TC (0478) data and functions (as built)

Owner decisions (David, 2026-11-17): staff clock in and out from their **own signed-in phone or computer** (no shared
kiosk); timesheets are **hours only** (clock in and out; total hours per entry, per day and per week; no breaks, no
overtime flags, no pay calculation).

- Permissions: `staff.time.clock` (staff-assignable; OWNER), `staff.timesheet.manage` (sensitive, staff-assignable; OWNER).
- `hon.staff_time_entries(id, org, school, principal_id, local_date, timezone, clock_in_at, clock_out_at,
  origin CLOCK|MANAGER, version, created/updated by and at)`. Worked minutes = floor((out - in) / 1 min).
  At most one open entry per person per school (partial unique index); an entry is at most 24 hours (CHECK). Never
  deleted; scope, person, origin, creator and creation time never change; each update is version+1.
- `hon.staff_time_entry_revisions` (append-only: entry version, before/after JSON, reason 3..300, actor, recorded_at),
  written for every manager add or fix.
- `hon.staff_timesheet_weeks(org, school, principal_id, week_start, status APPROVED|OPEN, version, decided_by, decided_at)`;
  never deleted, every decision flips the status and is version+1.
- `hon.staff_time_clock_punch(subject, {action, expectedVersion}, key, request, correlation)` with action
  CLOCK_IN (expectedVersion 0) | CLOCK_OUT (the open entry's version), at `clock_timestamp()`. Clocking into an approved week is refused (`TIMESHEET_APPROVED`). A clock-out more
  than 24 hours after clock-in is refused (`TIME_ENTRY_TOO_LONG`); a manager closes that entry with a fix.
- `hon.read_my_time_clock(subject)` → `{timezone, now, weekStart, open, todayShifts, entries, approval}`.
- `hon.read_staff_timesheet_week(subject, weekStart)` → per person entries with worked minutes, scheduled minutes
  (0467 SCHEDULED shifts), approval state.
- `hon.save_staff_time_entry(subject, {entryId|null, expectedVersion, staffPrincipalId, clockIn, clockOut,
  reason}, ...)`: school-local `YYYY-MM-DDTHH:MM`, ends by now, at most 24 hours, no overlap with the person's other
  entries at the school, neither the old nor the new week approved. A fix may close a forgotten open entry.
- `hon.set_staff_timesheet_week(subject, {staffPrincipalId, weekStart, action APPROVE|REOPEN, expectedVersion}, ...)`;
  APPROVE is refused while the person has an open entry that week (`TIMESHEET_HAS_OPEN_ENTRY`). APPROVE of one's own week (target = actor) is refused with `TIMESHEET_SELF_APPROVAL` (42501) unless the actor holds a live system OWNER grant at that school (0501, decided after the per-person lock).
- Errors: `VALIDATION_FAILED`, `STAFF_TIME_FORBIDDEN`, `STAFF_MEMBER_UNAVAILABLE`, `TIME_ENTRY_NOT_FOUND`,
  `TIME_CLOCK_STATE_CHANGED`, `TIME_ENTRY_TOO_LONG`, `TIMESHEET_APPROVED`, `TIMESHEET_HAS_OPEN_ENTRY`, `TIME_ENTRY_OVERLAP`,
  `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`.
- API: `GET|POST .../staff/time/clock`, `GET .../staff/time/weeks/:weekStart`, `POST .../staff/time/entries`,
  `POST .../staff/time/weeks`; commands `staff_time.punch`, `staff_time.entry.save`, `staff_timesheet.decide`.
- Totals and the two data checks computed by one pure contract function (`summarizeTimesheet`) used by the page and the CSV, tested.

## 5. Tests

- DB proof per migration (`test-staff-shifts-integrity.mjs`, `test-staff-time-clock-integrity.mjs`) on the disposable
  local fixture: RLS/ACL, manage vs own vs none, other school, non-staff target, HQ/family/delegation refused, overlap
  under two concurrent sessions, idempotent replay and key reuse, version conflict, cancelled shift immutable,
  time-zone conversion (DST week), entitlement lapse refused; TC: one open entry under concurrency, no break fields or actions,
  approved-week lock, revision history append-only, server clock only.
- API unit tests (`apps/api/test/staff-shifts.test.cjs`, `staff-time-clock.test.cjs`): human-only, closed codes, verified
  answers, no DB call on bad input.
- Contract tests for validators and `summarizeTimesheet`; web UI tests for both pages (manage, own-only, denied, errors).

## 6. Plan

1. SH: contracts (`staff-shifts.ts`) + tests → 0467 + DB proof → API controller/service/guards + tests → web page
   (`staff-shifts/`) + route + catalog labels + tests → docs/plumbing (checksums, staging manifest, 010/011, verify-rls,
   proof runner) → PR, independent review.
2. TC: same order for 0478 on top of SH (stacked branch), then PR, independent review.
