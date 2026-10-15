# Parent/Eian Testing Status Read

## Scope

Migration `0104_parent_testing_status_read.sql` adds one **read-only**, redacted current-family testing projection: `GET /v1/parent/testing/status`. The authenticated, no-index `/parent/testing` page only calls that GET. It does not recreate the existing testing-interest submission flow.

The view displays only existing facts for active current-family children:

- a label and timing for an already-linked future event, if one exists through the child’s existing candidate or the family’s own existing interest;
- a candidate’s recorded overall status, when a candidate already exists;
- the parent family’s own registration-interest state; and
- only `ISSUED`/`NOT_ISSUED` certificate existence when both a current guardian scope and a concrete current-family child-to-designated-billing-contact relationship can be proved. Otherwise certificate status is explicitly `UNAVAILABLE`.

A missing child, candidate, future linked event, interest, certificate relationship, or unavailable read is never converted into a readiness, eligibility, invitation, place, payment, result, or certificate claim.

## Authority and isolation

- The browser supplies **no** school, organization, family, child, event, candidate, certificate, staff, payer, or action selector. Query strings, bodies, cross-site requests, and `X-HON-*` headers are rejected.
- `ParentTestingStatusService` requires exactly one live `resolve_parent_journey_scopes` result before and after the fixed database read. Multiple families fail closed; no arbitrary family is selected.
- `hon.read_parent_testing_status(text)` independently resolves exactly one live family from the verified subject before querying and rechecks that exact scope after reading. It has no `current_setting` caller-GUC authority and no staff or HQ fallback.
- The runtime opens a repeatable-read, read-only transaction and can execute only this fixed `SECURITY DEFINER` function. Public/client roles cannot execute it. Existing source tables remain forced RLS.
- Certificate visibility requires `PRIMARY_GUARDIAN` or `SECONDARY_GUARDIAN` plus a membership participant matching the current child and a billing account whose responsible person is a current-family designated billing-contact guardian. A `VIEWER` or an unverified payer link receives an explicit unavailable state, not a certificate-existence inference.

## Redaction

The DTO contains display names, event label/timing, candidate overall status, interest status/timestamps, and certificate existence status only. It excludes all IDs and hides family/school/organization/principal/account/payment identifiers; evaluator identities; scorecard and evaluation IDs; criteria; observations; comments; instructor notes; rank/belt; promotion; certificate title/issuer/date/file/download; reviewer identity/rationale; eligibility/readiness; roster/capacity; provider/communication/audit/outbox data.

## Explicit exclusions

This status read cannot submit or review interest, create/register/grade/change a candidate, change pass/fail/defer, decide promotion, advance rank/belt, issue/download a certificate, collect or mutate payment, message anyone, call a provider, invoke AI, create an Action Engine request, invoke voice, run automation, mutate an audit/outbox row, or make an external call. Testing scorecard/evaluator/evaluation tables are never queried.

## Validation

Focused coverage is in `apps/api/test/parent-testing-status.test.cjs` and `apps/web/test/parent-testing-status-*.test.tsx`. The canonical Supabase ACL script and verifier explicitly allowlist only `hon.read_parent_testing_status(text)`. The disposable-local `db:test-parent-testing-status` proof is intended to verify family isolation, payer-safe certificate redaction, scorecard/evaluator exclusion, ACL posture, and zero effects after a local migration run.
