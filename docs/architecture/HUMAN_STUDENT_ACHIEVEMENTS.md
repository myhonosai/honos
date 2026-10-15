# Human Student Achievements

## Purpose and non-goals

This foundation records **explicit human recognition** for a known, active student at one school. It is deliberately a private school record, not a scoring or workflow engine.

> An achievement is descriptive recognition of effort, practice, character, teamwork, or learning. It is never a readiness assessment, promotion decision, testing approval, rank change, attendance signal, point balance, curriculum observation, or automated recommendation.

The foundation does **not** introduce a directory, child social feed, notification, message, payment, provider, AI invocation, Action Engine execution, external consumer, or global delivery outbox. It applies no tier/entitlement restriction: authorized school staff can use conventional recognition on Essential, Core, and Complete.

## Model and immutable attribution

A school staff member with live exact-school authority creates a closed achievement definition:

- bounded plain-text name and optional description;
- fixed category, age band, optional visual catalog token, and `ACTIVE → ARCHIVED` lifecycle; and
- append-only definition versions.

An authorized human then makes an explicit decision for a known active student. Each award pins the exact active definition version, age/date-compatible human decision, optional private staff reason, award date, and family visibility choice. Award identity cannot change student, definition, or definition version. Corrections append a new version; withdrawal is terminal and always removes family visibility.

Two attributions are intentionally separate:

| Projection field | Meaning | Mutability |
| --- | --- | --- |
| `awardedByPrincipalId` | Human principal who made the original award decision | Stored on immutable award identity; never changes |
| `recordedByPrincipalId` | Human principal who recorded this particular version/correction | Stored on each immutable version |

This prevents a later correction from misattributing the original recognition while retaining staff-only correction accountability. Parent projections omit both identifiers, all reasons, version history, staff-only state, and sibling data.

## Authorization and transport

Permissions are narrowly scoped and staff-assignable:

| Permission | Capability |
| --- | --- |
| `achievement.definition.read` | Read school definitions and definition history |
| `achievement.definition.manage` | Create, revise, and archive definitions |
| `achievement.award.read` | Read awards and staff-only award history for one supplied student |
| `achievement.award.record` | Make or correct explicit human awards |

Every protected database entry point requires `HUMAN_USER` + `HUMAN_UI`, a derived authenticated subject/principal/school context, no Action Engine request, and no delegation. `HQ`, parent, generic global directory, future/expired/revoked/inactive, cross-school, and non-human contexts fail closed. The database takes topology/IAM locks and checks authority again before it returns a read or mutation/replay result.

The authenticated staff workbench is `/staff/students/achievements`; the separate family view is `/parent/achievements`. Browser calls are same-origin `/api/v1` requests with `credentials: 'same-origin'`, `cache: 'no-store'`, closed response validation, and (for mutations) exact-origin JSON, `X-HON-Human-Command: student-achievements`, and an idempotency key. Page state starts empty, clears on access loss/scope changes, keeps an uncertain request only in memory, and allows only a manual retry of the unchanged request with its original key.

The parent route reads only the exact currently authorized family/student pair. It returns latest `AWARDED`, visible records with pinned descriptive metadata; it cannot mutate, request history, or infer staff-only/private information.

## Persistence, RLS, audit, and non-execution

Migration `0086_human_student_achievements.sql` adds only private achievement identities, versions, idempotency receipts, redacted events, and a private inert outbox. All achievement tables are `FORCE ROW LEVEL SECURITY` with no policies and deny direct table/column access. Only exact `SECURITY DEFINER` entry points have execute permission for the restricted runtime role. Immutable/update/delete/truncate triggers protect every private record.

A successful decision writes its identity/version, redacted event, inert outbox marker, and idempotency receipt atomically. The private outbox is constrained to `status = 'INERT'` and `execution_allowed = false`; it is **not** the shared delivery outbox and has no worker, consumer, provider, or action authorization.

Canonical runtime provisioning and verification are extended in:

- `infra/postgres/010_supabase_hon_runtime.sql`
- `infra/postgres/011_verify_supabase_hon_runtime.sql`
- `packages/database/scripts/achievement-security.mjs`

The optional composite-security verifier checks the outbox constraints, no table/column grants, trusted non-runtime owner, forced deny-all RLS/no policies, immutable triggers, exact function definer/path/ACL posture, and no client-role execution.

## Local-only integrity validation

The disposable fixture is intentionally guarded:

```sh
HON_ACHIEVEMENT_RESET=LOCAL_DISPOSABLE_ONLY \
DATABASE_URL='postgresql://hon_achievement_owner:...@localhost:5432/hon_achievement_validation' \
HON_RUNTIME_DATABASE_URL='postgresql://hon_achievement_runtime:...@localhost:5432/hon_achievement_validation' \
pnpm db:setup-achievements

HON_ACHIEVEMENT_RESET=LOCAL_DISPOSABLE_ONLY \
DATABASE_URL='postgresql://hon_achievement_owner:...@localhost:5432/hon_achievement_validation' \
HON_RUNTIME_DATABASE_URL='postgresql://hon_achievement_runtime:...@localhost:5432/hon_achievement_validation' \
pnpm db:test-achievements
```

Both scripts refuse anything except the exact localhost disposable database and aliases; reset additionally requires the explicit sentinel. The fixture test exercises human/staff/parent/HQ/non-human denial, live revocation and lock waits, original-versus-correction attribution, age/category/date/title validation, parent redaction, versioning/replay/concurrency/pages, atomic rollback, direct RLS/ACL denial, non-bypass-owner probe, and JavaScript/canonical SQL drift attempts. It snapshots operational tables and asserts no rank, testing, attendance, observations, points, AI, provider, Action Engine, communication, payment, or other domain effects.

No remote database migration, provider call, or execution is part of this foundation.
