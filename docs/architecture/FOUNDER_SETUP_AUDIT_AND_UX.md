# Founder Setup: source audit, UX and contract inventory

Audited canonical main: `f5815e0a9259418e68a5f7ee573074b9e6ee9fa3` (183 migrations, highest0191; reserved0179/0180 untouched). PRs90/92 and their branches are not modified. During verification, PR92 was externally accepted as main `b234be7f14c49d07349219dfb4ae3b9c2a05d3f9`; it is inherited unchanged through a normal merge. The onboarding audit remains source-equivalent: no onboarding backend or migration changed. This is a bounded frontend guide and review proposal, not commercial launch authorization.

## Implemented versus missing

| Area | Source-backed implementation | Gap / boundary |
| --- | --- | --- |
| Owner account | `SCHOOL_OWNER_ACCOUNT_PROVISIONING.md`, accounts controller,0191: HQ-owner invitation, verified-email/subject binding, expiration, single use, revocation, replay and two-organization proofs; account UI exists | No self-service signup, automatic invitation delivery, staff/parent invitations or replacement-identity recovery. Reader-first verified-email rollout and real OIDC validation remain deployment gates. Login does not grant operating access. |
| Organization/school | D9 `HON_SECURE_HQ_PROVISIONING.md`,0185: governed suspended provisioning; HQ directory minimizes identity/status fields | No verified self-service legal/business-profile edit/read contract or aggregated onboarding progress. Legacy `HqOnboardingPanel` advertises old tier selection; it is not reused or modified. Never bypass SUSPENDED entitlement to make setup look usable. |
| Roles/users | `HUMAN_STAFF_ROLE_ADMINISTRATION.md`, staff-role controller, `/staff/roles`: authorized custom roles and grants for already registered principals | Role administration is not account creation, staff invitations or parent access. Bootstrap HQ versus permanent school OWNER policy remains unresolved. |
| Programs/classes | `/staff/launch`, `GET /owner-launch`, ProgramController and ClassSessionController: explicit program and class commands, canonical saved receipts | Owner Launch needs one unambiguous active school/entitlement and its complete permission set; multi-school/awaiting-payment owners can be denied. Receipts are requester-owned creation evidence, not a complete school inventory or current eligibility. No setup-template bulk import or school-wide timetable completeness contract. |
| CRM/students | Merged adult/family CRM registration, Resume Setup0174/0176, plan catalog0175, activation0177 and membership-date0178; existing protected staff workbenches | Historical registration is not current membership. Staff review, family identity resolution, consent, agreements, parent provisioning and payment lifecycle are separate. This guide does not fetch student names/contact/family details or activate memberships. |
| Assistant/help | Existing global HON launcher, `/staff/hon`, governed tools and saved AI-work interfaces; three presentation modes and authenticated EN/KR/ES preferences | Agent portrait, help text or a setup visit is not executed work or authorized inference. This guide uses deterministic help only. No support-ticket submission/delivery contract; HQ support page is planned. |
| Trial/subscription | School subscription/invoice read contracts, A1/A2/B1 foundations, D10 exception governance and D11-A metadata | Paid access/AI runtime remain inactive as shipped; no approved trial enrollment/conversion runtime or founder-promotion acceptance contract. PR90 billing work is untouched. The guide neither exposes new plan tiers/lifetime sales nor promises a founder allocation, price, trial, credits or access. |

Evidence comes from actual controllers/contracts and routes, not old TODO completion labels. Existing PostgreSQL proofs establish the above backend boundaries; historical evidence is not presented as fresh execution for this frontend. A login-only owner with suspended access must see the guide/help and a truthful denied state, not a fixture substituted for authorization.

## Entry points and frontend boundary

- `/staff/founder-setup` uses the existing signed-session gate and adds an ordinary localized entry link on `/staff/launch`.
- `/hq/founder-setup` reuses the existing HQ shell/session gate and independently authorized minimized directory API. No shared shell/navigation/asset or protected visual source is changed.
- The existing normalized `public/manus-routes.json` receives only these two paths; route metadata never grants authority.

## Eight-step UX

1. Welcome: one HON OS product, concise plan for setup and explicit authority/activation limits.
2. School/business: display only the verified school name after an explicit read; business-profile editing is unavailable, with an HQ handoff explanation.
3. Staff: explain existing role management for known principals; invitations/parent access unavailable.
4. Programs/schedule: link existing explicit Owner Launch and schedule workflows; show only requester-owned saved program/class creation evidence.
5. CRM readiness: prerequisites checklist and links to current CRM, migration and membership plan workbenches. A saved registration receipt never verifies current DRAFT/activation.
6. HON introduction: static contextual help plus the existing governed HON workspace. No provider/credit calls from this guide.
7. Review: count **three bounded creation-evidence categories**, never an eight-step completion percentage. Unknown business, staff, payment, trial, parent and AI state stays unknown.
8. Support/tutorial center: searchable local EN/KR/ES answers, concise text walkthroughs, a copyable non-sensitive support outline. Submission remains disabled and explicitly unsent.

Navigation and guide mode are in memory only. Existing saved backend receipts survive navigation/refresh and can be reread explicitly; no new checklist state is persisted. Presentation controls affect only this mounted guide, never overwrite an appearance preference. Global language/region settings remain independent.

HQ gets its own protected route: explicit existing authorized directory read, minimized names and unknown onboarding progress, plus a separately labelled synthetic progress prototype. It never calls staff endpoints, infers founder status from entitlement tier, or converts directory statuses into setup completion. No real founder cohort filter, business metrics, ticket count or progress total is invented. All navigation links are ordinary inert links; destination APIs authorize independently.

## Privacy and integration

Reuse shared contract validators for `GET /owner-launch` and `GET /hq/schools`; no new API. Reads are user-triggered, same-origin/no-store/redirect-error and bounded by timeout. Identity is checked before and after the protected read; mismatched identities are discarded. Minimize parsed data before React state. Clear facts, errors and copy feedback immediately on blur, hidden document, pagehide, session invalidation or school change; abort/invalidate pending reads, ignore late responses and require explicit restoration.401 broadcasts shared invalidation;403 remains local denial. No sensitive state, receipt IDs, queries or retry keys enter storage/URLs/telemetry. There are no consequential commands or automatic retries.

## Required backend and owner decisions (not implemented)

- Claude/backend: minimal pre-activation exact-owner setup read and reviewed profile-update commands; multi-school selection authority, canonical business facts and school-local timezone. Do not weaken existing active-entitlement gates.
- Claude/backend: versioned school-wide onboarding evidence/progress read and optional explicit checklist policy, exact-school permissions, per-item provenance/current versus historical state, freshness and owner/HQ projections. HQ must not impersonate staff. Avoid per-school fan-out for the50-school cohort; authoritative pagination and cohort/allocation identity are needed.
- Claude/backend: non-escalating staff invitations and separate family-safe parent invitations; secure recovery/ownership handoff, identity reconciliation and staff-review resolution.
- Backend/owner: ticket contract, approved support channel, minimal data/retention/consent, delivery evidence and escalation policy; this PR records no request as sent.
- Owner/commercial: founder eligibility/reservation and50-paying-organization allocation, trial/paid access approvals, AI spending limits and real activation sequencing. Complete-level product vision is not a public Core/Complete selector or operational entitlement claim.
- Owner: verify setup workflow/priorities and support resources. No onboarding score, milestone approval, trial policy or financial policy is approved by the design.

Launch remains blocked by these runtime/operational dependencies. A polished setup guide is not a complete self-service SaaS onboarding system. Future work should add authoritative progress/profile and staff invitations as separate reviewed backend slices, then connect them without replacing this UX.

## Current-main refresh (2026-11-01)

Starting PR #94 head: `43ef4a9b714cbe76297d38bc8ad932f3abbaa532`. Accepted main: `6ab871cd781935fc633dfec7685075b3d95432be`. The only main changes since the previous integration are PR #99's three test/fixture files for deterministic month-end proofs. They are inherited with a normal two-parent merge, without conflict, historical migration edits or production billing changes. The earlier source audit and its test evidence remain historical; fresh results belong to the new exact-head PR/CI report.

The application, copy, routes, backend boundaries and eight-stage scope are unchanged. Expanded regressions exercise all eight stages in all three modes and languages, including inert destination links, unavailable controls, review disclaimers and no extra protected reads. Fresh browser verification covers 390/834/1440 widths, keyboard Enter/Space and focus visibility, all-stage accessibility, explicit reads/restoration, late-response rejection and separate HQ 401/403 behavior. HQ directory evidence never becomes an onboarding score, founder cohort, payment or activation fact; the optional synthetic example remains separately labelled. Synthetic browser API responses are not live IAM/RLS or real API/database proof.

PR #95 was inspected read-only at `773242af2a058f9286adba119895619a0dc4f607`. The CRM-readiness link remains `/staff/crm/leads`, which #95 preserves and extends with ordinary journey navigation. Each destination must independently authorize an explicit read; Founder Setup passes no student/family/receipt/permission evidence and imports no unmerged CRM code. The routes/components do not overlap. The additive `TODO.md` and `apps/web/public/manus-routes.json` entries from both PRs must be retained during any later owner-approved integration; this refresh does not merge or edit #95.

PR #94 stays draft. Current workspace/typecheck/build/migration and browser evidence must be taken from its latest exact head; the ordinary CI draft-skip is not a pass. Real owner/HQ API/database proof evidence remains the existing backend suite, not a fresh result of this frontend-only refresh. Pre-activation setup authority, profile editing, staff/parent invitations, shared durable progress and support delivery remain separate launch dependencies.
