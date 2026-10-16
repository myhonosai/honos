# Blueprint Update 2.3 — Operational Excellence integration map

**Source of authority:** [HON Master Directive](../HON_MASTER_DIRECTIVE.md), [Blueprint Update 2.1](BLUEPRINT_UPDATE_2_1_INTEGRATION_MAP.md), [Blueprint Update 2.2](BLUEPRINT_UPDATE_2_2_INTEGRATION_MAP.md), the approved October 2026 Blueprint 2.3 amendment, and the additive Final Product Experience and Scope Reconciliation.

> **Status rule:** approved scope is not implemented functionality; implemented functionality is not tested functionality; tested functionality is not production readiness. This document records the additive roadmap and current evidence boundary. It does not authorize a paid provider call, production deployment, financial transaction, customer message, advertisement, or external delivery.

## Purpose and preserved architecture

Blueprint 2.3 is additive. HON remains a multi-tenant martial-arts School Operating System with conventional operations first, PostgreSQL transaction-scoped tenant context, forced RLS, server-side authorization, append-only audit/outbox, Essential/Core/Complete entitlements, governed Action Engine approvals, and separate HQ administration.

It preserves the approved AI employees, pricing and AI-credit allowances, provider-neutral model routing, and the three shared presentation modes:

1. **Big-Button / Phone** — simplified touch-first presentation.
2. **Modern HON** — balanced operational experience.
3. **Classic / Agency CRM** — dense administration workspace.

Kiosk is a constrained customer-facing interface, never a fourth presentation mode or a substitute for school permissions.

## Final product experience reconciliation

HON is intended to be a **broad functional beta** for the approved Ideal School OS foundation and HON enhancements—not a narrow MVP, a set of reference screens, or a collection of isolated infrastructure demonstrations. The status labels below distinguish a bounded, tested vertical from the end-to-end product experience still required. No status label is a production-readiness claim.

| Approved experience | Current classification | Reconciliation and remaining acceptance boundary |
| --- | --- | --- |
| Full functional beta | **Partially implemented** | Tenant/RLS, CRM, membership/billing, scheduling/attendance, curriculum/testing, families, documents, staff, reporting, onboarding, community, marketplace and AI-control-plane verticals exist. Complete cross-domain school operation from registration through retention, with ordinary user journeys and graceful fallback, remains open. |
| Big-Button, Modern HON and Classic CRM | **Partially implemented** | Shared presentation themes, mode preference, visual reference routes and responsive components exist. Every product workflow must still be verified as the same common data/permission/business-function surface in all three modes. Onboarding preview/selection and later safe switching must remain on this common implementation; no tier- or mode-specific domain fork is allowed. |
| Visual AI team | **Partially implemented** | Named employees, workspaces, approval evidence and selectable realistic/anime/chibi presentation assets exist in bounded presentation surfaces. Portrait/style customization stays presentation-only; complete visible cross-employee work histories and all employee journeys remain to be finished through the shared Action Engine. |
| My AI Draft Work | **Implemented and tested bounded Complete read** | Current direct-human requester-only durable Marcus/Claire/Chad pointers are available at `/staff/ai-work` through fixed redacted projections. It has no chat, provider, retry, execution, approval, delivery or generic queue capability; wider AI Office coordination remains separate. |
| Complete school onboarding | **Partially implemented** | HQ provisioning/onboarding and migration/import foundations exist. Save/resume, optional-step skipping, progress/readiness validation and a coherent school-registration-to-first-use journey covering branding, mode, programs, schedules, pricing, staff, families/memberships, payment setup, integrations and optional AI configuration remain product work. |
| Essential, Core and Complete | **Partially implemented** | Entitlements are server-side and tested in several bounded modules. A full entitlement matrix across every end-to-end journey, including useful conventional Core operation and general approved AI assistance without separate Core/Complete domain implementations, remains required. Existing owner-approved pricing, credit allowances, onboarding credits and founder offers remain locked; no historical figure is silently selected or changed here. |
| Parent and student experience | **Partially implemented** | Family-safe linked-account web reads for Journey, billing, testing, absence and messages exist. The school-branded purpose-built Expo parent app, broader student experience, approved curriculum access, announcements and appropriately evidenced notifications remain open. Native distribution requires each school’s own Apple/Google developer-account decisions where applicable. |
| End-to-end business growth | **Partially implemented** | CRM, attribution, public forms, campaign planning, human approval, Chad draft follow-up, trials, enrollment/membership and revenue foundations exist. A proven campaign-to-creative-to-approved delivery-to-conversion/optimization journey remains open; Meta/Google lead import stays conventional and does not require premium AI. Financial, advertising and external communication actions retain their separate approvals. |
| Optional Teaching Studio | **Implemented and tested as a bounded slice** | Human Teaching Studio and Claire preparation are optional instructor support; they do not decide evaluations, readiness, testing or promotion. Broader instructor workflow integration remains open and must preserve human instructor authority. |
| HON HQ control plane | **Partially implemented** | HQ tenant/entitlement/provider/catalog/policy/task-profile, usage/evidence and onboarding foundations are guarded and separated from school permissions. The bounded HQ-1 owner/operator platform overview returns aggregate counts and explicit unavailable states rather than invented SaaS/financial/AI-work metrics. Complete operational oversight, secret custody/rotation, activation/reconciliation and broader onboarding/model-routing administration remain open. School owners never gain HQ-only authority. |
| Real product acceptance | **Partially implemented** | Every completed milestone requires tenant, role, subscription, security, error-state and actual user-journey evidence. A table/API/mock/reference screen alone is not completion; the remaining roadmap uses these classifications and must demonstrate integrated end-to-end operation. |

**Conflicting decision status:** no new pricing, allowance, founder-offer, payment-processor, provider-default, native-distribution or legal-consent figure is introduced by this reconciliation. Any conflicting historical value found later is an owner-review blocker rather than a value to infer.

## Feature inventory and current evidence boundary

| Capability | Existing reusable foundation | Current status | Required completion evidence |
| --- | --- | --- | --- |
| Core CRM, family/student, membership/billing, scheduling and attendance | Tenant-scoped database/services, focused verticals, audit/outbox and human guarded interfaces | **Partially implemented / individually validated slices** | End-to-end operational workflow evidence; no schema or placeholder alone counts as complete |
| Class pre-registration, capacity and waitlist | Class sessions/bookings and scheduling integrity foundations | **Existing foundation; 2.3 verification pending** | Exact booking/capacity/waitlist regression against current behavior |
| Family-linked accounts and family billing | Guardian/family and parent-safe billing reads | **Implemented and validated as bounded read foundations** | Mutating family billing/payment workflows remain separately governed |
| Staff permissions and instructor records | Roles, staff qualification and human curriculum/testing foundations | **Implemented and validated bounded slices** | Broader staff profile/workforce delivery remains open |
| Attendance history and staff corrections | Existing sessions/bookings/attendance with guarded policy and function-only command boundary | **Implemented and tested bounded vertical** | Promotion readiness and ClassPass admission reuse attendance only as separate human-governed domains |
| Promotion readiness | Existing curriculum/rank/history/progress/attendance/testing/document evidence through a fixed staff read | **Implemented and tested bounded projection** | Policy authoring, wider instructor workflow integration and every promotion/testing action remain distinct human-governed work |
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

**Delivered bounded vertical (migrations 0114–0115):** seven closed categories, direct-human school/program policy revisions, immutable nonfinancial attendance snapshots and a function-only atomic attendance command now extend the existing attendance model and staff workbench. The [advanced attendance operating contract](ADVANCED_ATTENDANCE_MANAGEMENT.md) records the full boundary, including the separate pre-0114 real-migration backfill proof. It does not deliver ClassPass/redemption, curriculum progress mutation, readiness or promotion automation, billing/payment effects, AI/provider execution, messaging or a worker.

## B. Deterministic promotion readiness

### Reuse

Use school-defined curriculum/rank/testing and immutable instructor observations; do not create a parallel promotion system.

### Additive requirements

Determine and explain **not yet eligible**, **approaching eligibility**, **eligible for instructor review**, **approved for testing**, and **testing completed** using configured classes, time-in-rank, curriculum/skill evidence, instructor recommendations, testing windows, documents and prerequisites.

These are readiness states only. Only an authorized human instructor/administrator may approve testing or award rank. AI can explain requirements or draft practice ideas through governed paths and cannot approve, promote or issue a certificate.

### Acceptance

Bounded read calculation proves school/program/rank ownership, current evidence/version behavior, no automatic promotion, human-only approval, cross-school/RLS denial, explainable supporting inputs and no AI/payment/communication mutation.

**Delivered bounded projection (migration 0116):** a staff-only fixed read accepts only an exact, closed `promotionReadinessV1` object stored on the current rank; unknown, missing or malformed historical JSON is a visible configuration blocker and is never interpreted as a default. It uses current rank/enrollment history or an existing human promotion timestamp, current-version requirement observations, nonfinancial attendance snapshots since the current rank, an exact open testing window, and the latest exact next-rank candidate. Its deterministic result is one of **not eligible**, **approaching**, **eligible for instructor review**, **approved for testing** (an already human-created pending candidate), or **testing completed** (an existing final candidate outcome)—not a promotion result. Optional document evidence is intentionally limited to the current staff viewer's acknowledgement of a current STAFF publication; it never infers student, family or guardian compliance. The projection is tenant/role/entitlement/RLS constrained, returns redacted IDs/timestamps/counts only, and creates no candidate, test approval, promotion, rank, certificate, document, audit/outbox, financial, communication, Action Engine, AI or provider effect.

## C. Private curriculum video library

Reuse approved secure object storage/video providers when separately configured; do not build a media platform or expose source material to an external AI provider. Organize school-approved video/link records by discipline, curriculum category, belt/rank and program/audience. Parent/student projection requires verified program/rank/audience; instructor-only material remains private. Claire may reference only approved metadata/content through a future separately reviewed internal knowledge boundary.

## D. Deterministic retention and engagement alerts

Migration `0123` delivers the first bounded human-managed fact: a direct-human immutable **evidence reviewed** acknowledgement for one fresh Retention Review Signals projection. It reuses no communication, renewal, billing, Action Engine or AI command; it records neither risk nor resolution and has no consumer or delivery effect. The existing read stays read-only. This does not yet deliver alerts, recommendations, assignments or downstream action.

Future work may extend the existing Command Center/retention read models with deduplicated, evidence-backed alerts for absence, attendance decline, membership expiration, failed/overdue payment, readiness/progression stalls, trial return, first-week engagement and pass/credit expiry. Each future alert needs trigger evidence, human-managed resolution state, exact recommendation semantics and separate consent/approval/Action Engine rules for any downstream message or financial action.

## E. Announcement acknowledgements

Extend the existing human document/acknowledgement foundation rather than creating a consent system. Support school announcements, immutable version, intended recipient, delivery/receipt evidence where available, guardian identity, acknowledgement timestamp and permission-safe reminders. An ordinary acknowledgement is never represented as legal consent or e-signature without an independently approved legal workflow.

## F. Guided onboarding and data migration

Build on Migration Center and HQ onboarding foundations: school/profile/program/membership/staff/schedule/payment-provider setup, family/student/membership/rank import, curriculum basics and optional AI configuration. CSV mapping, preview, duplicate detection, validation, row errors, safe rollback/recovery and audit must remain human-reviewed. Core CRM must work without AI setup.

## Blueprint 2.3 dependency order

1. Preserve and complete current HQ task-profile control-plane milestone.
2. Complete Essential/Core/Complete entitlement enforcement and governed AI employee/Action Engine integration against existing slices.
3. Use the completed advanced-attendance and deterministic-readiness boundaries before any future progression integration; completed ClassPass remains nonfinancial and does not alter either domain.
4. The direct-human manual-nonfinancial ClassPass & Walk-In foundation is complete on existing membership/billing/scheduling/capacity/attendance. The completed `0122` Kiosk handoff now uses only opaque terminal/claim verification and human staff recovery; it deliberately does not admit, redeem, book, check in or record attendance. Any future kiosk completion must remain on the reviewed ClassPass/check-in authority boundary.
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
