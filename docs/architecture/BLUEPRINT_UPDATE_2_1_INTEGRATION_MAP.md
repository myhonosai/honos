# Blueprint Update 2.1 — integration map

**Source of authority:** `docs/HON_MASTER_DIRECTIVE.md` plus the October 2026 enhancement directive.
**Purpose:** sequence the enhancements through existing HON domain boundaries without replacing validated foundations or creating a parallel AI, CRM, identity, billing, or progression system.

**Additive continuation:** [Blueprint Update 2.2](BLUEPRINT_UPDATE_2_2_INTEGRATION_MAP.md) adds ClassPass & Walk-In, Self-Service Kiosk, and AI Model Intelligence & Routing without changing this map's security or delivery constraints.

## Guiding constraints

1. **Optional value:** Teaching, assessment, parent, Health Score, and AI-support capabilities remain optional additions. A school continues to operate with ordinary CRM, attendance, schedule, billing, curriculum, and staff workflows.
2. **One governed platform:** New experiences reuse PostgreSQL tenant scope/RLS, verified identity, permissions, tier entitlements, audit/outbox, normal domain commands, Action Engine approval, durable work, and provider-cost/credit accounting.
3. **AI is not authority:** AI can explain, draft, summarize, plan, and propose. It cannot promote students, alter curriculum, publish externally, change pricing, grant concessions, or make consequential decisions outside the existing policy/approval path.
4. **No Manus runtime dependency:** Runtime model use is routed through HON-owned provider boundaries. Manus remains a development environment only.

## Phase 0 — completed bounded provider milestone

The first OpenRouter Marketing Assistant generation was completed under a one-time owner-approved paid-call gate. It proved the existing provider-neutral route selection, tenant scope, Complete entitlement, private draft evidence, `CONFIRM` Action Engine proposal, audit/outbox, and usage-cost/credit ledger path. No public delivery, publishing, marketing-content save, recurring worker, or automatic action was enabled.

See [OpenRouter Marketing Assistant live validation](OPENROUTER_MARKETING_ASSISTANT_LIVE_VALIDATION.md).

## Phase 1 — reuse and gap analysis

| Enhancement area | Existing HON foundation to reuse | New bounded gap | Priority |
|---|---|---|---|
| **School Command Center** | Staff operations dashboard, CRM, attendance, renewals, Action Engine approval workbench, durable work items, deterministic revenue planner | One school-scoped read model, deterministic briefing and explained navigation recommendations; local card visibility | Active next slice |
| **School Health Score** | Operations reporting, revenue planner, attendance, trials, renewals, work items | Transparent optional formula/version/weights, sufficient-data states and explainable category evidence | After Command Center snapshot |
| **Enrollment and retention** | CRM leads, trials, membership renewal, attendance, planned absence, follow-up workbench, campaign attribution | Cross-domain review queues and conservative observable indicators; no cancellation prediction or automatic action | After Health Score inputs |
| **Teaching Studio** | Curriculum/rank/testing foundations, instructor progress records, attendance, student achievement, governed knowledge | Optional lesson plans/history, resource library, quick instructor assessment workflow and staff mobile presentation | Parallel after Command Center contracts stabilize |
| **Digital testing aids** | Testing event, candidate, grading, human promotion decisions and family testing registration interest | Optional scorecards/readiness lists/multi-examiner review; no automatic promotion | After Teaching Studio facts exist |
| **AI Teaching Assistant** | HON AI Team, provider control, invocation planning, Action Engine, durable work, credit economics | Narrow teaching draft/summarization tools using approved curriculum only, explicit approvals and no consequential student mutation | After Teaching Studio human workflows |
| **Parent Student Journey expansion** | Family scope resolver, guardian-safe student journey, parent documents/testing/absence and parent references | React Native/Expo client, child switcher, approved resources/achievements/readiness presentation | Reuses existing parent-safe read model |
| **Presentation modes** | Shared design tokens and the existing Big-Button, Modern, and Classic references | Apply mode-specific presentation to new scoped workbenches; never alter scope/tiers/authority | Continuous UX constraint |

## Implemented foundations that must not be duplicated

- **Identity and scope:** verified human, staff, family/guardian, and distinct HQ access paths.
- **Tenant enforcement:** transaction-bound PostgreSQL context, forced RLS, composite ownership, restricted `hon_runtime` Session Pooler role and fixed callable boundaries.
- **Commercial authority:** active organization entitlements; Essential, Core, and Complete are server-resolved, not client-selected.
- **Consequential commands:** optimistic versions, idempotency, append-only audit/outbox and Action Engine authority/approval state.
- **AI platform:** provider control plane, routing policy, invocation planning, provider/cost ledger and Complete AI Team configuration.
- **Student progression:** school-defined curriculum/rank/version requirements, instructor observations, testing and human promotion—not attendance-driven auto-promotion.

## Ordered next delivery milestones

1. **Deterministic School Command Center:** actual, redacted operational signals; explicit unavailable/insufficient data; voluntary navigation recommendations; local configurable cards; no AI required.
2. **School Health Score foundation:** formula/version and category evidence only after its source facts are explicit and data-sufficiency gates are defined.
3. **Teaching Studio human foundation:** optional lesson plan/history/resource/assessment capabilities that do not change required attendance, testing, or promotion workflows.
4. **Retention review surfaces:** observable attendance/renewal/follow-up/progression signals, separated from prediction claims and financial authority.
5. **AI Teaching Assistant:** approved-content summarization/drafting through the existing provider, Action Engine, durable-work, approval, and credit boundaries.
6. **Parent and mobile integration:** use the existing guardian-safe projections; build a purpose-built Expo client rather than treating reference web screens as the parent product.

## Deferred owner or external decisions

- Legal e-signature/compliance provider selection.
- External provider execution beyond the approved bounded OpenRouter text validation, including HeyGen, Higgsfield, direct LLM adapters, advertising, social publishing, messaging, payments, and push.
- Any change to pricing, subscription tiers, founder offers, customer credit allowances, or autonomous authority policy.
- A production rollout or cross-school beta activation.

This map is intentionally additive. It tracks missing vertical slices rather than relabeling foundations as complete or weakening their access controls.
