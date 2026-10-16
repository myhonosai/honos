# Owner launch lifecycle — bounded conventional setup

**Status:** implemented and tested bounded vertical (migration `0133`).

This document records the first coherent conventional path from an already provisioned and authorized school-owner context to a saved program, class, and student-registration receipt. It does **not** represent public account sign-up, guardian onboarding, enrollment-to-membership completion, class booking, attendance, payment setup, or a complete school readiness checklist.

> The sole authority for school provisioning remains the separate HON HQ onboarding boundary. `/staff/launch` does not create an organization, school, login, HQ grant, staff account, or cross-school access.

## Purpose and route

The authenticated, no-index `/staff/launch` flow uses only fixed same-origin API paths:

1. `GET /api/v1/owner-launch` — returns the current direct-human school context and requester-owned saved receipts.
2. `POST /organizations/:organizationId/schools/:schoolId/programs` — reuses the existing program command.
3. `POST /organizations/:organizationId/schools/:schoolId/schedule/sessions` — reuses the existing class-session command.
4. `POST /organizations/:organizationId/schools/:schoolId/student-registrations` — invokes the new narrow registration command.

The server derives the current identity and exact eligible school. IDs supplied by a receipt select only the fixed server route; they never grant access. The route clears private form state on visibility/focus changes, uses a fresh idempotency key for a changed request, and reloads saved receipts rather than inferring success.

## Authority and scope

Every read or registration command requires all of the following:

- direct `HUMAN_USER` and `HUMAN_UI` context;
- one unambiguous live human principal and active organization/school;
- one active Essential, Core, or Complete entitlement;
- no live family/guardian or HON HQ grant, no nonhuman/delegated/action context;
- all existing school permissions: `school.view`, `people.create`, `student.profile.manage`, `curriculum.progress.record`, `program.manage`, and `schedule.session.manage`.

The SQL resolver independently resolves this scope before and after its bounded locks. It rejects any ambiguous eligible context. A UI, role label, principal type alone, org/school ID, or GUC cannot convey authority.

## Student registration boundary

`hon.register_owner_launch_student` is the only runtime mutation boundary for the new registration records. It is a `SECURITY DEFINER` fixed function under transaction-local tenant context and is the sole precise function grant for `hon_runtime`.

The first supported case is deliberately narrow:

- a **new adult** (at least 18 on the selected future class date);
- a new person name that does not potentially match an existing school person;
- no guardian or family relationship;
- an active/draft program and exact future scheduled class in the same school/program;
- exact current program and class expected versions;
- the explicit `NEW_ADULT_NO_GUARDIAN_REQUIRED` attestation.

It atomically creates only the existing-schema records required for the truthful result:

- `people`;
- `student_profiles`;
- a program-only `student_curriculum_enrollments` record, with no curriculum or rank inferred;
- private immutable registration receipt and permanently inert fact record;
- redacted `student.register` audit evidence.

The registration result is `REGISTERED_NO_BOOKING`. It never creates a class booking, attendance, membership, billing account, invoice, payment method/outcome, ClassPass event, parent login, guardian relationship, testing/promotion action, communication, AI invocation, Action Engine request, provider call, worker job, or external delivery.

Children, guardians, potential existing identity, unavailable/changed program/class, expired authority, non-active tier, nonhuman context, uncertain eligibility and unavailable outcomes all return a clear `needs staff`, conflict, or unavailable response with no success claim.

## Data model and immutability

Migration `0133` adds the scoped immutable `program_id` relationship to the existing `student_curriculum_enrollments` model. Program-only enrollment is allowed only with an absent curriculum/rank, while historical curriculum enrollment rows remain supported. Composite foreign keys bind the enrollment, receipt and class to one organization/school/program.

`student_registration_receipts` and `student_registration_outbox` are private, forced-RLS, deny-all tables. They are append-only; direct runtime/client table access is revoked. Receipts are idempotent per organization, school, actor, and idempotency digest. The outbox state is permanently `INERT`; there is no consumer.

## Presentation and follow-up

The owner launch page contains receipt-safe identifiers/status/version only and links to existing conventional dashboard, attendance and curriculum-library modules. The existing staff dashboard links to the launch workflow and renders the already approved current-school `studentProfiles.total` operational aggregate after a verified school load; it does not enumerate students or invent readiness.

This vertical is intentionally not a substitute for a complete school owner lifecycle. Future work must extend, rather than replace, these foundations for guardian/family creation, verified identity, complete program/curriculum/rank configuration, schedule patterns, class assignment, booking, membership/billing, staff setup, data migration, integrations and purpose-built onboarding progress. Any parent/guardian account, payment, communication, automation, AI or external provider path needs its own approved boundary.

## Validation boundary

The marked localhost-only owner-launch fixture refuses remote/unmarked targets, provider/execution environment values and unsafe credential files. Its guarded proof covers fresh HQ provision then separate owner grant, program/class reuse, registration/replay/concurrency, program/class/age/duplicate/guardian constraints, role/tier/principal/HQ/family/nonhuman/delegated/action revocation, composite relation integrity, raw table/function ACL drift, audit failure rollback, forced RLS and whole-table zero-effect snapshots. It disables all network transports and asserts zero external calls.

Commands:

```bash
pnpm db:setup-owner-launch
# source the generated private fixture environment in a scrubbed shell
pnpm db:test-owner-launch
```

The private generated credentials are never committed or displayed. Run `pnpm db:check`, `pnpm db:verify-rls`, focused API/UI/domain checks and broader workspace regressions before any checkpoint.
