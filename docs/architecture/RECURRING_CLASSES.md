# Recurring weekly classes and the weekly timetable (B-SCH-1, migration 0239)

Status: source only. Not deployed. Nothing here runs on a timer, contacts a family, sends a message, charges, or runs an
automation. Sessions are created only when a staff member asks for them.

## Rules (recommended option on the owner decision card, 2026-11-09; proceeding on it until the owner answers)

| Rule | Behavior |
| --- | --- |
| S1 | A class series is a weekly pattern in **school time** (school time zone): program, name, optional room, capacity, booking policy, one to seven weekdays, a start time to the minute, a length of 5 to 600 minutes, a first date and an optional last date. Staff with `schedule.session.manage` at the current school create and manage it. No new permission. |
| S2 | Sessions are created by an explicit **fill**, from today up to **12 weeks** (84 days) ahead, never by a timer. A date whose start time does not exist (spring-forward gap) is skipped and reported. A fill never creates a session that already exists for that date, and never one that would start in the past. |
| S3 | **Change** replaces the pattern (program and first date stay). Upcoming unbooked sessions of the series follow the new name, room, capacity, policy and time; ones on days no longer in the pattern, after a new last date, in a DST gap, or that would now start in the past are cancelled with a reason. A session with any non-cancelled booking or any attendance is **never moved or cancelled** and is reported as kept. |
| S4 | **End** sets a last date (today − 1 or later) with a reason. Unbooked sessions after it are cancelled; booked or attended ones are kept. An ended series is final, kept and shown as ended. Nothing is deleted. |

## Database (0239)

- `hon.class_series`: private, forced RLS, no runtime privilege. `guard_class_series` (settings-free) allows an insert only
  at version 1, ACTIVE, with no fill yet and distinct weekdays; an update must step the version by one, keep id, school,
  program, first date, creator and creation time, never reopen an ENDED series, and never lower `generated_through`. No delete.
- `hon.class_series_occurrences`: one row per (series, school-local date) linking to the `hon.class_sessions` row; immutable,
  no delete, no truncate. Sessions outside a series are never read or changed by series commands.
- Runtime entry points (EXECUTE only): `create_class_series`, `revise_class_series`, `end_class_series`, `fill_class_series`,
  `read_school_class_series` (manage) and `read_school_weekly_timetable` (the 0147 `schedule.session.read` actor). Each command
  re-proves the direct human subject (HUMAN_USER, HUMAN_UI, no action request, no delegation, one active principal,
  staff-eligible, no family/HQ/parent-type role), the live school-scoped permission and an active entitlement, before and after
  its locks, using the 0224 identity rules. The runtime still has no UPDATE on `hon.class_sessions`.
- Commands: exact-request idempotency (24 h), IAM SHARE locks, the series row `FOR UPDATE` and an expected version. One audit
  event and one inert outbox event (`schedule.series.created` / `revised` / `ended` / `filled`) per command.
- Reads: up to 200 series and 200 programs with today, the time zone and the fill limit; the timetable is one Monday-to-Sunday
  school week (default this week), at most 500 sessions in start order, with booked counts.

## API

Under `organizations/:organizationId/schools/:schoolId/schedule` (route ids are not authority; the scope is resolved from the
verified session and re-checked by the database):

| Method | Path | Permission / command header |
| --- | --- | --- |
| GET | `class-series` | `schedule.session.manage` |
| GET | `timetable?weekOf=YYYY-MM-DD` | `schedule.session.read` |
| POST | `class-series` | `schedule.series.create` + Idempotency-Key |
| POST | `class-series/:seriesId/revise` | `schedule.series.revise` + Idempotency-Key |
| POST | `class-series/:seriesId/end` | `schedule.series.end` + Idempotency-Key |
| POST | `class-series/:seriesId/fill` | `schedule.series.fill` + Idempotency-Key |

Responses are `private, no-store`. Every database answer is verified by the `@hon/contracts` verifiers before it reaches a
client; unknown failures are `CLASS_SERIES_UNAVAILABLE`, never success.

## Web

`/staff/schedule/timetable` ("Weekly timetable", Classes menu): the school week day by day with previous / this / next week,
then the school's series with Create sessions, Change and End, and a New class series form. A reader without manage sees the
timetable only; a manager without read sees the series only. An unknown outcome keeps the exact request and key in memory for
Try again; blur, school change and session end conceal the page and drop kept commands. Page text is English only for now (the
menu label has English, Korean and Spanish).

## Evidence

`pnpm --filter @hon/database db:test-class-series` (CI: `run-db-proofs.sh`, CRM-close fixture): 123 checks over signed HTTP,
including create validation and cross-school/org programs, fill limits and replay, two concurrent fills creating each session
once, DST round-trip, the timetable week and school isolation, a booked session kept through change and end, stale version and
ended-series refusals, live grant/school/entitlement loss, browser transport, settings-free triggers, runtime ACL, the 011
section, and no change to sessions outside a series. Web: `apps/web/test/class-series-ui.test.tsx`.

## Residual risks and follow-ups

- Sessions are not filled automatically; a school must use Create sessions to keep the timetable ahead. An automatic weekly
  fill would be a separate, owner-gated automation.
- Changing a series does not notify booked families; the kept sessions keep their old time. Messaging stays separate work.
- Page copy is not yet translated.
