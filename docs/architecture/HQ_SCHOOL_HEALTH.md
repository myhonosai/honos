# HQ school health (B-HQ-2b, migration 0233)

Status: built as a PR. Not deployed. Migration number 0233 approved by the owner on 2026-11-09.

## What it is

A read-only view of how active each school is, so HQ can see which schools may need help. It shows counts over the last
30 days next to the 30 days before, plus advisory signals that come only from those counts.

It names no person, shows no money, writes nothing, takes no lock and sends nothing. Signals are hints for a person to
look. They never decide, open a case, contact a school or change access.

## Who can read it

- An HQ owner (`HON_HQ_OWNER`), or
- An HQ operator holding `hq.billing.manage` (the SaaS HQ reader rule, as the school detail), or
- HQ staff holding `hq.support.manage` (the support rule from 0232).

The person must be an active human principal with a live grant. Authority is checked before every read and again after
it (0206 rule). Anyone else gets 403 `SAAS_FORBIDDEN` and nothing is shown.

## Facts (per school, at the read time)

| Fact | Counts |
| --- | --- |
| `attendance.last30Days` / `previous30Days` | attendance records that count as a visit (`PRESENT`, `LATE`, `MAKEUP`) by `recorded_at` |
| `attendance.lastRecordedAt` | the latest such visit, or null |
| `classes.heldLast30Days` | sessions that started in the last 30 days, `SCHEDULED` or `COMPLETED` (not cancelled) |
| `classes.scheduledNext14Days` | `SCHEDULED` sessions starting in the next 14 days |
| `bookingsLast30Days` | class bookings made in the last 30 days |
| `leads.newLast30Days` / `newPrevious30Days` / `wonLast30Days` / `open` | CRM leads created, won, and currently `OPEN` |
| `activeStudents` | `ACTIVE` student profiles |
| `openSupportCases` | HQ support cases `OPEN` or `WAITING_ON_SCHOOL` |

## Signals

| Signal | When |
| --- | --- |
| `NO_ACTIVE_STUDENTS` | no active students |
| `NO_ATTENDANCE_14_DAYS` | has active students but no visit in the last 14 days |
| `ATTENDANCE_DOWN` | at least 10 visits in the previous 30 days and fewer than half that in the last 30 |
| `NO_CLASSES_NEXT_14_DAYS` | nothing scheduled in the next 14 days |
| `NO_NEW_LEADS_30_DAYS` | no new lead in the last 30 days |
| `OPEN_SUPPORT_CASES` | at least one open HQ support case for the school |

The contract checks that every signal agrees with the counts beside it, so a drifted answer is never shown.
`NO_ATTENDANCE_14_DAYS` depends on the read time, so only its precondition (active students) is checked.

## API

Reads (SaaS read guard: GET, declared query only, `private, no-store`):

| Route | Answer |
| --- | --- |
| `GET /v1/hq/saas/schools/:schoolId/health` | `{ schoolId, health, asOf }`; 404 `SAAS_UNAVAILABLE` for no such school |
| `GET /v1/hq/saas/schools/needing-attention?limit` | active schools with at least one signal, most signals first, then name: `{ schools, checked, flagged, truncated, limit, asOf }`; limit 1 to 200, default 50 |

Each attention row is `{ schoolId, schoolDisplayName, organizationId, organizationDisplayName, health }`. Archived and
suspended schools are not checked.

## Pages

- `/hq/schools/[schoolId]`: an "Activity health" card under People, read when the detail is shown.
- `/hq/schools/attention` (Schools > Needs Attention): the flagged list with signals, counts on demand, links to the
  school detail and, when the school has open cases, to Support. "Show up to 200" when more schools are flagged.
- Leaving the tab or a session end hides everything; Show again reads fresh. English, Korean and Spanish copy.
- Support staff without `hq.billing.manage` can read the list, but the school detail page stays closed to them.

## Evidence

- Database proof `packages/database/scripts/test-hq-school-health.mjs` (in `run-db-proofs.sh`): posture, authority (owner,
  billing operator, support staff; refused for expired owner, support without the permission, stranger), exact window
  counts, signals, support-case signal on and off, attention order and limit, archived excluded, no person names,
  read-only, revocation.
- API tests `apps/api/test/hq-school-health.test.cjs`: contract consistency, routes forward only the subject, path id
  and declared limit; mismatched or inconsistent answers become 503.
- Web tests `apps/web/test/hq-school-health-ui.test.tsx`.
- Mounted browser check `apps/web/scripts/hq-school-health-browser.mjs` (synthetic fixture API, no database): attention list
  at desktop and 390px, Show up to 200, the detail page health card, concealment, denial, Korean; axe WCAG 2.1 AA and no
  horizontal overflow.

## Not included

- No scoring, ranking by revenue, or prediction. No automatic support cases, alerts or messages.
- Each read computes counts live for every active school. At large school counts this would need a summary table; not
  needed at current scale.
