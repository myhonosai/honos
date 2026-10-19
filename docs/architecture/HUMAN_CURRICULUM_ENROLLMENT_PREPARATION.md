# Human curriculum enrollment preparation

## Purpose

`/staff/curriculum/enrollments` replaces routine curriculum/rank technical-ID entry with one explicit, server-authorized **preparation read** followed by the existing direct-human canonical enrollment command. It is a usability step, not a new curriculum, student, membership, billing, payment, provider, AI, Action Engine, automation, or enrollment authority model.

A verified CRM registration receipt may carry one scalar `studentProfileId` UUID into the page as opaque, memory-only form text. It causes no mount request, scope selection, list, idempotency-key allocation, command, retry, or data disclosure. The staff member must deliberately choose **Load enrollment choices**.

## Read boundary

The preparation request is a trusted-origin, same-origin `POST` with a dedicated `X-HON-Human-Command: curriculum-enrollment-preparation` marker. Its closed body is exactly `{ studentProfileId }`; organization and school are route selectors only. It returns only the selected current-school student display name and the exact school’s curriculum/rank labels with internal selectors. There is no people/student search, generic directory, source lead/trial/family disclosure, historical enrollment lookup, filter, pagination, business write, audit event, outbox event, idempotency record, billing/membership/provider or external effect.

The UI may use the existing current-staff reporting-school resolver only as an explicit, human-readable navigation aid. It cannot establish curriculum authority. The preparation endpoint and its PostgreSQL function independently verify the direct current human, exact route organization/school, active entitlement, `curriculum.progress.record` permission, tenant context, RLS boundary and non-HQ/non-family/non-delegated context. A failure clears preparation state; no stale student, curriculum or rank selection persists.

## Command boundary

After the read returns, the staff member selects a returned curriculum label and either a returned rank label or **Unranked**. The browser retains internal IDs only in memory. It then requires a fresh confirmation and delegates unchanged to the existing `prepareCurriculumEnrollment` / `submitCurriculumEnrollment` POST contract. That canonical command remains independently responsible for live authorization, entitlement, tenant relationship/rank validation, idempotency, audit and inert outbox behavior.

The preparation result cannot select or submit the command automatically. An uncertain final command retains only the exact frozen path/body/idempotency key in component memory for a human-requested unchanged retry. Access loss, discard, edit, remount and reload clear all preparation, command, receipt and retry state.

## Scope exclusions

A returned curriculum or rank label does not prove publication, eligibility, readiness, grade, promotion, testing status, class eligibility, booking, attendance, membership, billing, payment, consent, provider health, AI availability or any other downstream result. The preparation query returns the same current-school curriculum scope the canonical enrollment command accepts; it intentionally does not claim a published-only subset.

The existing known-ID workbench remains retained as the canonical transport test surface, but the protected route now uses this preparation workbench. No shared presentation component, portrait, asset, appearance control, or experimental visual branch is changed.

## Validation and CI coverage

The private, marked PostgreSQL 16 fixture creates a separate restricted runtime role and proves deterministic projection order, current-school isolation, forced RLS, the fixed-function preparation projection, no newly granted source-table privilege, no preparation-side enrollment/audit/outbox/idempotency/downstream write, and denial for cross-school, nonhuman, delegated/action, HQ, family, mixed-role, second-active-principal, revoked permission/grant and entitlement-loss cases. Existing source-table access used by other reviewed runtime services remains separately governed; this endpoint invokes only the fixed projection. Its generated credentials remain in a mode-0600 job file only for the proof and are removed by the runner.

Focused validation passed after the production migration and proof harness were corrected: the API contract/controller suite passed 4/4, six browser transport/route/workbench suites passed 19 tests, the 154-file migration contract passed, and the web type-check and whitespace check passed. The full workspace regression then passed 407 tests, all workspace type checks and builds. The guarded local CI dispatcher also passed all nine disposable database proofs across four fixtures, including global RLS verification across 198 tracked operational tables; its nested credentials were confirmed removed on both failure and success paths. The fixture is now dispatched by `.github/scripts/run-db-proofs.sh`; it starts its own guarded loopback cluster on `127.0.0.1:55434`, leaving CI's normal disposable PostgreSQL service separate. The migration and runtime pool disable TLS only for literal loopback hosts (`localhost`, `127.0.0.1`, `[::1]`); external database hosts retain TLS.
