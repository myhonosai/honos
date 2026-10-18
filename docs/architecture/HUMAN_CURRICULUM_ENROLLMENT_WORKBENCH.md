# Human curriculum enrollment workbench

## Purpose and route

`/staff/curriculum/enrollments` is a **dynamic, no-index, authenticated staff route** for one deliberate direct-human curriculum enrollment. It begins idle and has no URL prefill, mount request, polling, lookup, directory, list, search, history view, rank authoring, or automatic retry.

The staff member manually enters exact already-known UUIDs for the organization, school, curriculum, and student profile. `currentRankId` is optional: a blank field deliberately produces `null`, meaning an unranked enrollment. A nonblank rank must be an exact UUID already known to the human. These values are untrusted selectors; they do not establish identity, permission, entitlement, school scope, or curriculum/rank/student relationship.

## Canonical command boundary

The browser has exactly one transport operation:

```text
POST /api/v1/organizations/:organizationId/schools/:schoolId/curricula/:curriculumId/enrollments
```

The existing web rewrite maps that same-origin path to the canonical `CurriculumProgressController` endpoint `POST /organizations/:organizationId/schools/:schoolId/curricula/:curriculumId/enrollments`, which delegates to the unchanged `CurriculumProgressService.enroll` operation. No backend route, service, domain model, migration, permission, or guard is introduced or modified.

Each post uses `credentials: 'same-origin'`, `mode: 'same-origin'`, `cache: 'no-store'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, and the existing closed `X-HON-Human-Command: curriculum-progress` marker required by `CurriculumHumanUiGuard`. The existing controller/guard/service/database boundary remains responsible for current `HUMAN_USER` / `HUMAN_UI` authority, current organization/school scope, `curriculum.progress.record`, active entitlement, tenant RLS, idempotency, audit, and inert outbox behavior. The workbench has no direct database access.

## Deliberate command and receipt rules

- The form requires an explicit confirmation after local UUID validation. Only its submit handler calls `crypto.randomUUID()`, once, to create the idempotency key.
- The command body is closed to `{ studentProfileId, currentRankId }`; blank rank normalizes to `null`. The generated path, normalized body, and v4 key are frozen before I/O.
- The client accepts only a bounded JSON envelope and an exact closed receipt with `id`, `studentProfileId`, `currentRankId`, `curriculumId`, `version`, `status`, and `enrolledAt`. Every returned selector must match the submitted command and `status` must be `ACTIVE`; unexpected/extra fields, malformed timestamps, redirects, wrong content type, and non-200 success are rejected.
- Definite `400`, `404`, `409`, `413`, `415`, and `422` responses show no receipt and retain no retry. `401`/`403` clear all IDs, confirmation, receipt, and retained command.
- Network failures and unverified responses are **uncertain**. Only the exact frozen path/body/key is retained in component memory and can be resent by a separate explicit **Retry exact unchanged enrollment command** action. There is no automatic replay, browser persistence, or fresh command from the prior confirmation. Editing, discard, unmount, and reload remove the retained command; they do not cancel an earlier uncertain request.

## Scope exclusions

This is an enrollment-record command only. It does not list/search curricula, ranks, students, or families, and it does not determine or confer promotion, eligibility, testing, attendance, booking, billing, payment, membership, consent, communication, provider, AI, Action Engine, or automation. An optional rank is placement data only; no rank outcome is asserted. No downstream consumer or additional API/client route is created.

## Focused verification

Focused transport tests cover local closed-input validation, blank-to-null rank normalization, canonical path/body/key construction, exact ACTIVE receipt matching, same-origin/no-store fetch posture, definite rejection/access clearing classification, and uncertain malformed/network outcomes. UI and route tests verify the idle form, explicit confirmation, one key allocation after confirmation, memory-only exact retry, absent discovery/automatic I/O, dynamic/noindex metadata, inherited staff authentication, and one manifest declaration.
