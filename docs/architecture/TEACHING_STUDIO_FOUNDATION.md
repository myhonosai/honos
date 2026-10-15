# Human Teaching Studio Foundation

## Purpose

Teaching Studio is an optional **human-authored, school-scoped** workspace for lesson-plan revisions, bounded resource metadata, and private instructor instructional observations. It supports ordinary teaching preparation on Essential, Core, and Complete without requiring AI, a provider, automation, or an external service.

> Teaching Studio is not a grading, attendance, curriculum-progress, testing, promotion, readiness, membership, billing, parent, or Action Engine surface.

## Authority and scope

All reads and changes use the existing verified human session, server-resolved school scope, transaction-bound RLS, active entitlement, exact role permission, human UI source, and audit/outbox rules. The caller supplies only a known school identifier (and a known student profile identifier only for an assessment); these values select a scope but **never grant authority**.

Permissions are explicit:

| Permission | Purpose |
|---|---|
| `teaching.studio.read` | Read the redacted school workbench and known-student assessment history |
| `teaching.lesson.manage` | Create/revise/archive a school lesson plan |
| `teaching.resource.manage` | Create/revise/archive resource metadata |
| `teaching.assessment.record` | Record or void an instructor instructional observation |

The fixed `resolve_teaching_studio_scope`, `read_teaching_studio`, and `mutate_teaching_studio` database boundaries are `SECURITY DEFINER`, use `pg_catalog, hon`, revoke `PUBLIC`, and grant only their intended `EXECUTE` privilege to `hon_runtime`. Teaching Studio tables use forced RLS and have no broad direct runtime table grant. Parent/family, HQ, public, AI/nonhuman, delegated, and non-human-source contexts are rejected.

## Records and redaction

- **Lesson plans** retain immutable revisions of a bounded title, objective, 1–12 structured text sections, duration, lifecycle status, and optional paired known curriculum/rank reference.
- **Resource metadata** retains immutable revisions of title, closed type, bounded plain-text description, and lifecycle status. It contains no attachment, URL, script, upload, external fetch, or provider content.
- **Instructor assessments** retain immutable revisions for one known student: a bounded observation, up to 20 closed skill observations, optional safe note, date, lifecycle status, and optional paired known curriculum/rank reference.

The runtime response deliberately withholds author/recorder principal IDs. It contains only the record ID/version, bounded instructional fields, known student profile ID where relevant, and timestamp. It returns no staff directory data, student contact data, family data, payment data, provider data, raw audit/outbox content, or Action Engine payload.

## Instructional assessment guardrails

An assessment record is an instructor-authored observation only. Safe text validation rejects attendance language, grades, pass/fail claims, testing-result language, promotion/readiness claims, and automated language. A record does not change a curriculum observation, requirement, enrollment, rank, test candidate, grade, promotion decision, achievement, membership, billing record, or parent-facing journey. Published lesson plans are visible only to authorized staff in this slice; publication does not deliver content externally or make a curriculum requirement.

## Lifecycle and reliability

All entities retain append-only immutable revision history. Mutations require a current version and idempotency key; retries with the same key and normalized request replay the same receipt, while version changes or key reuse with different content fail closed. Actor, staff role, permission, school status, and entitlement are rechecked under locks before the transactional audit and inert outbox event are written.

`/staff/teaching-studio` is an authenticated, no-index, same-origin workbench. It gives known-ID scope, empty/access/error/conflict states, read lists/history, and ordinary human authoring. The Big-Button, Modern, and Classic modes remain presentation-only; none changes data, scope, entitlement, permission, or authority.

## Explicit non-goals

This foundation does not:

- generate a lesson or assessment with AI;
- predict readiness, retention, learning, conversion, revenue, or student outcomes;
- grade, pass/fail, test, register, promote, change a rank, mark attendance, complete curriculum progress, or update an achievement;
- expose plans/resources/assessments to parents or students;
- upload, fetch, execute, publish, send, or synchronize external content; or
- invoke an Action Engine tool, provider, automation, payment, communication, or external integration.

## Verification

`pnpm db:test-teaching-studio` checks fixed function ownership/search paths/ACLs, forced RLS, direct-table denial, forged human/scope rejection, preserved transaction context, and zero attendance/progress/testing/promotion/membership/AI side effects. Focused API and UI tests cover guarded server context, closed contracts, redacted projections, safe text rules, fixed routes, and the absence of provider or autonomous execution imports.
