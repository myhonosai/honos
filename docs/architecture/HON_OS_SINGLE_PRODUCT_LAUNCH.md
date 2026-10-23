# HON OS — Single-Product Launch Decision and Execution Plan

Status: **Owner-approved strategic direction for development planning** (2026-10-23). This document authorizes preparation of scoped, reviewable work; it does **not** authorize merging, deploying, activating paid access, executing payments, or modifying persistent databases.

## Decision: one product, one brand, one new-customer offer

- The customer-facing brand and product name is **HON OS** — **not** HON Complete.
- At initial commercial launch, offer **one complete product** to new schools. Do not publicly sell or compare Essential, Core, and Complete as three choices.
- Use the **former Complete vision** as the long-term feature direction: conventional CRM/operations plus an AI operating layer, human approvals, voice/text, automation and AI employees as those capabilities become real and secure.
- **One commercial product does not mean every planned AI function already works.** Release features in verified phases, and describe unavailable or forthcoming functionality accurately. No simulated autonomous actions or implied readiness.
- Existing Essential/Core/Complete references, historic entitlements, provider evidence, prices, receipts, and billing/credit ledgers are **not** erased or converted by this directive.
- Internal entitlement and policy boundaries remain mandatory, including active/suspended restrictions and existing data access. Do not replace domain authorization with a frontend-only “all features” flag.
- Existing HON HQ roles, school/staff/family permissions, tenant isolation, audit, human command requirements and Stripe TEST_MODE separation are unchanged.

### Draft pricing assumptions (require final owner approval before any commercial activation)

- Single regular public price candidate: **$249/month per school**.
- Limited founding-school **price** candidate: **$149/month** for the same available product, not a functionally reduced tier; initial **20–30** founding schools is a planning range, not published inventory.
- Former Complete **12,000 AI credits/month** is a planning hypothesis, **not** a live allocation, unlimited usage promise or provider-cost guarantee. Measure provider + hosting + voice + support costs before publishing an enforceable allowance. Conventional software should not consume premium AI credits.
- **No new lifetime offers** in the initial launch. Existing recorded lifetime or other contractual entitlements must remain unchanged.
- No additional customer-facing functional tiers at initial launch. Future expansion is a separate product decision.
- No real collection, Stripe-live checkout, revenue recognition or access activation without separate owner-approved terms and proven provider/entitlement policy.
- Founder offers must accurately state what is available now and the service start/delivery and cancellation/refund terms. Do not charge for undeliverable promises.

## Engineering approach: hide commercial complexity without destroying protections

1. **Audit** all catalog, pricing, checkout, HQ founder inventory, entitlement, AI allowance, invoices/refunds, grandfathered records, and subscription-status surfaces. Produce a matrix: (a) safe to simplify for NEW sales, (b) must remain for existing/historical data, (c) requires separate owner decision, (d) backend dependency.
2. Prefer one canonical **new-sale offer identifier** and an unambiguous backend-owned published offer/capability policy; never infer authorization from client-visible SKU, plan label, a checkout URL, or a single `Complete` string.
3. Update public pricing and new-sale selection to show only **HON OS** after the backend policy is reviewed; do not delete internal catalog/ledger/history fields. Preserve signed-session school/organization identity and purchaser authorization.
4. Founding and regular prices are **commercial offers for one functional product**, with auditable eligibility, published term versions, expiry/inventory and provider verification—not separate functional levels.
5. Reconcile commercial labels in new-customer pages, onboarding, marketing, invoice descriptions and support docs. Historical receipts may retain their original plan labels.
6. Add end-to-end tests for single-offer availability, founder discount eligibility, idempotency, multi-school ownership, restricted runtime, private billing data, prices and capability enforcement, canceled/failed checkout, refunds and replay. Fail closed when B6 activation is INACTIVE.
7. Do not begin production migrations or rewrite protected B6/Stripe activation mechanics simply to remove a dropdown. When data models require a change, submit a narrow separately reviewed migration and compatibility plan.

## Beta product: smallest reliable complete experience

**Launch candidate** (all items require actual connected tests, not just route existence):
- Signed and school-scoped onboarding; school administrator and staff permission boundaries.
- Lead → trial → attendance → registration → guardian/child payer → membership preparation → authorized activation.
- Usable student, family, school operations, schedule, attendance, renewal and member-status interfaces.
- Membership date previews/confirmations, history, legacy UNDATED review and parent privacy, coordinated with E1b-1/E1b-2.
- Accurate basic owner dashboard/reporting and actionable retention/administration work.
- Reliable subscription checkout/account state, payment-to-entitlement proof and failure/recovery lifecycle **before paid activation**.
- A **small number of real AI-assisted workflows** that produce clearly attributable work, require appropriate approvals, and have bounded usage and provider costs.

**Long-term Complete vision, not a day-one marketing promise:** fully coordinated AI employees, proactive autonomous operations, durable agent delegation, broad third-party integrations, advanced voice/AI media, mature parent mobile capabilities and the entire marketplace/community vision.

Do not claim “full AI management team working” until corresponding execution, cost and audit proofs exist.

## Priority order and owner gates

**P0 — security and core correctness**
- Independently review Node.js patch PR #55; confirm patched CI runtime. Separately address `engines.node`, developer/cloud/staging/runtime versions before any next provider-connected test.
- Do not deploy while known-minor registration recovery, migration-history verification, stale manual fixtures, parent draft-visibility or other existing documented blockers remain unresolved.
- Preserve prior E1a activation/cancellation and E1b-1 (0178) protections.

**P1 — pilot workflow and independent frontend**
- Codex completes E1b-1 date management under issue #56, based on merged 0178. One unmerged frontend PR with signed-session and disposable-db browser verification.
- Claude scopes E1b-2 parent visibility, health score and known-minor registration remediation as separately reviewable backend work when authorized.
- Build a usable synthetic and then expressly authorized first-school staging walkthrough, with no invented feature completion.

**P2 — commercial single-offer implementation**
- Claude audits B1–B6 and proposes the safest **one new-sale SKU** contract and grandfathering/test matrix; one focused PR at a time.
- Codex then updates the public pricing and new-sale checkout selection **against an independently reviewed merged backend contract**.
- Keep existing HQ and customer billing histories, refunds, credits, historical tier references, and financial safety conditions functional.

**P3 — validation and demand**
- Start with independently owned martial-arts/Taekwondo schools, initially around 100–250 students as a working ICP, not a market-size assertion.
- Seek 10–20 discovery/pilot conversations, solicit willingness-to-pay evidence, manually onboard initial pilots, capture requests by frequency/value/effort, and test retention/word-of-mouth before increasing paid advertising.
- YouTube supports education, founder trust and evergreen problem-solving; do not market undelivered features or promise revenue.

## Go/no-go standards

**Private beta GO** requires verified auth/RLS, usable complete lead-to-member journey, no known child/guardian privacy bypass, fresh browser and disposable database regression evidence, controlled synthetic/staging test data, clear limitations and rollback/recovery plan.

**Paid launch GO** additionally requires the owner-approved offer and terms, measured AI/provider economics, verified live/sandbox separation and processor webhooks, onboarding, tested B6 subscription activation/recovery/grace/cancel behavior, support/cancellation policy and signed owner approval.

**Current production deployment status: NO-GO.** Creating/merging documentation or feature PRs does not lift the gate.

## Team and workflow

- **Claude:** backend/security, one canonical offer policy, protected billing, migration and AI boundary work.
- **Codex:** E1b-1 date management first; afterward one-product commercial UX only against an approved stable backend contract.
- **Manus:** when separately activated after the credit reset, 60% QA/integration/launch preparation and 40% isolated approved coding, within agreed credit limits. No concurrent modifications of the same protected files.
- **Owner:** explicitly approves merge, persistent migrations, production deployment, provider spending and changes to commercial terms.
- All agents use separate branches, one focused PR, CI, independent review, complete status/known blockers and no self-approved tasks.

## Authority and compatibility

This strategic decision **supersedes only the new-customer public packaging and launch commercialization goal** described in `docs/HON_MASTER_DIRECTIVE.md` (section 3, three tiers, and related public catalog examples). It does **not** automatically replace existing backend function contracts, grants, migration history, legacy entitlement records or verified safety invariants. Source changes must be reviewed individually.
