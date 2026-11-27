# Claire KPI report (P4, migration 0643)

Status: spec + build, 2026-11-22. Asked for by David ("I want all ai agent backend done and switch them on"). It replaces Claire's
"KPI reports and dashboards: Backend required" line in the Ask HON roster (`apps/web/src/components/hon-command/roster.ts`).
Built the same way as Alex plans (0639), Jordan follow-through (0640) and Marcus reviews (0641), reusing Alex's line, key and
immutability helpers. Migration 0642 belongs to another thread; 0643 needs 0639 to 0641.

## What it does

A reporting user asks Claire for a KPI report on the **last 7 or 30 days**, with an optional focus ("are we keeping students?").
The database counts nine fixed KPIs for that window and for the window of the same length before it, once, and keeps those exact
numbers with the report (`hon.claire_kpi_report_numbers`, append-only, forced RLS, no runtime access):

| Code | Counted as |
| --- | --- |
| NEW_LEADS | leads created in the window |
| WON_LEADS / LOST_LEADS | leads now WON (won_at) or LOST (lost_at) in the window |
| REGISTRATIONS | lead registration conversions in the window |
| NEW_MEMBERSHIPS | memberships (not drafts) whose term started in the window |
| ENDED_MEMBERSHIPS | CANCELLED or EXPIRED memberships whose term ended in the window |
| CLASSES_ATTENDED / STUDENTS_ATTENDING | PRESENT, LATE or MAKEUP attendance records, and distinct students, in the window |
| ACTIVE_MEMBERSHIPS | ACTIVE or CANCELLATION_PENDING memberships now (no previous value) |

Claire adds a summary (≤400), one note per KPI (≤200, at most nine), 0..4 things to watch and 1..4 next actions. The screen always
shows the counted numbers, never numbers Claire wrote. There is no revenue KPI: the Command Center marks revenue UNAVAILABLE
(invoice state is not cash collection), and Claire is told not to guess it. Text only: nothing is created, sent or changed.

## Contract

- Kind (0550): `CLAIRE_KPI_REPORT`, agent `claire`, task class `ANALYZE`, budgets 12,000 in / 3,000 out, max provider cost 80,000
  micro-USD, result at most 12 KB, caller `HUMAN_UI`, subject `SCHOOL`, usage agent `BUSINESS_PERFORMANCE`. No S4 function changes.
- Who asks: a direct human at the session school with `reporting.view` (Claire's capability, 0229) and `ai.invocation.plan`, and an
  active Complete entitlement. The per-staff agent switch `ai.agent.claire.use` (0635) is enforced by the planner. Who reads:
  `reporting.view`, and only the reader's own reports.
- Brief: `{period: 'LAST_7_DAYS' | 'LAST_30_DAYS', focus: '' or 1..300 safe characters}`.
- Facts sent: the brief, school name, local date, window days, the nine counted KPIs and the Command Center metrics Claire already
  answers from (`read_school_command_center`, which re-checks reporting.view). No lead, person, family, student, contact or payment
  row, and no staff name.
- Answer: `{summary, notes: [{kpi, note}], watch: [{title, detail}], actions: [{title, detail}]}`, one-line texts, KPI codes from the
  list and not repeated. Checked in the database (`claire_kpi_ok`) and in contracts (`validateClaireKpiProposal`, plus no links or
  email addresses). Outside the shape: stored empty and RESULT_REJECTED with its usage kept; the counted numbers still show.
- Dismiss: `POST …/claire/kpi-reports/:id/close {status:'DISMISSED'}`.

## API and web

- `apps/api/src/claire-kpi/*`: controller under `organizations/:o/schools/:s/claire/kpi-reports` (scope resolved with
  `reporting.view`), human commands `claire.kpi_report.read|request|close`, provider profile at temperature 0.2.
- Web: on Claire's page in Ask HON, a "KPI report with Claire" panel: last 7 or 30 days, optional focus, then each KPI with its
  counted value, the change against the period before and Claire's note, things to watch, next actions and **Dismiss**.

## Tests

- DB proof `test-claire-kpi-report.mjs` (CK1, 6 groups): custody, exact counts for 7 and 30 days against the window before, numbers
  fixed with the report and append-only, only counts and Command Center metrics sent, nothing created, rejected answers keep their
  numbers, UNKNOWN hold and HQ queue, BUSINESS_PERFORMANCE usage, gates (reporting, AI planning, Complete, own reports only),
  isolation, 011.
- API unit test `claire-kpi.test.cjs`, contracts validators, web test `claire-kpi-ui.test.tsx`.
