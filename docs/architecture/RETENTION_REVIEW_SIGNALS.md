# HON Retention Review Signals

## Purpose

**Retention Review Signals** is a conventional, human-controlled staff read for one already-known membership in the current school. It assembles a narrow set of **recorded facts** so a qualified staff member can make their own review decision in normal HON workflows.

> This is **not** a risk score, cancellation/churn prediction, recommendation, readiness determination, financial authority, or automatic workflow.

It is available to direct human staff with the exact `retention.review.read` permission and a current active **Essential**, **Core**, or **Complete** entitlement. Presentation mode (Big-Button, Modern, Classic) does not change this authority.

## Explicit boundary

The read-only projection runtime entry points are:

- `hon.resolve_retention_review_scope(text, uuid)` — derives a verified direct-human current-school scope from an already-known school ID.
- `hon.read_retention_review_signals(text, uuid)` — emits one redacted projection for an already-known membership ID.

The separate `0123` acknowledgement boundary, hardened forward-only by fixed command version `0124`, exposes only these exact function-only entries:

- `hon.read_retention_review_acknowledgement_evidence(text, uuid)` — re-reads the same redacted signals and returns a server-generated evidence version/fingerprint.
- `hon.acknowledge_retention_review_evidence(text, uuid, text, text, timestamptz, uuid, uuid, uuid)` — records an immutable direct-human statement that an exact fresh evidence observation was reviewed.

The API exposes only:

```http
GET /v1/staff/retention/review?schoolId=<known-uuid>&membershipId=<known-uuid>
GET /v1/staff/retention/review/acknowledgement-evidence?schoolId=<known-uuid>&membershipId=<known-uuid>
POST /v1/staff/retention/review/acknowledgement?schoolId=<known-uuid>&membershipId=<known-uuid>
GET /v1/staff/retention/review/attention-alerts?schoolId=<known-uuid>&membershipId=<known-uuid>
GET /v1/staff/retention/review/attention-evidence?schoolId=<known-uuid>&membershipId=<known-uuid>
POST /v1/staff/retention/review/attention-alerts/record?schoolId=<known-uuid>&membershipId=<known-uuid>
POST /v1/staff/retention/review/attention-alerts/resolve?schoolId=<known-uuid>&membershipId=<known-uuid>
```

The staff page is `/staff/retention/review`. It is authenticated, dynamic, `noindex`, same-origin and no-store. A direct human staff member may acknowledge only a fresh, verified, already displayed evidence observation through the fixed POST body `{ evidenceVersion, evidenceFingerprint, observedAt, idempotencyKey }`. The page clears the acknowledgement evidence and receipt whenever its known school/membership selection or verified read context changes.

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

The function owner is trusted while the Session Pooler runtime role has no superuser or `BYPASSRLS` posture. Runtime receives no Retention Review source-table privileges and may execute only the scope resolver, projection, acknowledgement-evidence read and fixed acknowledgement command. `PUBLIC`, `anon`, `authenticated`, and `service_role` cannot execute any Retention Review function.

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

## Human acknowledgement boundary

An acknowledgement records only **`EVIDENCE_REVIEWED`** for a known current-school membership. It is not alert acknowledgement, risk/churn categorization, resolution, recommendation, staff assignment, follow-up, renewal/cancellation decision, financial decision, payment result, customer contact, message delivery, consent, legal signature, Action Engine request, AI work item or automation trigger.

The server recomputes the current redacted evidence, binds its SHA-256 fingerprint to the original server observation window/time label, and accepts it only within five minutes. A changed term, renewal review, attendance observation, curriculum/progression or testing observation, scope/role/tier/principal/family/HQ state, malformed input, stale/replayed key, or failed post-lock authorization fails closed. The browser never supplies a note, recommendation, evidence payload, contact, payer, provider or downstream outcome.

Only a verified direct `HUMAN_USER` / `HUMAN_UI` with both `retention.review.read` and `retention.review.acknowledge`, one active Essential/Core/Complete entitlement, exact current organization/school scope, and no HQ/parent/guardian/student/family/nonhuman/delegated/action context may use the command. For each actor/evidence observation it atomically stores one append-only acknowledgement, one redacted audit and one permanently **INERT** private outbox fact; it has no consumer/delivery path.

**Distinct-key policy: reuse the existing acknowledgement and store one receipt per idempotency key.** The natural evidence key is `(organization_id, school_id, membership_id, actor_principal_id, evidence_version, evidence_fingerprint, observed_at)`. Concurrent submissions with different UUID keys for that exact observation return the identical acknowledgement ID, recorded time and redacted response. The second key appends only its own immutable SHA-256 idempotency receipt: no second acknowledgement, audit or outbox. The same key and exact payload replay the same response without any writes; a changed payload under the same key conflicts. All reuse/replay still rechecks current direct-human authority, live facts and the five-minute freshness limit, and fails closed when any of those no longer holds.

Migration `0124` uses a private trusted-owner-only, FORCE RLS/no-policy, immutable evidence-key ledger, transaction advisory locks on both scoped idempotency and natural evidence keys, and a composite acknowledgement FK that is **DEFERRABLE INITIALLY DEFERRED**. The command reserves the unique evidence key before creating an acknowledgement, so a losing submission never leaves an orphan acknowledgement. For any pre-`0124` duplicates, the migration seeds one canonical key with deterministic newest ordering (`recorded_at DESC, id DESC`); it does not delete or rewrite immutable acknowledgements, receipts, audits or inert outbox history. New keys reuse that canonical acknowledgement, while existing keys retain their exact historical receipt replay.

## Factual attention alerts

Migration `0131` adds a deliberately narrow **factual attention** layer, not an alerting, workflow, or retention-automation system. A qualified direct human may create an alert only from a fresh, server-recomputed, redacted Retention Review observation and one of these closed facts:

- `TERM_ENDING_WITHIN_30_DAYS`;
- `TERM_ENDED`;
- `RENEWAL_REVIEW_NOT_RECORDED`; or
- `UNEXCUSED_ABSENCE_RECORDED` when recorded attendance is available and its exact unexcused count is positive.

Missing attendance, progression, testing, contact, payment, provider, message, family, or follow-up data never creates an attention code. The alert root is immutable and deduplicated school-wide by organization, school, membership, code, evidence version/fingerprint, and observed timestamp. A distinct staff member or retry key for the same evidence reuses that same root; it may add only its own private idempotency receipt. One later direct-human **no-note** resolution history row may record exactly `REVIEW_COMPLETED`, `EVIDENCE_CHANGED`, or `NO_FURTHER_REVIEW_NEEDED`. It does not state or imply a successful contact, payment, renewal, retention outcome, recommendation, assignment, or downstream execution.

The functions `read_retention_attention_alerts`, `read_retention_attention_evidence`, `record_retention_attention_alert`, and `resolve_retention_attention_alert` are fixed SECURITY DEFINER entries. Private roots, resolution history, receipts, and permanently **INERT** factual outbox records are forced-RLS, trusted-owner-only, and immutable. The runtime has no table access. Every creation/resolution rechecks direct-human authority before and after its stable locks. Reads enter `BEGIN READ ONLY` before any tenant or source context GUC is established; write commands use the ordinary transaction-bound context path.

The same staff page shows alerts only after a known membership is read. It has no school-wide alert directory, note, assignment, follow-up, message, provider, Action Engine, AI, billing, payment, renewal, cancellation, attendance, curriculum, testing, or automation control. The two POST routes require exact same-origin JSON markers `retention-attention-record` and `retention-attention-resolve`; the guard normalizes only a trailing slash before matching those fixed routes.

## Validation

- `pnpm db:test-retention-review` verifies function ACL posture, runtime-only execution, client/source-table denial, read-only forged-context denial, and zero mutation effects.
- `pnpm db:setup-retention-review-acknowledgement` then `pnpm db:test-retention-review-acknowledgement` create/replay a descriptor-bound, marked localhost-only fixture with generated private credentials. The proof rejects remote/unmarked/provider/execution environments and verifies RLS/ACL/role/tier/context/replay/concurrency/fingerprint/atomicity/redaction/no-effect posture, including two concurrent distinct keys producing one acknowledgement/audit/inert-outbox and two deterministic receipts, plus evidence-key ledger drift/ACL denial; it tears down its marked fixture after a pass.
- `pnpm db:setup-retention-attention` then `pnpm db:test-retention-attention` use that same descriptor-owned local fixture. Its integrated attention proof checks private schema/ACL/body drift, direct source-table/client denial, human/role/tier/HQ/family/nonhuman/delegated/action revocation, stale evidence, exact replay, two-human natural-key concurrency, one-resolution optimistic concurrency, read-only ordering, inert audit/outbox atomicity, redaction, and zero external effects. Run the test with only `HON_RETENTION_ACKNOWLEDGEMENT_ENV_FILE` supplied; the harness itself opens the private descriptor and refuses inherited database URLs.
- API and browser tests verify strict schema validation, redaction, same-origin GET/POST behavior, human transport protection, stale UI clearing and protected route metadata.
- `pnpm db:verify-rls` imports the Retention Review ACL verifier alongside the complete HON tenant/RLS inventory.
- `infra/postgres/010_supabase_hon_runtime.sql` and `011_verify_supabase_hon_runtime.sql` contain the canonical fresh-role grant and verification statements.
