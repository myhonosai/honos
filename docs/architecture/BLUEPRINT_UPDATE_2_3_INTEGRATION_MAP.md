# Blueprint Update 2.3 — Operational Excellence integration map

**Source of authority:** [HON Master Directive](../HON_MASTER_DIRECTIVE.md), [Blueprint Update 2.1](BLUEPRINT_UPDATE_2_1_INTEGRATION_MAP.md), [Blueprint Update 2.2](BLUEPRINT_UPDATE_2_2_INTEGRATION_MAP.md), and the approved October 2026 Blueprint 2.3 amendment.

> **Status rule:** approved scope is not implemented functionality; implemented functionality is not tested functionality; tested functionality is not production readiness. This document records the additive roadmap and current evidence boundary. It does not authorize a paid provider call, production deployment, financial transaction, customer message, advertisement, or external delivery.

## Purpose and preserved architecture

Blueprint 2.3 is additive. HON remains a multi-tenant martial-arts School Operating System with conventional operations first, PostgreSQL transaction-scoped tenant context, forced RLS, server-side authorization, append-only audit/outbox, Essential/Core/Complete entitlements, governed Action Engine approvals, and separate HQ administration.

It preserves the approved AI employees, pricing and AI-credit allowances, provider-neutral model routing, and the three shared presentation modes:

1. **Big-Button / Phone** — simplified touch-first presentation.
2. **Modern HON** — balanced operational experience.
3. **Classic / Agency CRM** — dense administration workspace.

Kiosk is a constrained customer-facing interface, never a fourth presentation mode or a substitute for school permissions.

## Feature inventory and current evidence boundary

| Capability | Existing reusable foundation | Current status | Required completion evidence |
| --- | --- | --- | --- |
| Core CRM, family/student, membership/billing, scheduling and attendance | Tenant-scoped database/services, focused verticals, audit/outbox and human guarded interfaces | **Partially implemented / individually validated slices** | End-to-end operational workflow evidence; no schema or placeholder alone counts as complete |
| Class pre-registration, capacity and waitlist | Class sessions/bookings and scheduling integrity foundations | **Existing foundation; 2.3 verification pending** | Exact booking/capacity/waitlist regression against current behavior |
| Family-linked accounts and family billing | Guardian/family and parent-safe billing reads | **Implemented and validated as bounded read foundations** | Mutating family billing/payment workflows remain separately governed |
| Staff permissions and instructor records | Roles, staff qualification and human curriculum/testing foundations | **Implemented and validated bounded slices** | Broader staff profile/workforce delivery remains open |
| Attendance history and staff corrections | Attendance/session foundations | **Existing foundation; advanced-category verification pending** | Category, duplicate-check-in, audit and progression-weight proof |
| Mobile-responsive parent access | Parent Home/Journey/Billing/Testing bounded web surfaces | **Implemented and validated bounded web reads** | Purpose-built Expo Parent App is still open |
| Parent notifications | Consent/communication architecture and intentionally unavailable parent receipt view | **Partial / receipt evidence not implemented** | Proven recipient delivery/receipt model and consent-safe projection |
| Secure exports and multi-location management | Migration/import and Core multi-location summary slices | **Partial / bounded foundations** | Product-level export and multi-location operational workflow proof |

## A. Advanced attendance management

### Reuse

Use the existing class sessions, bookings, attendance, student curriculum/progress, human correction, entitlement, audit and outbox boundaries. Do not create a second attendance store or use payment credits as promotion credit.

### Additive requirements

- Record the closed attendance categories: `REGULAR_PARTICIPANT`, `OBSERVER`, `TRIAL_STUDENT`, `GUEST_DROP_IN`, `PRIVATE_LESSON`, `SPECIAL_EVENT`, and `MAKEUP_CLASS`.
- Let authorized school administrators configure category-to-progression behavior and deterministic weights per school/program where required.
- Keep class-package/pass consumption separate from promotion-progress credit.
- Preserve class/program eligibility, duplicate check-in prevention, staff correction audit evidence, attendance history and reporting.
- Expose only bounded interfaces required by ClassPass, Kiosk, scheduling and student profiles; no payment, provider, or AI side effect follows a check-in.

### Acceptance

Two-school restricted-role proof covers category eligibility, duplicate and concurrent check-in, progression-credit versus pass-credit separation, staff correction/expected version, entitlement/role revocation, RLS/ACL, audit/outbox atomicity and zero payment/provider effect.

## B. Deterministic promotion readiness

### Reuse

Use school-defined curriculum/rank/testing and immutable instructor observations; do not create a parallel promotion system.

### Additive requirements

Determine and explain **not yet eligible**, **approaching eligibility**, **eligible for instructor review**, **approved for testing**, and **testing completed** using configured classes, time-in-rank, curriculum/skill evidence, instructor recommendations, testing windows, documents and prerequisites.

These are readiness states only. Only an authorized human instructor/administrator may approve testing or award rank. AI can explain requirements or draft practice ideas through governed paths and cannot approve, promote or issue a certificate.

### Acceptance

Bounded read calculation proves school/program/rank ownership, current evidence/version behavior, no automatic promotion, human-only approval, cross-school/RLS denial, explainable supporting inputs and no AI/payment/communication mutation.

## C. Private curriculum video library

Reuse approved secure object storage/video providers when separately configured; do not build a media platform or expose source material to an external AI provider. Organize school-approved video/link records by discipline, curriculum category, belt/rank and program/audience. Parent/student projection requires verified program/rank/audience; instructor-only material remains private. Claire may reference only approved metadata/content through a future separately reviewed internal knowledge boundary.

## D. Deterministic retention and engagement alerts

Extend the existing Command Center/retention read models with deduplicated, evidence-backed alerts for absence, attendance decline, membership expiration, failed/overdue payment, readiness/progression stalls, trial return, first-week engagement and pass/credit expiry. Each alert has trigger evidence, recommendation, assigned staff and human-managed resolution state. Recommendations are not communications; consent, approval and Action Engine rules remain mandatory for any downstream message or financial action.

## E. Announcement acknowledgements

Extend the existing human document/acknowledgement foundation rather than creating a consent system. Support school announcements, immutable version, intended recipient, delivery/receipt evidence where available, guardian identity, acknowledgement timestamp and permission-safe reminders. An ordinary acknowledgement is never represented as legal consent or e-signature without an independently approved legal workflow.

## F. Guided onboarding and data migration

Build on Migration Center and HQ onboarding foundations: school/profile/program/membership/staff/schedule/payment-provider setup, family/student/membership/rank import, curriculum basics and optional AI configuration. CSV mapping, preview, duplicate detection, validation, row errors, safe rollback/recovery and audit must remain human-reviewed. Core CRM must work without AI setup.

## Blueprint 2.3 dependency order

1. Preserve and complete current HQ task-profile control-plane milestone.
2. Complete Essential/Core/Complete entitlement enforcement and governed AI employee/Action Engine integration against existing slices.
3. Deliver advanced attendance categories and deterministic readiness before ClassPass admission affects progression signals.
4. Deliver ClassPass & Walk-In on existing membership/billing/scheduling/capacity/attendance; then Kiosk on the bounded admission result.
5. Add retention alerts and acknowledgements on already proven evidence/delivery boundaries.
6. Add curriculum video library and guided onboarding/import extensions with existing storage/migration controls.
7. Continue model optimization only via evaluated HQ profiles and a separately owner-authorized bounded provider validation.

## Security and operating constraints

- No direct client table access; all school/HQ reads and writes retain verified principal, permission, organization/school scope, active entitlement, expected version/idempotency and audit/outbox boundaries.
- Financial state, class-credit redemption and progression evidence are distinct domains; unknown provider/payment outcome is never success.
- AI/model routing never grants tenant, tool, approval, payment, communication, staff or promotion authority. The Action Engine remains the only consequential AI path.
- Parent/student/kiosk projections fail closed on ambiguous identity, delivery/receipt, eligibility, capacity or provider/reconciliation state.
- External video, storage, payment, messaging and model adapters require independent configuration and approval; this map activates none.

## Deferred decisions and blockers

No owner decision blocks the current HQ task-profile configuration milestone. The following deliberately remain gated: paid/live model validation and production default selection; payment/processor activation; legal e-signature/consent interpretation; messaging delivery/receipt adapters; video/media vendor selection; real kiosk/payment hardware; and production deployment.
