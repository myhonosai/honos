# Human Family Testing Registration Interest Foundation

## Scope

Migration `0088_human_testing_registration_interest.sql` adds a **narrow human workflow** for a verified family to submit interest for an **existing, currently OPEN future testing event**, followed by a staff member with the exact sensitive `testing.registration.review` permission choosing **ACCEPT**, **DECLINE**, or **WAITLIST**.

This is intentionally **not testing registration completion**. The persisted record is `testing_registration_interests`, whose state starts `SUBMITTED` and can transition once to `ACCEPTED`, `DECLINED`, or `WAITLISTED`. `ACCEPTED` means only that the human review was recorded; it is not admission, eligibility, instructor approval, a candidate, a roster place, payment, grade, or promotion.

## Authority and scope

- The parent route is fixed at `GET /v1/parent/testing` and `POST /v1/parent/testing/interests`. It accepts no family, school, organization, actor, staff, candidate, curriculum, rank, eligibility, payment, roster, or action selector. The parent service finds **exactly one** current scope from the verified subject; ambiguity fails closed.
- The submitted `studentProfileId` and `testingEventId` are display-derived selectors only. At write time the fixed `SECURITY DEFINER` function locks and rechecks the active human, current family grant, active exact `STUDENT` membership, matching active primary student profile, current open registration window, future event, and exact tenant scope. A sibling/other-family selector is absent rather than authorized.
- Parent authority is direct `HUMAN_USER` / `HUMAN_UI` only. It rejects Action Engine/delegation, AI, automation, integration, service, public API and forged source paths.
- The staff queue is fixed at `GET /v1/staff/testing/registrations` and `POST /v1/staff/testing/registrations/:interestId/decision`. `resolve_testing_registration_review_scopes` returns at most two current exact-permission human scopes, and the API refuses anything except one. There is no staff-side school/family/directory selector.
- Staff reads/reviews require exact live `testing.registration.review`; `testing.manage`, curriculum, rank, attendance, ordinary membership, parent, HQ, and prior authorization are not substitutes. The function locks identity/topology/grants/roles/permission and rechecks after waits before read, mutation, or idempotency replay.

## Data handling and integrity

`testing_registration_interests` and `testing_registration_command_receipts` are forced-RLS private tables with no permissive policy and no direct runtime/client table grants. Fixed security-definer routines have a pinned `pg_catalog,hon` search path; helpers remain non-callable. Canonical `010_supabase_hon_runtime.sql` permits only these runtime procedures:

- `resolve_testing_registration_review_scopes(text)`
- `read_parent_testing_registration_view(text,uuid)`
- `mutate_parent_testing_registration_interest(text,uuid,uuid,uuid,text,text,uuid,uuid)`
- `read_staff_testing_registrations(text)`
- `mutate_staff_testing_registration_decision(text,uuid,jsonb,text,uuid,uuid)`

Bounded notes are optional and at most 500 visible characters; control characters, blank submitted notes, unknown fields, unbounded keys, invalid UUIDs, stale versions, reused keys with different inputs, and duplicate event/student interests are rejected. Interest/review records and command receipts are append-only/guarded. Both commands use scoped advisory serialization, immutable idempotency responses, optimistic review versioning, redacted audit evidence, and an internal-only outbox event in the same transaction.

Parent status projects child/event display, event time, status, submission/review timestamps only. It omits registration/family/guardian/reviewer IDs, reviewer rationale, parent note, curriculum/rank, eligibility/readiness, candidate/grade/promotion, billing/payment, roster/capacity, contact, message, audit and outbox facts. The staff queue receives the bounded parent note needed for human review, but omits family/guardian/reviewer identity and all downstream testing/billing/messaging data.

## Explicit exclusions

No schema/function/controller/UI path creates or updates `testing_candidates`, promotion decisions, enrollment/current rank, testing event lifecycle, eligibility, roster/capacity, invoices/payments, messages/consents, providers, AI work/usage, Action Engine requests/approvals, automations, or any outbox consumer. No consumer is activated.

## UI and validation

- `/parent/testing` is an authenticated no-index family surface. It clears previous view state while revalidating and on visibility loss; no event/child is fabricated. The parent sees its own redacted status, never staff review content.
- `/staff/testing/registrations` is an authenticated no-index conventional queue. It exposes only explicit human **Accept interest**, **Waitlist interest**, and **Decline interest** controls for `SUBMITTED` rows.
- Run `pnpm check`, `pnpm test`, `pnpm db:check`, `pnpm build`, and `git diff --check` at the repository root. The local migration compile proof must recreate only a disposable localhost database and run all migrations; never point this foundation’s tests or setup at Supabase/production.

Future reviewed work includes testing eligibility policy, instructor approval/invitations, candidate/roster creation, payment, grading/defer/promotion, notification/consent delivery, and adapters/consumers. Each needs independent authority, data, idempotency and failure review.
