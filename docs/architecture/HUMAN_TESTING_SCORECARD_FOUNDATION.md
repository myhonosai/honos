# HON Human Testing Scorecard Foundation

## Purpose and boundary

The Testing Scorecard foundation lets a qualified human staff member record one bounded, independent internal observation for a **known testing candidate and that candidate’s known testing event** in the current school. An evaluation has only an uppercase criterion code and one human assessment: `OBSERVED`, `NOT_OBSERVED`, or `NEEDS_FOLLOW_UP`.

It is not grading. It never calculates or sets pass/fail, eligibility, readiness, rank, promotion, belt, certificate, roster, attendance, membership, billing, payment, parent state, or any other candidate outcome. Existing human candidate grading and explicit human promotion commands remain independent and retain their own safeguards.

## Authority and composite tenant integrity

The fixed PostgreSQL resolver, read and record functions require at call time—and the recorder rechecks after its locks:

- one verified active direct `HUMAN_USER` from `HUMAN_UI`;
- active organization and school scope, no parent/family/student/HQ/system-coded role;
- active Essential, Core, or Complete entitlement;
- exact sensitive `testing.scorecard.read` or `testing.scorecard.record` permission;
- no delegation, Action Engine request, AI employee, automation, integration, public or external source.

The browser supplies known school/candidate/event UUID selectors, bounded criterion/assessment values, expected candidate/event/scorecard versions, and an idempotency key. Selectors do not convey authority. A composite foreign key links every scorecard to `(candidate, event, organization, school)`, so even a same-school unrelated event cannot be paired with a candidate.

## Versioning, independent attribution, and evidence

A scorecard root is created at version one on its first observation and advances optimistically for each new evaluation. Recording requires current candidate, event and scorecard versions; stale values and duplicate/changed retry keys fail without a partial result. The per-actor, per-school receipt stores a fingerprint and redacted response for exact retry only.

Every evaluation is append-only, immutable and privately attributable to its evaluator principal. A unique `(scorecard, evaluator, criterion)` constraint prevents one examiner from rewriting their criterion observation, while different qualified examiners can independently record the same criterion. The staff projection exposes only `recordedByYou` versus independently recorded—never staff IDs. There is **no parent scorecard endpoint or parent mutation**; the current verified parent testing scope remains unchanged.

A normal atomic audit record is written with the evaluation. The local `testing_scorecard_outbox` is permanently `INERT` with `execution_allowed = false`, has no dispatcher and is deliberately separate from the global dispatchable outbox. This foundation creates no consumer.

## Storage, runtime and UI

`testing_scorecards`, `testing_scorecard_evaluations`, idempotency receipts and inert evidence use forced deny-all RLS with no policies. The runtime role receives no table or column grants and only these fixed `SECURITY DEFINER` functions:

1. `resolve_testing_scorecard_scope`
2. `read_testing_scorecard`
3. `record_testing_scorecard_evaluation`

The authenticated, dynamic, no-index same-origin `/staff/testing/scorecards` workbench validates strict UUIDs locally, transports only same-origin JSON with `X-HON-Human-Command: testing-scorecard`, displays explicit empty/access/error/conflict/retry states, and supports presentation only. The redacted list is capped at 100 records and states if it is limited. It includes no student/family identity, evaluator identity, grade/result, promotion/rank/certificate, parent, audit or outbox details.

## Verification

Run only against the dedicated disposable local PostgreSQL fixture:

```bash
export HON_TESTING_SCORECARD_RESET=LOCAL_DISPOSABLE_ONLY
export DATABASE_URL='postgresql://hon_testing_scorecard_owner:<local-password>@localhost:5432/hon_testing_scorecard_validation'
export HON_RUNTIME_DATABASE_URL='postgresql://hon_testing_scorecard_runtime:<local-password>@localhost:5432/hon_testing_scorecard_validation'
pnpm db:setup-testing-scorecards
pnpm db:test-testing-scorecards
```

The setup refuses remote URLs and requires a preprovisioned BYPASSRLS migration owner plus a non-superuser, non-BYPASSRLS, non-inheriting runtime role. The integrity suite proves tenant/school/candidate-event mismatch denial, permission/source/principal revocation, exact tiers, candidate/event/scorecard optimistic conflicts, idempotency and independent multi-examiner attribution, evaluator-ID redaction, direct ACL/RLS denial, immutable/inert evidence, and zero candidate/promotion/rank/certificate/parent/global-outbox/Action Engine/AI/payment/message/provider effects. Canonical runtime provisioning and the runtime verifier contain matching allowlists.

No AI, provider, voice, Action Engine execution, payment, messaging, public listing, parent output, automatic decision, or external service is activated by this foundation.
