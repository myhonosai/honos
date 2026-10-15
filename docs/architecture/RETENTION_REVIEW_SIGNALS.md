# HON Retention Review Signals

## Purpose

**Retention Review Signals** is a conventional, human-controlled staff read for one already-known membership in the current school. It assembles a narrow set of **recorded facts** so a qualified staff member can make their own review decision in normal HON workflows.

> This is **not** a risk score, cancellation/churn prediction, recommendation, readiness determination, financial authority, or automatic workflow.

It is available to direct human staff with the exact `retention.review.read` permission and a current active **Essential**, **Core**, or **Complete** entitlement. Presentation mode (Big-Button, Modern, Classic) does not change this authority.

## Explicit boundary

The only runtime entry points are:

- `hon.resolve_retention_review_scope(text, uuid)` — derives a verified direct-human current-school scope from an already-known school ID.
- `hon.read_retention_review_signals(text, uuid)` — emits one redacted projection for an already-known membership ID.

The API exposes only:

```http
GET /v1/staff/retention/review?schoolId=<known-uuid>&membershipId=<known-uuid>
```

The staff page is `/staff/retention/review`. It is authenticated, dynamic, `noindex`, same-origin, no-store, and has no write control.

## Evidence emitted

The projection can include only:

| Area | Recorded facts | Honest unavailable state |
|---|---|---|
| Membership term | Current stored state and recorded term dates | Missing term dates |
| Renewal review | Latest explicit human renewal-review status and recorded time | No explicit human review |
| Follow-up relation | Never inferred in v1 | No unambiguous membership-to-follow-up relation |
| Attendance | Recorded attendance status counts during one UTC `[as_of - 28 days, as_of)` window | No/ambiguous student link or no recorded observations |
| Progression availability | Counts of curriculum enrollment, recorded progress observations, and testing records | No/ambiguous student link or no curriculum enrollment |

The result has **no** person, student, family, payer, contact, staff, note, invoice, payment, provider, audit, outbox, AI, or directory fields. Missing or unavailable data is never represented as failure, disengagement, eligibility, risk, or a recommended intervention.

## Authority and isolation

The projection requires all of the following at database execution time:

1. verified unique active `HUMAN_USER` identity;
2. `HUMAN_UI` source with no action request or delegation;
3. active current organization/school and exactly one active permitted entitlement;
4. an active current-school grant of `retention.review.read`;
5. no HON HQ operator role and no active Parent/Guardian/Student/Family role;
6. transaction-bound server-derived organization, school, and principal context; and
7. the requested membership belonging to the same current organization and school.

The function owner is trusted while the Session Pooler runtime role has no superuser or `BYPASSRLS` posture. Runtime receives no Retention Review source-table privileges and may execute only the scope resolver and projection. `PUBLIC`, `anon`, `authenticated`, and `service_role` cannot execute any Retention Review function.

The projection runs inside `SET TRANSACTION READ ONLY`; initial and final authority checks prevent an authorization decision from being treated as durable if authority no longer holds by the end of the evidence read.

## Intentional non-effects

A Retention Review Signals read does **not**:

- create or modify a follow-up;
- send a message, call, or notification;
- create a work item or Action Engine request;
- modify membership, renewal, attendance, curriculum, testing, invoice, payment, discount, credit, waiver, or cancellation data;
- write audit/outbox/idempotency evidence for a plain read;
- call a provider, LLM, voice service, or automation; or
- infer a follow-up relation, risk, retention probability, outcome, or financial action.

Any future human action must enter its own domain command and applicable policy/approval path.

## Validation

- `pnpm db:test-retention-review` verifies function ACL posture, runtime-only execution, client/source-table denial, read-only forged-context denial, and zero mutation effects.
- API and browser tests verify strict schema validation, redaction, absence of action/provider paths, same-origin GET behavior, and protected route metadata.
- `pnpm db:verify-rls` imports the Retention Review ACL verifier alongside the complete HON tenant/RLS inventory.
- `infra/postgres/010_supabase_hon_runtime.sql` and `011_verify_supabase_hon_runtime.sql` contain the canonical fresh-role grant and verification statements.
