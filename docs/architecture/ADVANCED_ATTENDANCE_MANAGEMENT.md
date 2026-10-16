# Advanced Attendance Management — Human Operational Evidence

## Delivered scope

Migrations **0114–0115** extend HON’s existing `attendance_records` model with a closed operational category, a nonfinancial immutable **attendance evidence snapshot**, and a fixed function-only record/correction command. They do not create a second attendance system, a ClassPass ledger, a promotion engine, or a payment feature.

The human staff workbench is available at `/staff/attendance`. It uses the same tenant-scoped scheduling/attendance services and supports only five already-known UUIDs: organization, school, program, class session and student profile. There is no roster, student/program directory, name search, freeform endpoint, parent/HQ access, AI selector or authority query.

## Categories and evidence snapshots

Every attendance record has one closed category:

| Category | Operational purpose |
| --- | --- |
| `REGULAR_PARTICIPANT` | Regular class participation record |
| `OBSERVER` | Observation without automatic progression credit |
| `TRIAL_STUDENT` | Trial booking-backed attendance |
| `GUEST_DROP_IN` | Guest/drop-in attendance |
| `PRIVATE_LESSON` | Private-lesson booking-backed attendance |
| `SPECIAL_EVENT` | Event booking-backed attendance |
| `MAKEUP_CLASS` | Makeup attendance, with booking evidence when required |

Each attendance record stores the resolved policy version, enabled flag, bounded `weightMilli` and computed `creditMilli`. **1,000 milli-classes is one nonfinancial class-evidence unit.** The snapshot is fixed at creation/correction time; changing a later policy never reinterprets past records.

> The snapshot is operational evidence only. It never creates a curriculum observation, changes a rank, approves testing or promotion, grants a pass/package credit, changes a membership/billing/payment state, makes a ClassPass redemption, or calls AI, an Action Engine executor, a provider, a worker, or a communication channel.

Legacy rows migrate safely: `MAKEUP` maps to `MAKEUP_CLASS`; all other historical statuses map to `REGULAR_PARTICIPANT`; `PRESENT`, `LATE` and `MAKEUP` retain 1,000 credit while absences retain zero. Existing record identity, version, status, note, session, student and tenant scope are preserved.

## School/program policy

`attendance_progression_policies` is an append-only, versioned school/program stream. A complete revision supplies exactly seven category rules, each with:

- `operationalAllowed`
- `progressionEnabled`
- `weightMilli` from `0` through `10,000`

A disabled progression category can still be recorded if operationally allowed; it has zero progression credit. A category that is not operationally allowed fails closed. Policy configuration is a **direct `HUMAN_USER` / `HUMAN_UI`** staff command requiring the live sensitive `attendance.policy.manage` permission, active school/organization and entitlement, exact expected version, unchanged idempotency replay binding, audit evidence and inert outbox evidence.

System OWNER and ADMIN receive the new permission through the normal role-permission backfill. An AI employee, automation, integration, delegated actor, Action Request, parent/guardian, stale role, inactive principal, expired role grant or inactive entitlement is denied. The policy HTTP boundary additionally requires the fixed direct-human command marker; the database repeats authority checks under its locked transaction.

## Attendance recording boundary

Migration **0115** closes a critical direct-table loophole without editing **0114**. Existing staff attendance recording remains the one operational write path: TypeScript validates/normalizes the command, then invokes only `hon.record_attendance(text,uuid,jsonb,text,uuid,uuid)`. This fixed `SECURITY DEFINER` command atomically owns principal-scoped idempotency reservation/replay, the attendance-pair advisory lock, expected-version corrections, safe audit, schema-v2 inert outbox and the completed receipt. Exact-state replay completes a receipt without creating another mutation event.

Before an insert/correction, the database trigger re-resolves direct human `attendance.record` authority and validates exact school/session/program/student state, session/program lifecycle, program age evidence when configured, required booking evidence, policy operational allowance and a current policy snapshot. It rechecks after lock waits. A correction uses the current policy for its new snapshot; it does not mutate other attendance records or replay historical policy state.

The command independently validates the closed payload, normalized UUID/status/category/note/version/key, binds **both** request and correlation UUIDs to transaction-local GUCs, and repeats `lock_attendance_actor` checks after lock waits. AI, delegation and Action Request contexts are denied even for raw SQL calls. Historical pre-0114 fingerprints/receipts retain their known historical interpretation, never today's policy or current corrected row.

Audit/outbox evidence records safe status/category/snapshot facts only. Attendance note text is intentionally not copied to outbox evidence. `attendance.recorded` uses schema version `2` for the added snapshot fields.

## Data access and privilege posture

Both policy tables force RLS with no direct runtime policy access. `hon_runtime` has only the reviewed fixed function path for policy read/configure; it has no direct policy table, policy replay table or helper-function access. Attendance records retain forced tenant RLS and **SELECT only** for the existing exact correction read. All direct attendance `INSERT`/`UPDATE` grants, including column grants, are revoked. The command's EXECUTE ACL is limited to the trusted owner and `hon_runtime`, not PUBLIC or client roles; correct tenant/human GUCs do not grant direct-table mutation.

The canonical [runtime grants](../../infra/postgres/010_supabase_hon_runtime.sql), [SQL verifier](../../infra/postgres/011_verify_supabase_hon_runtime.sql), and JS RLS verifier assert the exact policy/function/snapshot posture.

## HTTP surfaces

| Route | Purpose | Authority |
| --- | --- | --- |
| `GET /v1/organizations/:organizationId/schools/:schoolId/programs/:programId/attendance-policy` | Exact current policy or the safe closed default | Direct authorized human policy manager |
| `POST /v1/organizations/:organizationId/schools/:schoolId/programs/:programId/attendance-policy` | Append versioned school/program policy | Direct authorized human policy manager; expected version and idempotency key |
| `GET /v1/organizations/:organizationId/schools/:schoolId/schedule/sessions/:sessionId/attendance?studentProfileId=:uuid` | Exact attendance correction read | Direct authorized human attendance recorder |
| `POST /v1/organizations/:organizationId/schools/:schoolId/schedule/sessions/:sessionId/attendance` | Record/correct one exact attendance pair | Direct authorized human attendance recorder; idempotency key |

All are private/no-store, fixed-path, server-authorized calls. A known identifier selects an existing authorized record; it never grants scope.

## Validation evidence

- `pnpm db:test-attendance` uses a guarded marked localhost-only fixture and proves two-school isolation, forced RLS/ACL, direct-human policy/recording gates, category/booking/age validation, policy version/idempotency, immutable snapshots, duplicate/concurrent record and policy handling, correction/revocation/replay behavior, audit/outbox rollback, no unrelated-domain mutations and zero external calls.
- `pnpm db:test-attendance-backfill` creates a separate marked local database, applies the real ordered migrations through `0113`, seeds real pre-0114 rows and a historical receipt, applies unchanged `0114` and additive `0115` once, and proves backfill/snapshot preservation, historical replay, function-only create/correction with exactly one matching receipt/audit/inert outbox, raw direct-write/context denial and zero unrelated effects. It tears down its database and roles; the caller removes the private environment file.
- API/domain/UI tests cover exact DTO/controller/service behavior, fixed same-origin workbench paths, closed category handling, selector injection denial and absence of automatic progression/payment/AI claims.

**0115 final local revalidation:** fresh ordered `0001`–`0115` fixture and canonical grants twice; JS forced-RLS verifier (156 tracked tables); restricted-runtime attendance proof (24 assertion groups); separate real legacy backfill/boundary proof; 10 focused attendance API tests; 3 attendance domain tests; 5 attendance UI tests; API TypeScript check and 115-file migration check. Final root `pnpm test` passed **199** tests; `pnpm check`, `pnpm build` and `git diff --check` also passed. All DB proofs used disposable localhost credentials, with zero external/provider calls and zero unrelated-domain mutation. This is not a deployment claim.

No provider, payment processor, messaging service, external action, Action Engine execution, worker or deployment is activated by this feature.
