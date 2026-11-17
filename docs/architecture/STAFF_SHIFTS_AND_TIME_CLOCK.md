# Staff shifts and time clock (SH / TC)

Status: spec and plan (2026-11-17). Owner request (David, 2026-11-17): "staff doesn't have scheduler for shifts and hour
tracking". Verified on main a1d8d29: no shift, time clock or timesheet table, function, route or screen exists. What exists
and is reused: staff eligibility and weekly availability (0077), the staff pick list rules (0404), the Roles & permissions
checklist (0412 + `staff-permissions/catalog.ts`), and the calendar date maths (`school-calendar/range.ts`).

Two migrations, two PRs:

| Piece | Migration | What |
|---|---|---|
| SH shift schedule | 0464 | Owners/managers put staff on shifts in a week view; staff see their own shifts. |
| TC time clock | 0465 | Staff clock in/out (and breaks) from their own signed-in app; owners review, correct, approve and export timesheets. |

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
  9:02 AM / On break since 12:30 PM), today's shift if any, and one button at a time: Clock in, Start break, End break,
  Clock out. The time is always the server's clock, never the device's. Below: this week's entries and hours.
- **Timesheets** for managers (`staff.timesheet.manage`): pick a week; one row per person with each entry (in, out,
  breaks, worked hours), the week total, scheduled hours for comparison, and flags: Still clocked in, Over 8 h in a day,
  Over 40 h in the week (overtime flags, no pay maths), Missing clock-out over 16 h.
- **Fix an entry** (managers): add a missed entry or change an entry's in/out time or breaks, with a required reason.
  Every change is kept as an append-only revision (who, when, before, after, why).
- **Approve week** per person locks that person's entries for that week; **Reopen** unlocks it (both audited).
- **Export CSV** of the shown week (one line per entry plus a total line per person), built in the browser from the
  same verified read. Cells that start with `= + - @` are prefixed so spreadsheets never run them.

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

## 3. SH (0464) data and functions

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

## 4. TC (0465) data and functions

- Permissions: `staff.time.clock` (staff-assignable; OWNER), `staff.timesheet.manage` (sensitive, staff-assignable; OWNER).
- `hon.staff_time_entries(id, org, school, principal_id, clock_in_at, clock_out_at, origin CLOCK|MANAGER, shift_id,
  version, ...)`; at most one open entry per person (partial unique index).
- `hon.staff_time_breaks(entry_id, seq, started_at, ended_at)`; at most one open break per entry; within the entry.
- `hon.staff_time_entry_revisions` (append-only: before/after JSON, reason, actor, recorded_at).
- `hon.staff_timesheet_weeks(org, school, principal_id, week_start, status APPROVED|OPEN, version, approved_by, approved_at)`.
- `hon.staff_time_clock_punch(subject, {action, expectedVersion}, key, request, correlation)` with action
  CLOCK_IN | BREAK_START | BREAK_END | CLOCK_OUT, at `clock_timestamp()`. Clock out closes an open break. Clocking into
  an approved week is refused (`TIMESHEET_APPROVED`).
- `hon.read_my_time_clock(subject)` → status, open entry, today's shift, this week's entries.
- `hon.read_staff_timesheet_week(subject, weekStart)` → per person entries with breaks, worked minutes, scheduled minutes,
  approval state.
- `hon.save_staff_time_entry(subject, input, key, request, correlation)` (manager fix; reason 3..300 chars required).
- `hon.set_staff_timesheet_week(subject, {staffPrincipalId, weekStart, action APPROVE|REOPEN, expectedVersion}, ...)`.
- Overtime/flags computed by one pure contract function (`summarizeTimesheet`) used by the page and the CSV, tested.

## 5. Tests

- DB proof per migration (`test-staff-shifts-integrity.mjs`, `test-staff-time-clock-integrity.mjs`) on the disposable
  local fixture: RLS/ACL, manage vs own vs none, other school, non-staff target, HQ/family/delegation refused, overlap
  under two concurrent sessions, idempotent replay and key reuse, version conflict, cancelled shift immutable,
  time-zone conversion (DST week), entitlement lapse refused; TC: one open entry under concurrency, break order,
  approved-week lock, revision history append-only, server clock only.
- API unit tests (`apps/api/test/staff-shifts.test.cjs`, `staff-time-clock.test.cjs`): human-only, closed codes, verified
  answers, no DB call on bad input.
- Contract tests for validators and `summarizeTimesheet`; web UI tests for both pages (manage, own-only, denied, errors).

## 6. Plan

1. SH: contracts (`staff-shifts.ts`) + tests → 0464 + DB proof → API controller/service/guards + tests → web page
   (`staff-shifts/`) + route + catalog labels + tests → docs/plumbing (checksums, staging manifest, 010/011, verify-rls,
   proof runner) → PR, independent review.
2. TC: same order for 0465 on top of SH (stacked branch), then PR, independent review.
