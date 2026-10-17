# Human curriculum progress workbench

## Delivered boundary

`/staff/curriculum/progress` is a dynamic, noindex/nofollow direct-human instructor page under the existing verified-session `/staff` layout. It starts blank and idle with exactly four known-ID inputs: organization, school, curriculum and enrollment UUID. No URL/query prefill, automatic read, lookup, directory, search, roster or school default exists.

An explicit **Load current enrollment** action is available only after all four fields pass exact local UUID syntax. IDs are untrusted selectors, never permission or identity evidence. The page uses only the existing canonical routes:

- `GET /api/v1/organizations/:organizationId/schools/:schoolId/curricula/:curriculumId/enrollments/:enrollmentId`
- `POST /api/v1/organizations/:organizationId/schools/:schoolId/curricula/:curriculumId/enrollments/:enrollmentId/observations`

Both still enter `CurriculumProgressController`, `HonIdentityGuard`, `CurriculumHumanUiGuard`, and the existing service/tenant transaction. No new API, permission, canonical service, DTO, contract, domain, migration, database grant or outbox consumer was added. `CurriculumProgressService.observe` remains the only observation mutation.

## Observation is not another workflow's outcome

> **MET is an append-only human observation, never promotion, rank/belt/certificate, testing readiness or eligibility, grade, attendance, booking, membership/payment, family/parent access, communication, provider, AI, Action Engine or automation outcome.**

No status aggregation, percentage, readiness calculation, attendance credit, award or next-rank inference is performed. An `ATTENDANCE` requirement kind is still only a curriculum observation here. The existing immutable observation, canonical audit, idempotency record and inert `curriculum.human_recorded` evidence stay unchanged; this delivery activates no consumer or downstream executor.

The page exposes no curriculum/requirement/enrollment/rank-placement authoring, history editing, testing candidate/event/PROMOTION action, or parent command. Ordinary navigation carries no IDs or authority.

## Verified read and closed projection

The browser accepts only a closed `{ data, meta }` envelope with exact UUID request/correlation IDs, matching IDs and a boolean replay flag. GET requires `replayed: false`. The enrollment must match the requested enrollment/curriculum; each returned requirement must belong to its returned current rank. Missing/extra fields, duplicate requirement IDs/codes, invalid versions/statuses/timestamps, mismatched rank or mixed records reject the entire snapshot, not a partial list.

Bounds are **100 returned requirements**, **400,000 response characters**, canonical integer versions `1..999999999` (progress sequence permits `0`), labels of at most 160 characters and optional definition descriptions of at most 2000. Oversized results are declined without truncation, paging or broader discovery. PostgreSQL RFC3339 timestamps, including microseconds and UTC offsets, are validated without replacing them with fabricated browser times.

The UI displays only returned enrollment identifiers, status/version/enrolled time and current-rank requirement label/code/kind/required/version/progress sequence/status/recorded time. Definition descriptions are validated but not displayed. A null status and null recorded time mean **unrecorded for the current revision**; an existing historical progress sequence is retained and is not reset to zero. Unranked, no-requirement, SUSPENDED or ARCHIVED responses show honest facts without observation controls. No actor, stored private note, audit/outbox payload, authority evidence or raw server error is rendered.

## Explicit human command

The instructor chooses only one returned requirement and exactly one canonical status: `NOT_STARTED`, `PRACTICING`, `DEMONSTRATED`, `MET`, or `NOT_MET`. The optional private note is bounded to 2000 characters; empty notes are omitted, and unsafe C0/DEL controls are rejected (tab/newline/carriage return remain allowed).

A separate explicit confirmation is required. Only that valid confirmed submit handler calls `crypto.randomUUID()`, once for the attempt. The immutable command retains the fixed relative path, exact serialized body and generated v4 key. The POST body is only `RecordCurriculumProgressInput`:

```json
{
  "requirementId": "<returned requirement UUID>",
  "expectedRequirementVersion": 2,
  "expectedEnrollmentVersion": 3,
  "expectedProgressVersion": 7,
  "status": "MET",
  "instructorNote": "<optional bounded private note>"
}
```

Versions come only from the verified in-memory snapshot and cannot be authored. Organization/school/curriculum/enrollment selectors appear only in the canonical path; actor, source, tenant authority and delegation fields never appear in the body or UI controls. The transport verifies the exact closed command again before fetching.

GET/POST use `credentials: same-origin`, `mode: same-origin`, `cache: no-store`, `redirect: error`, `referrerPolicy: no-referrer`, and JSON Accept headers. POST additionally sends JSON Content-Type, `Idempotency-Key` and the existing `X-HON-Human-Command: curriculum-progress` marker. Canonical responses retain `Cache-Control: private, no-store`. Both observation creation and replay use HTTP 200; replay is determined only from the verified canonical meta field.

A receipt must match the exact enrollment, requirement, status, expected requirement/enrollment versions and next progress sequence. It is displayed as a **command-response snapshot**, not a refreshed enrollment or live progress claim. No private note or actor is returned by the canonical receipt.

## State, conflict and uncertainty

- No request/key allocation occurs in an effect; there is no timer, polling, background work or automatic retry.
- Every load clears prior snapshot, draft, confirmation, receipt and retry before I/O. Read failure leaves no stale facts.
- Scope edits clear the verified snapshot and draft. Requirement/status/note edits reset confirmation, receipt and retry, but retain an unattempted verified snapshot for the same exact scope.
- Every command attempt immediately invalidates the snapshot and clears the visible draft/note. Another observation requires an explicit fresh read, including after success or definite rejection/conflict.
- `400/404/409/413/415/422` are definite rejection/conflict: no receipt or retry is retained. The canonical service maps transaction conflicts and lock failures to 409; it does not expose an in-progress receipt code on these routes.
- Network loss, redirect failure, server/unrecognized status or malformed/unverified success is uncertain. Only the identical path/body/key is retained in memory, and only a separate explicit **Retry exact unchanged observation** action can resend it. No fresh command can use the invalidated snapshot.
- `401/403`, including on a retained replay, clear all entered IDs, draft, snapshot, receipt and retry. The browser does not replace live server reauthorization with its initial page session check.
- Pending I/O locks inputs and uses an immediate ref guard against rapid duplicate actions. Render epochs and snapshot/ref identity prevent stale read/submit/confirmation/retry handlers from sending an obsolete command. Unmount ignores late responses and removes retained authority/snapshot/retry references; remount/reload starts idle.

**Editing, discarding or reloading is not cancellation.** An earlier uncertain command may still have recorded an observation. After discarding its in-memory retry, staff must use a separately authorized review process before submitting a different observation. There is no command/history recovery search on this page and no browser storage.

## Security preservation

Every canonical read, submit and replay still resolves the current external subject and exact school `curriculum.progress.record` scope, then enters the existing human-only service and database functions. Active human uniqueness, school/organization topology, role scope/expiry, entitlement, tenant RLS, locked authority and requirement/enrollment/progress version rechecks remain unchanged. Browser syntax validation, a verified prior snapshot, confirmation and retained key confer no continuing authority.

Existing `HON_PUBLIC_ORIGIN` must match the actual browser-facing origin for POST. No new origin configuration, identity scheme, permission grant or authorization exception was introduced. No provider, remote database, payment, deployment or external business effect was used.

## Validation evidence

Validated against uncommitted working tree at `main` **57731a2**, preserving the original pending curriculum TODO criteria until implementation validation completed.

| Validation | Result |
| --- | --- |
| New adapter/UI/route tests plus `staff-route-auth-layout.test.ts` | **4 files / 24 tests passed** (22 new workbench tests + 2 existing route-session tests) |
| API `curriculum-progress`, new `curriculum-progress-workbench-edge`, adjacent `curriculum-library` tests, run from `apps/api` | **15 tests passed**, including the existing real HTTP observation/read pipeline |
| `pnpm --filter @hon/api build` | Passed |
| `pnpm --filter @hon/web test` | **89 files / 463 tests passed** |
| `pnpm check` | All workspace prerequisite builds and checks passed |
| `pnpm --filter @hon/web build` | Passed; `/staff/curriculum/progress` emitted as dynamic; existing unrelated CSS/autoprefixer warnings remain |
| `pnpm db:check` | **145 PostgreSQL migration files verified** |
| Complete manifest/page-source comparison | All **64** normalized page routes match, no duplicates; exactly one new manifest entry |
| `git diff --check` and no-index whitespace checks of new files | Passed |
| Canonical API source/contracts/config/domain/database diff audit | Unchanged |
| `pnpm db:test-curriculum-progress` | **Safely blocked before any DB connection**: supplied URLs target a remote database, while the canonical proof requires disposable local `localhost/hon_curriculum_validation` administrator/runtime URLs |

The initial API test command from repository root encountered an existing test's relative `src/curriculum` file-path assumption. Rerunning from the API package directory passed all 15 tests; no canonical test or implementation was changed to work around it.

The conditional live canonical DB proof is **not claimed as passed**. Its committed guard rejected the remote configuration before constructing any client/transaction, and was not bypassed. No remote DB contact, local fixture provisioning, migration, commit, push or deployment was performed.
