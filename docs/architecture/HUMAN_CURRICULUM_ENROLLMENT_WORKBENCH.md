# Human curriculum enrollment workbench

## Purpose and route

`/staff/curriculum/enrollments` is a **dynamic, no-index, authenticated staff route** for one deliberate direct-human curriculum enrollment. It begins idle with one narrow exception: a normal same-origin link from a verified `REGISTERED` CRM registration receipt may carry one untrusted scalar `studentProfileId` UUID as initial form text. That exception does not cause a mount request, lookup, key allocation, retry or command; it carries no organization, school, curriculum, rank, lead, contact, family, registration-path, timestamp or authority fact. Invalid, repeated, oversized or absent selectors start empty.

The staff member manually enters exact already-known UUIDs for the organization, school and curriculum; a valid handoff may fill only the student-profile field. `currentRankId` is optional: a blank field deliberately produces `null`, meaning an unranked enrollment. A nonblank rank must be an exact UUID already known to the human. These values are untrusted selectors; they do not establish identity, permission, entitlement, school scope, or curriculum/rank/student relationship. The fixed POST reauthorizes all of those facts live.

## Canonical command boundary

The browser has exactly one transport operation:

```text
POST /api/v1/organizations/:organizationId/schools/:schoolId/curricula/:curriculumId/enrollments
```

The existing web rewrite maps that same-origin path to the canonical `CurriculumProgressController` endpoint `POST /organizations/:organizationId/schools/:schoolId/curricula/:curriculumId/enrollments`, which delegates to the unchanged `CurriculumProgressService.enroll` operation. No backend route, service, domain model, migration, permission, or guard is introduced or modified.

Each post uses `credentials: 'same-origin'`, `mode: 'same-origin'`, `cache: 'no-store'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, and the existing closed `X-HON-Human-Command: curriculum-progress` marker required by `CurriculumHumanUiGuard`. The existing controller/guard/service/database boundary remains responsible for current `HUMAN_USER` / `HUMAN_UI` authority, current organization/school scope, `curriculum.progress.record`, active entitlement, tenant RLS, idempotency, audit, and inert outbox behavior. The workbench has no direct database access.

## Deliberate command and receipt rules

- The form requires an explicit new confirmation after local UUID validation. Only its submit handler calls `crypto.randomUUID()`, once, to create the idempotency key. The initial selector is never effect-synchronized, so an access denial clears it and it cannot be restored into a stale mounted form.
- The command body is closed to `{ studentProfileId, currentRankId }`; blank rank normalizes to `null`. The generated path, normalized body, and v4 key are frozen before I/O.
- The client accepts only a bounded JSON envelope and an exact closed receipt with `id`, `studentProfileId`, `currentRankId`, `curriculumId`, `version`, `status`, and `enrolledAt`. Every returned selector must match the submitted command and `status` must be `ACTIVE`; unexpected/extra fields, malformed timestamps, redirects, wrong content type, and non-200 success are rejected.
- Definite `400`, `404`, `409`, `413`, `415`, and `422` responses show no receipt and retain no retry. `401`/`403` clear all IDs, confirmation, receipt, and retained command.
- Network failures and unverified responses are **uncertain**. Only the exact frozen path/body/key is retained in component memory and can be resent by a separate explicit **Retry exact unchanged enrollment command** action. There is no automatic replay, browser persistence, or fresh command from the prior confirmation. Editing, discard, unmount, and reload remove the retained command; they do not cancel an earlier uncertain request.

## Scope exclusions

This is an enrollment-record command only. It does not list/search curricula, ranks, students, or families, and it does not determine or confer promotion, eligibility, testing, attendance, booking, billing, payment, membership, consent, communication, provider, AI, Action Engine, or automation. An optional rank is placement data only; no rank outcome is asserted. The CRM receipt link is only a non-executing one-UUID navigation aid, not a downstream workflow or a claim that enrollment occurred.

## Focused verification

Focused transport tests cover local closed-input validation, blank-to-null rank normalization, canonical path/body/key construction, exact ACTIVE receipt matching, same-origin/no-store fetch posture, definite rejection/access clearing classification, and uncertain malformed/network outcomes. UI and route tests verify the idle form, scalar-only student-profile prefill, empty invalid/array/absent inputs, no automatic I/O/key allocation, access-loss clearing without prop restoration, explicit confirmation, one key allocation after confirmation, memory-only exact retry, dynamic/noindex metadata, inherited staff authentication, and one manifest declaration. The integrated focused suite passed 17 tests; `pnpm db:check`, root `pnpm test` (403 tests), root `pnpm check`, root `pnpm build`, and `git diff --check` passed. No shared visual source or asset changed.
