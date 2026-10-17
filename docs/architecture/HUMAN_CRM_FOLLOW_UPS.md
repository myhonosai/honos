# Human CRM follow-up foundation

## Purpose and hard boundary

[CRM follow-ups](/staff/crm/follow-ups) is a **human recordkeeping workflow** for existing, school-scoped CRM leads. It is available with the same useful capability in active **Essential, Core, and Complete** organizations; it is not a tier-gated automation substitute.

> A due date is nullable planning metadata in canonical UTC, not a scheduler, reminder, promise to contact, or workflow trigger. Completing a follow-up records a human lifecycle action only. It does not advance a lead stage or alter a lead, trial, appointment, membership, payment, communication, consent, or any other CRM/operational record.

The slice is deliberately **not** outreach, workflow automation, an AI suggestion/proposal, or an Action Engine tool. It sends no SMS/email/push/Parent App message; has no recipient/email/phone input; does not publish, spend, charge, schedule work, call a provider, or invoke AI. Its internal outbox event is inert evidence (`crm.follow_up.human_revised`) with `humanOnly`, `internalOnly`, and `executionAllowed: false`; no consumer is activated. Adding a reminder, delivery, automation, AI, or downstream CRM consumer requires a separately reviewed capability, consent/policy, execution, idempotency/reconciliation, authority, and failure boundary.

## Scope, eligibility, and permission model

A controller first derives one **unambiguous** live school scope from the verified external subject. The client never chooses the organization, school, actor, source, or delegation. Ambiguous multi-school authority fails closed; a school switcher is not simulated.

Every authorized actor must be an active eligible school staff principal with a live, non-revoked, effective role grant at the exact organization and school, an active organization/school, an active Essential/Core/Complete entitlement, and both:

1. `crm.lead.read`; and
2. one of the following exact permissions, obtained from a valid school staff role:

| Permission | Read scope and command authority |
|---|---|
| `crm.follow_up.self_manage` | Read only records **currently assigned to self**; create/update/reassign only when the assignee is self; complete, cancel, or reopen only a currently self-assigned record. |
| `crm.follow_up.manage` | Read individual authorized detail and bounded `team` queue metadata; create, revise, reassign, complete, cancel, or reopen records for eligible same-school assignees, including self. |

Permissions are evaluated from the exact, live school grant—not from organization/HQ/parent/family roles or a role whose `management_school_id` is another school. Parent/guardian/student/family/HQ/HON/platform/system role categories are excluded. An HQ operator grant is not staff authority. A valid local role cannot borrow lead-read or manage authority from a wrong-management-school role.

An assignee must be an already-known UUID for an active eligible human at that exact school with both `crm.follow_up.self_manage` and `crm.lead.read`. There is no staff directory, name/email/phone lookup, external recipient, or cross-school assignment. An inactive assignee loses self access; a manager may complete/cancel/reopen then reassign an inactive assignment to an eligible staff member. The actor and relevant current/target assignee are locked and rechecked against the live clock before writes, evidence, and replay responses, so revoked, expired, inactive, suspended, or re-scoped authority cannot reuse an old receipt.

## Lifecycle and immutable history

Migration `0079_human_crm_follow_ups.sql` adds three private, school-owned tables:

- `crm_follow_ups`: immutable identity, composite organization/school ownership, immutable link to one existing same-school CRM lead, and creator.
- `crm_follow_up_versions`: append-only full revisions keyed by `(follow_up_id, version)`.
- `crm_follow_up_requests`: immutable actor/school/idempotency-key receipts and response fingerprints.

All use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with **no policies**. UPDATE, DELETE, and TRUNCATE are rejected by invariant triggers; version and request history cannot be overwritten or purged through the runtime boundary. The lead link is immutable.

The closed lifecycle is:

| Operation | Expected version | Prior status | New status | Notes |
|---|---:|---|---|---|
| `CREATE` | `0` | none | `OPEN` | Requires a same-school existing lead and an eligible assignee. |
| `UPDATE` | current | `OPEN` | `OPEN` | May replace full follow-up fields and assignment subject to self/manager authority; cannot change lead. |
| `COMPLETE` | current | `OPEN` | `COMPLETED` | Preserves fields and sets `completedAt`. |
| `CANCEL` | current | `OPEN` | `CANCELLED` | Preserves fields and sets `cancelledAt`. |
| `REOPEN` | current | `COMPLETED` or `CANCELLED` | `OPEN` | Preserves fields and clears terminal timestamp fields. |

Terminal records cannot be updated, completed, or cancelled again; an open record cannot be reopened. Each successful operation adds exactly one next version. A stale expected version conflicts. An unchanged retry with the same actor-scoped idempotency key and fingerprint returns the saved result only after current authorization is rechecked; reusing a key for changed content conflicts. Concurrent attempts admit only one applicable next version.

### Closed input and projections

`CREATE` and `UPDATE` accept exactly `expectedVersion`, `leadId`, `assigneeId`, `subject`, `note`, `dueAt`, and `priority`; lifecycle operations accept only `expectedVersion`. UUIDs are required for lead/assignee IDs. `subject` is 1–120 characters; `note` is 0–2,000 characters; both reject leading/trailing whitespace and control/hidden directional characters (a note may contain normal newlines). Priority is `LOW`, `NORMAL`, or `HIGH`. `dueAt` is null or a real canonical millisecond UTC timestamp from 2000 through 2099. SQL validates the same closed shapes independently of DTO validation.

Detail is available only for a currently authorized self/manager record and includes the follow-up’s own fields. `mine` returns only the caller’s currently assigned records. `team` is manager-only and uses UUID keyset pagination with at most 50 items plus `nextAfter`; it intentionally returns only follow-up ID, lead ID, assignee ID, version, status, priority, and due date. It excludes subject, note, lead contact, directory fields, email, phone, and joined contact data. There is no total count or unbounded listing.

## Human session/API boundary

Only a verified direct `HUMAN_USER` request with source `HUMAN_UI` can use this foundation. AI, automation, integration, system-service, public, parent, HQ, delegated, or Action Engine identifiers fail closed. Mutating HTTP requests require the configured exact trusted origin, JSON, `X-HON-Human-Command: crm-follow-ups`, appropriate same-origin fetch metadata, and a bounded retained `Idempotency-Key`; missing origin configuration fails writes closed. Responses are `private, no-store`.

The same-origin API has only the following staff routes:

| Route | Purpose |
|---|---|
| `GET /v1/staff/crm/follow-ups?queue=mine|team&status=OPEN|COMPLETED|CANCELLED|ALL&after=<uuid>` | Bounded queue; defaults to own open records. |
| `GET /v1/staff/crm/follow-ups/:id` | Current authorized follow-up detail. |
| `POST /v1/staff/crm/follow-ups` | Create. |
| `POST /v1/staff/crm/follow-ups/:id/revisions` | Update/reassign open record. |
| `POST /v1/staff/crm/follow-ups/:id/lifecycle/complete|cancel|reopen` | Closed terminal lifecycle transition. |

The conventional mobile-styled workbench at `/staff/crm/follow-ups` starts empty and performs no fetch or fake save until the user loads a queue. It uses exact IDs and retained uncertain-request keys, distinguishes reload-current from retry-exact, validates returned current records, and presents truthful empty/error/refresh states. It does not contain an email recipient field, staff directory/search, background timer, local/session persistence, automatic retry, fake sample record, AI invocation, send, or execute control.

### Bounded lead handoff

An already authorized CRM lead row, or the current in-memory **terminal** trial receipt (`COMPLETED`, `NO_SHOW`, or `CANCELLED`), may render an ordinary navigation link containing only `?leadId=<uuid>`. This UUID is an untrusted local draft prefill, never scope or lead authority. Opening the Follow-ups page makes no request; the existing human still explicitly loads the existing authorized queue, and only then can the prefilled ID populate a new draft with the existing current-principal assignee default. Malformed input, queue/status changes, pagination, authorization failure, and form reset clear or consume the prefill. No lead lookup, contact/status/outcome inference, automatic follow-up, message, appointment mutation, enrollment, membership, payment, provider, AI, Action Engine, automation, or persistence is added.

## Database boundary, evidence, and least privilege

Runtime has no direct table or column access to the three follow-up tables, global directory/IAM tables, or helper/trigger functions. The only runtime callable functions are:

1. `resolve_follow_up_scope(text)`;
2. `mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid)`; and
3. `read_follow_ups(text,uuid,text,text,uuid)`.

They are fixed-path `SECURITY DEFINER` functions (`search_path=pg_catalog, hon`) owned by a trusted migration owner. Canonical runtime reconciliation in `infra/postgres/010_supabase_hon_runtime.sql` revokes PUBLIC and client-role access and grants only these entry points to the restricted runtime role. `infra/postgres/011_verify_supabase_hon_runtime.sql` and `scripts/verify-rls.mjs` verify forced RLS/no policies, owner posture, exact executable allowlist without grant option, absent private table/directory ACLs, and every invariant trigger.

The mutation transaction locks organization/school, actor/target users and principals, relevant grants/roles/permissions, and entitlement, then checks authority again after wait. A successful revision atomically appends the version, redacted audit event, inert outbox event, and idempotency receipt. The audit/outbox facts include IDs, version, operation/status and human/internal/no-execution flags; they exclude subject, note, lead ID, assignee ID, due date, contact, and directory data. Evidence insertion failure rolls back the revision and receipt.

## Local proof, rollout, and deferred work

Validation is isolated to the exact disposable local database and roles:

- owner URL: `postgresql://hon_followup_owner@localhost:5432/hon_followup_validation`;
- runtime URL: `postgresql://hon_followup_runtime@localhost:5432/hon_followup_validation`.

The focused test refuses every other host, port, database, or role. A fresh local reset applies all numbered migrations with the owner role, then applies canonical runtime provisioning with `hon_runtime` replaced by `hon_followup_runtime`; it never targets configured Supabase/production data. `pnpm db:test-crm-follow-ups` builds the required local API artifacts and proves SQL/API behavior, including the late deletion of self permission and the wrong-management-school authority-borrowing regression, lifecycle/reassignment/recovery, source/principal denial, active/effective revocation and post-lock expiry, input/version/replay/concurrency, private ACL/FORCE-RLS/drift/actual-row non-bypass probes, redaction, atomic evidence rollback, and snapshots showing zero lead/activity/trial/appointment/membership/communication/payment/AI/provider/Action Engine/automation effects.

Root validation is `pnpm check`, `pnpm test`, `pnpm db:check`, and `pnpm build`, with database URLs unset; `git diff --check` must also be clean. These checks are evidence for the source state only—not a remote migration, deployment, feature flag, or provider activation.

### Completed local validation

A fresh 79-migration reset and canonical restricted-runtime reconciliation completed successfully against the exact guarded local database. `pnpm db:test-crm-follow-ups` passed all 12 deliberate canonical/JS drift denials, actual-row non-bypass-owner FORCE-RLS probes, the late self-permission deletion regression, and the wrong-management-school authority-borrowing regression. With `DATABASE_URL` and `HON_RUNTIME_DATABASE_URL` unset, root `pnpm check`, `pnpm test`, `pnpm db:check` (79 migration files), and `pnpm build` passed. This result is local-only; no remote database, provider, package installation, deployment, or feature activation was used.

> **Rollout caveat:** Commit/push does not deploy migration 0079 or activate the feature. A database operator must separately review and apply migrations plus canonical runtime ACL reconciliation, configure the trusted public origin, and enable only the human UI/API with restricted runtime credentials. Do not enable a consumer, scheduled reminder, contact channel, AI, automation, Action Engine tool, external provider, or remote database fixture based on this foundation.
