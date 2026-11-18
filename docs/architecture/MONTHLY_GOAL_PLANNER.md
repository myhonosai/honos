# Monthly goal planner (brief #16; migrations 0503 (was 0370), 0504, 0505)

Owner (David, 2026-11-15): "Monthly goal need to be more detailed with ai help. So it breaks down in not just monetary but
how many appointment, lead, renewal, upgrade needed and give analysis of current student body to renew or upgrade
potential so school owner or program director can plan better."

The planner turns a monthly revenue goal into the renewals, upgrades, new enrollments, shows, appointments and leads the
school needs, using the school's own records, then tracks pace through the month. It never changes prices, memberships or
plans and never sends a message. AI wording uses the fake provider until David approves real AI calls.

## Slices (one small PR each)

| Slice | Migration | What |
|---|---|---|
| G1 | 0503 | Shared private renewals-due helper `hon.school_renewals_due` (also used by the reports renewals forecast, 0372) and the read-only goal plan `hon.read_monthly_goal_plan`: sources, rates with record counts, activity counts needed, pace. Goal passed in the request. API, contracts, DB proof. |
| G2 | none | Staff page `/staff/planning/goal` (Reports menu): goal form, plan, pace, "this week", plain-language explanation from the fake provider. |
| G3 | 0505 | Saved monthly goals per school and optional program (versioned, audited, idempotent), program director slice. |
| G4 | 0504 | Student body analysis: renewal likelihood and upgrade candidates, totals by program for reporting readers and a named list with reasons for staff allowed to see those students. |

## Shared renewals-due helper (0503)

`hon.school_renewals_due(org uuid, school uuid, from timestamptz, to timestamptz, as_of timestamptz)` returns one row per
membership whose term end falls in `[from, to)`. Private: no runtime grant; callers prove authority first.

- **Due**: a non-draft membership whose current term end is in the window, or whose term end before an `EXTENSION` date
  revision (0178 `prior_term_ends_at`) was in the window. `due_at` is the earliest such end. Open-ended memberships (no
  term end) never fall due.
- **Renewed** (`outcome = RENEWED`):
  - `EXTENSION`: an `EXTENSION` revision moved that end later (or made the term open-ended); `renewed_at` = its time.
  - `NEW_MEMBERSHIP`: another non-draft membership of the same participant at the same school, term started after this
    one's start and within 60 days either side of `due_at`, and in the same program when both have one; `renewed_at` =
    its creation time. The earliest such membership is the successor.
- Otherwise `CANCELLED` (state `CANCELLED` or `CANCELLATION_PENDING`), `LAPSED` (`due_at <= as_of`) or `OPEN`.
- Plan facts from the 0175 plan selection: plan id, version, code, program, currency, price, billing frequency, term
  months (null when the membership has no catalog selection).

## Goal plan read (0503)

`GET /v1/organizations/:org/schools/:school/planning/monthly-goal` with optional query `month` (YYYY-MM, 11 months back to
2 ahead, default the current school month), `goalMinor` + `currency`, `historyMonths` (3-12, default 6) and owner
overrides `bookRate`, `showRate`, `closeRate`, `renewalRate` (0 < x <= 1), `avgNewMinor`, `plannedUpgrades`,
`upgradeValueMinor`.

Who: the 0331 rule (direct human with live `reporting.view` at the session school, active school, organization and HON
entitlement). Counts and money totals only: no names, people, invoices or payments leave the function.

History window: the `historyMonths` complete school months before the current month.

- **Suggested goal** (per currency): average monthly collected (recorded payments + online payments - refunds, the 0331
  definitions) over the last 3 complete months, rounded to whole currency units. A suggestion only.
- **Sources** for the goal currency:
  1. `collected`: collected so far in the month.
  2. `scheduled`: ACTIVE payment schedules of ACTIVE memberships with a charge still to come in the month (weekly
     schedules once per remaining week), excluding charges after the membership's term end (those are renewals).
  3. `renewals`: from the helper for the month: due, renewed, cancelled, lapsed, open; expected renewals = open x
     renewal rate; expected value = open priced value x renewal rate.
  4. `upgrades`: `plannedUpgrades x upgradeValueMinor` from the owner (G4 suggests candidates); zero when not given.
  5. `newEnrollments`: the remaining gap divided by the average new membership value.
- **Rates** (each with numerator, denominator and source `RECORDS`, `OWNER` or `INSUFFICIENT`; fewer than 10 records is
  insufficient and the page asks the owner to set it):
  - `renewalRate`: renewed / (due in the history window and no longer open).
  - `bookRate`: leads created in the window with at least one non-cancelled appointment / leads created.
  - `showRate`: appointments in the window COMPLETED / (COMPLETED + NO_SHOW).
  - `closeRate`: leads with a completed appointment in the window that are won / those leads.
  - `avgNewValue`: average plan price of memberships that started in the window and did not renew another one (at least
    5, goal currency).
- **Needed**: renewals = already renewed + expected renewals; new enrollments = ceil(gap / avg new value); shows = ceil(enrollments / closeRate); appointments =
  ceil(shows / showRate); leads = ceil(appointments / bookRate). A count is null when a rate it needs is insufficient.
- **Pace** (current or past month): actual so far for collected, renewals done, new enrollments, shows, appointments
  booked (created in the month, not cancelled) and leads, against `needed x elapsed share of the month`. `ON_PACE` at 90%
  or more of that, else `BEHIND`; per remaining week = what is left / weeks left.

## Rules carried through all slices

Counts and totals for anyone with reporting permission; names only for staff allowed to see those people; school time
zone months; no new prices or offers invented by AI; every number traceable to records and returned with its record
count.
