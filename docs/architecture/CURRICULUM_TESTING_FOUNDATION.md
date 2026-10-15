# HON Curriculum, Rank, and Testing Foundation

## Current checkpoint — human curriculum progress after `7cfd7d4`

The foundation is deliberately **school-defined**. The schema supports linear, rotational, hybrid, skill-based, module-based, attendance-plus-approval and custom models; rank definitions separate `exposure_requirement`, `mastery_requirement` and `promotion_requirement`. This is a data/API foundation, **not** a completed curriculum authoring interface or end-to-end testing product.

Additive migrations `0070_human_curriculum_progress.sql` and `0071_curriculum_progress_read_and_integrity.sql` add explicit human requirement management, enrollment/rank placement, append-only instructor observations and a family-safe current read projection. They reuse the existing student, family, enrollment and testing identities, rather than creating a second progression state machine.

## Instructor authority and no automatic promotion

- Requirement create/revise and requirement reads require exact live `curriculum.manage`. Enrollment, explicit current-rank placement, observations and enrollment-detail reads require the new sensitive `curriculum.progress.record`; legacy rank/people/attendance permissions alone do not confer it. Only existing system OWNER roles receive the new permission automatically, not every instructor or principal.
- Staff commands require a verified, unambiguous active **HUMAN_USER / HUMAN_UI**, an active scoped organization/school, effective non-revoked school permission and active Essential/Core/Complete entitlement. AI employees, automations, integrations, delegated/Action Engine requests and alternate sources are denied. Registered command metadata is inert and human-only, not an executable AI tool.
- Browser mutations additionally require configured trusted `HON_PUBLIC_ORIGIN`, same-origin JSON and `X-HON-Human-Command: curriculum-progress` (existing testing commands use `testing`). Missing trusted origin fails closed. Actor, authority and organization/school context are derived server-side, never from body fields.
- Observation status is exactly `NOT_STARTED`, `PRACTICING`, `DEMONSTRATED`, `MET` or `NOT_MET`. **Even every requirement being MET changes no enrollment rank/version/status, testing event/candidate or promotion decision.** Attendance, practice counts, AI, eligibility calculations and payment outcomes cannot promote.
- A testing candidate `PASSED` result is distinct from promotion and does not change current rank. The existing candidate registration/grading and explicit `testing.promotion.decide` services remain separate human commands with live permission locks. `PROMOTED` requires a named human instructor, rationale, decision time and matching atomic decision/audit/outbox evidence. Enrollment updates without newly recorded matching evidence are rejected at commit. Explicit curriculum rank placement is a separate recorded human command, not an inferred promotion.

## Delivered API and evidence

The staff base is `/v1/organizations/:organizationId/schools/:schoolId/curricula/:curriculumId`:

| Method / suffix | Current capability |
|---|---|
| GET `ranks/:rankId/requirements` | Known-rank requirement definitions/versions |
| POST `ranks/:rankId/requirements` | Create a bounded typed requirement |
| POST `requirements/:requirementId/versions` | Revise definition/kind/required flag with expected version; identity/code remain fixed |
| POST `enrollments` | Enroll an active scoped student with an explicit rank or null |
| GET `enrollments/:enrollmentId` | Known enrollment and current-rank requirements/progress |
| POST `enrollments/:enrollmentId/current-rank` | Explicit rank placement/clearing with expected enrollment version |
| POST `enrollments/:enrollmentId/observations` | Record a human observation with expected enrollment, requirement and progress versions |

Mutations require an idempotency key, closed bounded inputs and atomic history/state, redacted audit, private replay and inert `curriculum.human_recorded` outbox evidence. Locks serialize competing commands, authority/expiry is rechecked after waits and before replay, and stale versions/key reuse fail cleanly. Requirements have immutable version snapshots; enrollment history and observations retain actor/source/request attribution and cannot be updated, deleted or truncated through ordinary commands. Instructor notes remain private. Updating a requirement or placing a rank invalidates the current assessment until a matching new observation is recorded; it does not erase history.

All operational relations carry organization/school ownership and forced RLS. Composite enrollment/rank/requirement-version relations prevent both cross-school links and same-school cross-curriculum rank links. The four private history/replay tables have no permissive RLS policy. Runtime/PUBLIC/client roles have no direct requirement/history/replay access. Runtime retains enrollment SELECT and only column UPDATE on `current_rank_id`, `version`, `updated_at` for locked testing dependencies/evidenced promotion, never table-wide UPDATE or enrollment identity/status/date writes. Candidate grading has only `result`, `instructor_notes`, `version`, `updated_at` UPDATE. Fixed callable command/read/authorization/lock functions are explicitly granted; guard, snapshot, actor and evidence helpers are non-callable by runtime/PUBLIC. Canonical provisioning `infra/postgres/010_supabase_hon_runtime.sql` and both verifiers must preserve those exact minima.

## Child-safe parent read projection, not a shipped Parent App

The existing authenticated `GET /v1/parent/schools/:schoolId/families/:familyId/student-journey` adds `requirementProgress` per enrollment. The verified human's explicit live family grant is resolved server-side and reauthorized inside the transaction, after lock waits and before return. The family, school and organization must be active; disabled/ambiguous humans and deleted/future/expired grants fail closed. Children are anchored by explicit STUDENT family membership and the profile's matching primary family.

The new requirement projection contains **only** enrollment/requirement IDs, bounded display label, kind, required flag, recorded status and recorded time for the current rank and matching requirement/enrollment versions. Missing or stale observations return **null**, not an inferred NOT_STARTED/MET, score, testing readiness, approval or guarantee. Notes, private definition descriptions, instructor identity, rationale, history/replay/audit evidence and other families never enter the DTO. Existing testing results and decisions are redacted recorded facts, not recommendations. Responses are private/no-store. See [Parent family scope resolution](PARENT_FAMILY_SCOPE_RESOLUTION.md).

The `/parent` web design reference is **not connected** to that endpoint and now renders `Student Journey unavailable`, rather than invented child scores/progress. This checkpoint delivers no real React Native/Expo Parent App, mobile journey, Eian execution or staff progress workbench.

## Validation boundary

Run TypeScript checks, API/web unit tests, builds and migration-file checks from the repository root. Database validation for this checkpoint uses only the disposable `localhost/hon_curriculum_validation` administrator and restricted runtime URLs from the assigned local environment, rebuilt by the guarded `reset-local.mjs` with all migrations and canonical runtime provisioning. `pnpm db:test-curriculum-progress` deliberately refuses remote URLs, uses synthetic committed fixtures with cleanup, and proves live authority/revocation/expiry, version/history integrity, replay/concurrency, family redaction, exact runtime ACLs, evidence rollback, all-MET no-promotion and existing explicit testing/promotion compatibility. Run `pnpm db:verify-rls` and `infra/postgres/011_verify_supabase_hon_runtime.sql` against the same local database. This is not a production/Supabase rollout; no normal remote migration or provider call is part of finalization.

**Finalization passed:** clean `pnpm check`, `pnpm test` (API 48, web 32, auth 91, domain 94; 265 total), `pnpm db:check` (71 migration files), `pnpm build` and `git diff --check`; guarded fresh local rebuild of all 71 migrations/canonical setup; focused integrity; both runtime/RLS verifiers (72 forced-RLS tables), including post-cleanup verification. Five negative ACL probes proved detection of missing lock execution, an extra enrollment UPDATE column, runtime evidence-helper execution and PUBLIC guard/private-table grants; every probe was restored and the verifier passed again. The build retains only pre-existing non-blocking CSS Autoprefixer warnings. No remote-fixture regression suite was run.

## Remaining work — separately reviewed

- Real React Native/Expo Parent App/mobile child selection and journey/practice UI, authenticated endpoint wiring and conventional staff curriculum authoring/progress interfaces.
- Age-appropriate gamification, achievements and practice/attendance projections; no invented scores or automatic promotion.
- Full testing workflow: curriculum/rank authoring/publishing, eligibility, instructor approval, invitations, family registration, roster/event lifecycle, richer grading/defer and history/reporting surfaces. Existing candidate/grading/decision commands are not completion of that workflow.
- External notification/push delivery, certificates/belt fulfillment and testing registration/payment integrations, each through independently authorized, reviewed adapters/consumers with consent, idempotency and failure handling. No notification, certificate, payment or downstream consumer is activated by observations.
