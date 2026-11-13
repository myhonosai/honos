# Class list and attendance-history import (0333)

Onboarding item B6. A school moving from another system stages a CSV, reviews every row, then finalizes. The shape is
the 0226 student import: stage, decide (IMPORT or SKIP per row), finalize the exact IMPORT selection on the current
version. Every write is a direct human command with its own key, audit row and inert outbox event.

## Two kinds

| Kind | Required columns | Optional columns | What finalize creates |
|---|---|---|---|
| `CLASSES` | className, weekdays, startTime, durationMinutes | programName, capacity, roomName, bookingPolicy, startsOn | One ACTIVE weekly class series (0239) per row, under a program matched by name (any case, not cancelled) or a new DRAFT program shared by later rows. "Ongoing" stays off and no session is created; staff fill the timetable with the existing command. |
| `ATTENDANCE` | studentGivenName, studentFamilyName, attendedOn | birthDate, visits, className | One row of imported history for an existing student. |

Stated defaults for classes, shown on review: the program takes the class name, 20 places, walk-in, starting today.
Accepted formats: weekdays as `Mon, Wed`, `Monday/Wednesday` or ISO `1 3`; times as `18:30`, `6:30 PM` or `6pm`;
dates as `YYYY-MM-DD`.

## Rules

- Imported attendance is history only. It is never a class session, booking or attendance record, so no rank, badge,
  retention, reward, automation, message or charge counts it or reacts to it. It reads back per student
  (`GET …/history-imports/students/:profileId/attendance`).
- A student is matched only by exact first and last name (any case) at this school, narrowed by birth date when the row
  gives one. No match or more than one match is an error on the row; nothing is guessed and no student is created.
- Repeats are refused: the same class (name, days and time) twice in a file or already scheduled, and the same student,
  date and class twice in a file or already imported. A program name that only exists as a cancelled program is refused.
- Authority: `students.import` for every import and read; a class import also needs `schedule.session.manage`, so no
  import creates what its sender could not create by hand. Live grant, school, organization and paid access are checked
  before and after the writes. Class finalizes take a per-school advisory lock and re-check "already scheduled".
- Nothing here creates a membership, plan, invoice, payment, enrollment, account, invitation, consent, message, AI call
  or credit effect. Audit and outbox carry identifiers only.
- Four new tables, forced RLS with no policies; the runtime role executes six entry points and holds no table privilege.

Proof: `packages/database/scripts/test-history-import-integrity.mjs` (5 groups). API boundary: `apps/api/test/history-import.test.cjs`.
