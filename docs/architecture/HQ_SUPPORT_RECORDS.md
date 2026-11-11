# HQ support records (B-HQ-2, migration 0232 proposed)

Status: built as a PR. Not deployed. Migration number 0232 is pending the owner's OK (relayed by the coordinator).

## What it is

An internal HQ record of support cases for schools: what was reported, which organization or school it is about, who is
handling it, and every step taken. It replaces the "Support: planned" placeholder at `/hq/support`.

It does not contact a school, send any message, open a school's data, impersonate anyone or change access, billing or
entitlements. It is a record people keep, nothing more.

## Who can use it

- An HQ owner (`HON_HQ_OWNER`), or
- An HQ operator or HQ support person (`HON_HQ_OPERATOR`, `HON_HQ_SUPPORT`) holding the new permission code
  `hq.support.manage`.

The person must be an active human principal, the only active principal of their user, with no live family access.
HQ billing operators without `hq.support.manage` are refused. Authority is checked before every read and command and
again after it (0206 rule). Anyone else gets 403 `SAAS_FORBIDDEN` and nothing is shown.

Only eligible support people can be assigned a case. A person whose grant ended can no longer read, write or be assigned.

## Data (0232)

| Table | Holds |
| --- | --- |
| `hon.hq_support_cases` | organization, optional school (must belong to it), subject (3 to 200), category, priority, status, assignee, opened by/at, updated, closed, version |
| `hon.hq_support_case_events` | append-only history: `OPENED`, `NOTE`, `CHANGED` with the actor, note (1 to 4,000), status/priority/assignee from and to |
| `hon.hq_support_requests` | one saved answer per (actor, idempotency key) |

- Categories: `ACCOUNT_ACCESS`, `BILLING`, `ONBOARDING`, `PRODUCT_ISSUE`, `DATA_REQUEST`, `FEEDBACK`, `OTHER`.
- Priorities: `LOW`, `NORMAL`, `HIGH`, `URGENT`.
- Statuses: `OPEN`, `WAITING_ON_SCHOOL`, `RESOLVED`, `CLOSED`. `RESOLVED` can be reopened. `CLOSED` is final: no
  notes, no changes. A school that needs more help gets a new case.
- History and saved answers can never be changed or deleted (trigger raises 42501, `TRUNCATE` blocked). A case row can
  only move forward by one version, and only its status, priority, assignee, `updated_at` and `closed_at` change.
- RLS is forced on all three tables and the runtime role has no table privileges. Everything goes through SECURITY
  DEFINER functions. Grants are mirrored in `infra/postgres/010_supabase_hon_runtime.sql`.

## API

Reads (SaaS read guard: GET, declared query only, `private, no-store`):

| Route | Answer |
| --- | --- |
| `GET /v1/hq/support/cases?status&organizationId&cursor&limit` | page of cases, newest first (keyset on opened time and id; limit 1 to 100, default 50), `nextCursor`, summary counts (by status, urgent active, unassigned active), viewer |
| `GET /v1/hq/support/cases/schools` | the organization/school picker for opening a case: ids and display names only, at most 2,000, `truncated` |
| `GET /v1/hq/support/cases/:caseId` | the case, its full history (seq 1..n, first is `OPENED`), the people who can be assigned, viewer |

`status` is `ACTIVE` (open or waiting on school), one status, or absent for all.

Commands (SaaS command guard: same origin, `X-HON-Human-Command`, JSON, `Idempotency-Key`):

| Route | Marker | Body |
| --- | --- | --- |
| `POST /v1/hq/support/cases` | `hq-support-case-open` | `organizationId`, `schoolId` (or null), `subject`, `category`, `priority`, `note` |
| `POST /v1/hq/support/cases/:caseId/notes` | `hq-support-case-note` | `expectedVersion`, `note` |
| `POST /v1/hq/support/cases/:caseId/changes` | `hq-support-case-change` | `expectedVersion`, at least one of `status`, `priority`, `assigneePrincipalId` (or null), optional `note` |

Each answers `{ operation, case, replayed }`. The same key with the same body replays the saved answer; the same key with
a different body is refused (409 `IDEMPOTENCY_KEY_REUSED`). Other refusals: 404 `SAAS_UNAVAILABLE` (no such organization,
school or case), 409 `SAAS_VERSION_CONFLICT`, 422 `SUPPORT_CASE_CLOSED`, 422 `SUPPORT_ASSIGNEE_NOT_ELIGIBLE`,
422 `SUPPORT_NO_CHANGE`, 409 `SAAS_OUTCOME_UNKNOWN` (busy; retry the identical request).

## Pages

- `/hq/support`: summary (urgent active, unassigned active), filters with counts (Active, each status, All), the case
  list with Show more, and an Open a case form with the organization/school picker.
- `/hq/support/[caseId]`: case facts, Add a note, Update the case (status, priority, assignee, optional note) and the
  history, newest first. A closed case shows no forms.

Behavior shared with the other HQ pages:

- Leaving the tab (blur, hidden tab, page hide) or a session end hides every case, drops form drafts and any kept
  command. Show again reads fresh.
- One command at a time. A command whose outcome is unknown is kept in memory with its exact body and key; Try again
  replays it, and the database never saves it twice. If the tab is left first, the kept request is dropped: check the
  list before opening the same case again.
- Every command carries the version that was read, and every answer is followed by a fresh read.
- The page checks each answer matches what was asked (same case, filter, organization, version + 1, requested fields).
- English, Korean and Spanish copy.

## Evidence

- Database proof `packages/database/scripts/test-hq-support-cases.mjs` (in `run-db-proofs.sh`): posture, authority (HQ
  owner, operator and support with the permission; refused for expired owner, billing-only operator, support without
  the permission, school owner, stranger), open/note/change, idempotency and key reuse, version conflicts, assignee
  eligibility, closed is final, immutable history, list paging/filters/summary, school picker, revocation.
- API tests `apps/api/test/hq-support.test.cjs`: closed contracts and HTTP routes forward only the verified subject,
  path id, declared query and validated body; refusal mapping.
- Web tests `apps/web/test/hq-support-ui.test.tsx`.
- Mounted browser check `apps/web/scripts/hq-support-browser.mjs` (synthetic fixture API, no database): list at desktop
  and 390px, open a case, unknown note retried with the same key and saved once, assign and close, concealment, denial,
  Korean; axe WCAG 2.1 AA and no horizontal overflow.

## Not included

- No messages to schools, no email, no school-visible portal, no attachments.
- No automatic case creation from failed operations or AI escalations (the dashboard's "Failed operations" link still
  points here as a place to record them by hand).
- Who holds `hq.support.manage` is set through existing HQ operator grants; there is no new grant screen.
