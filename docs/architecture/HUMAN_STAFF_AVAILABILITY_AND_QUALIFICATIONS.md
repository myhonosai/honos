# Human staff availability and qualification foundation

## Purpose and hard boundary

[Staff availability](/staff/team/availability) is **human planning metadata**, usable conventionally in Essential, Core and Complete. It creates no people or roles and makes no employment decisions.

> Weekly windows are recurring school-local wall times, not a claim that a staff member is available, assigned or qualified for any class/session. Qualification titles/issuers/expiry are unverified human metadata, not credential documents, verification or certification evidence. Nothing here changes classes, sessions, assignments or attendance, or derives payroll, compensation, time-card or employment meaning.

No payroll/compensation, hiring/firing/discipline/other employment decisions, automated scheduling/assignment, external calendar sync, messages, AI/provider or Action Engine execution exists in this slice. The event is inert internal evidence with no delivery adapter or executor. Do not attach an automation consumer without a separately reviewed capability boundary.

## Eligibility and scope inspection

`roles` has no employment/worker category. The pre-existing school IAM foundation identifies staff through **live, school-bound permission-bearing roles**. The internal eligibility predicate requires:

- One existing active `HUMAN_USER` principal for its registered user; no AI, automation, integration or system-service target.
- An ACTIVE organization/school and at least one current, non-revoked role grant at that exact school. Future/expired grants do not qualify.
- The role belongs to that organization; a custom role's management school must match. It carries at least one reviewed `permissions.is_staff_assignable` permission.
- Parent/guardian/student/family/HQ/HON/platform/system role categories and any principal with an HQ grant are excluded. School OWNER is eligible. A guardian with an independently valid staff role is treated only through that school staff authority, never their family grant.

This is **authorization eligibility, not employment verification**. No backfill or inference from contacts, families, student profiles or class-session instructor records occurs. Existing parent scope resolvers and HQ grants cannot establish staff scope. There are no parent or mobile endpoints. Principals are not exposed as a directory. The UI accepts only `self` or one already-known principal UUID; there is no listing, search, names, emails or external-subject projection. Unknown and ineligible target IDs return the same forbidden response. Reads do not create a profile.

A dedicated `resolve_staff_availability_scope(subject, permission)` derives an unambiguous school from the verified session and exact staff permission. The controller rejects divergent candidate schools. No client organization/school/actor/source/delegation fields are accepted. Ambiguous multi-school authority currently fails closed; a separately reviewed school switcher is deferred, not simulated.

## Exact conventional permissions

| Permission / command code | Authority |
|---|---|
| `staff.availability.self_manage` | Read own profile and append own availability revisions; no other staff or qualification edits |
| `staff.availability.manage` | Read/append availability for an already-known eligible same-school staff member, including self |
| `staff.qualification.manage` | Read/append unverified qualification metadata for an already-known eligible same-school staff member, including self |

Own profile reads expose the member's own saved streams; manager reads expose only the separately authorized streams, using null for a stream without read authority. Exact permissions must themselves come from a live non-parent/HQ staff role whose management school matches; a second legitimate staff role cannot be used to borrow wrong-school/parent-role permission. Capability booleans are re-resolved on every current read, and are not authorization tokens. Qualification editing always requires its exact permission. Immutable-version reads require **current** actor and target eligibility and stream access; historic authority is not reused. The three codes are staff-assignable through the existing reviewed human IAM subset controls. Migration 0077 brings existing canonical system OWNER roles forward; it creates no principal role grants, expands no non-OWNER role and grants no HQ access. `STAFF_AVAILABILITY_COMMAND_REGISTRY` is HUMAN_ONLY/ESSENTIAL metadata; none of these codes appears in `ACTION_CATALOG` or an executable tool gateway.

## Immutable data and lifecycle

- `staff_profiles`: immutable organization/school/principal identity created only during the first successful revision. No name/contact/compensation/job/discipline fields.
- `staff_planning_revisions`: independent `AVAILABILITY` and `QUALIFICATIONS` append-only full-state streams, `(profile_id, kind, version)` primary key. Every row contains session actor/source/request, recorded school timezone and payload. There is no mutable current-state table or overwrite endpoint.
- `staff_planning_requests`: immutable durable school/actor/key fingerprint and saved response. Receipts do not expire automatically: old unchanged retries cannot duplicate history after a TTL. No hard delete, update or truncate of these three tables is permitted by their invariant triggers. Local-only fixture cleanup explicitly disables user triggers and never runs against remote data.

Each stream starts at expected version 0, compares the latest stream version and appends version `expectedVersion + 1`. Updates/removal/corrections replace the **next full-state payload only**, preserving every earlier version. An ENDED revision must have an empty stream and an existing prior version. Its entered effective-from local date describes the end lifecycle; a later explicit human ACTIVE revision may reopen metadata. A missing or empty stream is **no recorded metadata**, not unavailability or an employment fact. Full-state versions may intentionally correct past applicability; the saved history is never rewritten.

Applicability dates are real `YYYY-MM-DD` local dates in 2000–2099, inclusive effective-from and optional exclusive ends-on; bounded end spans are 1–3660 days. End dates and qualification expiry are recorded metadata, not jobs that alter other records. Read projections return metadata, not date-evaluated staffing claims.

Weekly windows are ISO weekday 1 Monday through 7 Sunday, strict `HH:mm`, 00:00–23:59 starts and 00:00–24:00 ends (`24:00` only at end), at least 15 minutes, at most 28 windows. Same-day overlap and duplicates are denied; adjacency is allowed. Overnight windows must be split across weekdays. The school timezone must exist in PostgreSQL's timezone catalog. Revisions save that timezone; changing school timezone does not rewrite historical wall-time context. No external calendar/UTC expansion, daylight-saving availability guarantee or assignment matching is performed.

Qualification streams contain at most 30 unique case-insensitive title/issuer pairs, each trimmed 1–120 characters without control/hidden direction characters, with optional real 2000–2099 expiry date. Expired metadata can be retained for historical purposes. No attachment, credential number/document, verification, provider URL or class/program selector is accepted.

## Session, locks, audit and least privilege

Only verified direct HUMAN_UI/HUMAN_USER sessions may read or mutate. POST requires the configured exact trusted origin, JSON and `X-HON-Human-Command: staff-availability`; mismatched same-site/cross-site metadata, delegation and Action Engine IDs fail closed. Transaction-local GUCs are installed through `withTenantTransaction`, with local statement/lock timeouts, and clear after commit/rollback. Closed API/service/SQL validation is independent of DTO whitelisting.

The fixed boundaries serialize on organization then school, lock ordered actor/target users, principals, grants, roles and permissions plus entitlement, and recheck eligibility and exact permission with the **live clock after waiting**. The recipient's authority is locked, not just the actor's. Replay also rechecks current authority; a revoked/expired actor or recipient cannot use old receipts to read historic content. Profile/revision insert guards validate session source, actor/request/scope, eligible recipients, timezone, strict payload and consecutive versions.

Audit and `staff.planning.human_revised` outbox evidence are atomic with the revision/profile/receipt. Evidence contains profile ID, stream/version/status and `planningOnly`/`internalOnly`, not weekly windows, qualification labels, contacts or directory subjects. Stream aggregate types differ so equal version numbers cannot collide. Failed audit/outbox inserts roll back even a new profile and receipt.

All three tables use **ENABLE/FORCE RLS with no policies**, owner-only table/column ACLs. Trusted fixed `SECURITY DEFINER` entry points use only `search_path=pg_catalog, hon`, VOLATILE clock/snapshot semantics and explicit exact scope predicates. Runtime is non-superuser/non-bypass and receives only:

1. `resolve_staff_availability_scope(text,text)`
2. `read_staff_availability(text,uuid,text,integer)`
3. `save_staff_planning_revision(text,uuid,text,jsonb,text,uuid,uuid)`

No direct staff table access, private helper/trigger execution, PUBLIC/Supabase-client grant or global directory grants are added. Canonical `infra/postgres/010_supabase_hon_runtime.sql` reconciles exact ACLs. `011_verify_supabase_hon_runtime.sql` and `scripts/verify-rls.mjs` share the staff allowlist, verify trusted owners, exact ACLs/no grant option, RLS/policy posture and invariant trigger function/event types. New permission/action changes must be explicitly reviewed rather than inferred from code prefixes.

## UI and validation

The same-origin `/staff/team/availability` workbench starts empty, loads own or known-ID metadata, separates permission-limited availability/qualification editors, displays the exact school/timezone and saved stream versions, supports explicit end and immutable version reads, and contains no fake sample saves. Draft removal is not persisted deletion. Saved-history reads never replace current editable versions. Unknown outcomes retain the unchanged request key; content or expected-version changes create a different request. All success messages require a validated server result, and backend error payloads/PII are never displayed.

Validation uses a **separate disposable localhost** database `hon_staff_validation` with exact `hon_staff_owner` and `hon_staff_runtime` roles; the owner is trusted for migration only, runtime has all privilege flags false. Never run fixtures/drift probes on Supabase or production. Apply all numbered migrations, then the canonical runtime SQL with guarded local role aliases. `pnpm db:test-staff-availability` runs actual PostgreSQL service/controller integrity, exact denial/validation/history/replay/concurrency/end tests, lock-observed live expiry/revocation, atomic audit/outbox failure injection, redacted evidence and snapshots proving no class/session/assignment/attendance/CRM/billing/messages/AI/provider/Action Engine effects. It also runs JS/canonical drift checks and actual-row non-bypass table-owner FORCE-RLS probes (local peer administration needed for the rollback-only owner probe). Root `pnpm check`, `pnpm test`, `pnpm build`, `pnpm db:check` remain the complete code checks.

Deployment is separate: commit/push does not claim 0077 has been applied remotely. Privileged migrations and canonical 010/011 must be reviewed/applied by the database operator before the runtime feature is enabled. Missing boundaries/credentials/authority stay unavailable, never a fake save.

## Instructor qualification evidence boundary (migration 0109)

`/staff/instructor-qualifications` is a **separate**, exact-known-ID workbench for human-recorded qualification definitions and redacted staff evidence. It does not extend the availability metadata stream. Only an unambiguous current-school direct `HUMAN_USER`/`HUMAN_UI` session with `staff.instructor_qualification.read` or `.manage` may enter; parent, HQ, AI/nonhuman, delegated, Action Engine, cross-school and cross-organization contexts fail closed. An active Essential, Core, or Complete entitlement is required on every read, replay, and write.

Definitions can optionally reference one existing same-school program through composite organization/school foreign keys. Evidence names an existing eligible same-school human staff principal and captures its definition version. Definitions, evidence, reviews, retirements and idempotency receipts are append-only; create, record, review and retire use expected versions and retained keys. Returned evidence deliberately redacts evidence references, review notes, actor identity and staff directory data. `RECORDED`, `REVIEWED`, and `RETIRED` are internal evidence states—not credential verification, qualification, legal certification, class/testing eligibility, promotion or assignment decisions.

The six qualification tables are ENABLE/FORCE-RLS with no policies and owner-only table/column ACLs. Runtime receives exactly `resolve_instructor_qualification_scope(text)`, `read_instructor_qualification(text,text,uuid,uuid)`, and `mutate_instructor_qualification(text,text,uuid,uuid,jsonb,text,uuid,uuid)`; private helpers and direct client/runtime table access remain denied. Audit rows are redacted `HUMAN_UI` evidence. The distinct qualification outbox accepts only `INERT` rows with `execution_allowed=false`; it has no worker, consumer, Action Engine, provider, payment, messaging, scheduling, testing, payroll or employment effect.

Run only from a private job directory: set `HON_INSTRUCTOR_QUALIFICATION_VALIDATION_TARGET=postgresql://localhost:5432/hon_instructor_qualification_validation` and `HON_INSTRUCTOR_QUALIFICATION_ENV_FILE=/home/ubuntu/jobs/<job>/instructor-qualification.env`, then run `pnpm db:setup-instructor-qualifications`, source that private env file, and run `pnpm db:test-instructor-qualifications`. Setup refuses any non-local target, unmarked aliases/databases, provider credential/execution environments, and writes generated local credentials only to the mode-0600 job file. The integration suite runs the service/controller against PostgreSQL and proves lifecycle/replay/version/concurrency, live revocation, cross-scope/context denial, forced RLS/private ACLs, composite relationships, redacted audit/inert outbox and no downstream effects. `pnpm db:verify-rls` runs the canonical exact qualification verifier as well.

### Validation result

Clean migration order (77 files), root check/test/build, forced-RLS verification (87 tracked tables), staff integrity with 12 fail-closed drift cases, staff-role/security/parent-schedule/outbox regressions passed in the disposable local environment. Web tests: 58 passed; API tests: 82 passed. The requested page and synchronized JSON route manifest returned HTTP 200 locally and publicly without authenticated data writes. No remote migration or deployment is asserted.
