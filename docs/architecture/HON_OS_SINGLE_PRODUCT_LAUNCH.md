# HON OS — One Product, Multiple Payment Offers: Launch Decision and Execution Plan

Status: **Owner-approved strategic direction for development planning** (2026-10-23). This document authorizes preparation of scoped, reviewable work; it does **not** authorize merging, deploying, activating paid access, executing payments, or modifying persistent databases.

## Decision: one product, one brand, multiple configurable new-customer payment offers

- The customer-facing brand and product name is **HON OS** — **not** HON Complete.
- At initial commercial launch, offer **one complete product** to new schools: HON OS. Do not publicly sell or compare Essential, Core, and Complete as three functional tiers. **Do offer different billing commitments and purchase terms** for the same HON OS capability policy.
- Use the **former Complete vision** as the long-term feature direction: conventional CRM/operations plus an AI operating layer, human approvals, voice/text, automation and AI employees as those capabilities become real and secure.
- **One commercial product does not mean every planned AI function already works.** Release features in verified phases, and describe unavailable or forthcoming functionality accurately. No simulated autonomous actions or implied readiness.
- Existing Essential/Core/Complete references, historic entitlements, provider evidence, prices, receipts, and billing/credit ledgers are **not** erased or converted by this directive.
- Internal entitlement and policy boundaries remain mandatory, including active/suspended restrictions and existing data access. Do not replace domain authorization with a frontend-only “all features” flag.
- Existing HON HQ roles, school/staff/family permissions, tenant isolation, audit, human command requirements and Stripe TEST_MODE separation are unchanged.

### Commercial payment offers — prices are configurable later in HON HQ

**One product ≠ one price / one SKU.** Design one customer-facing HON OS product / consistent capability policy, with multiple independently identified, backend-authorized offers:

| Offer type | Billing behavior | Initial treatment |
| --- | --- | --- |
| Regular monthly | Recurring monthly | Regular reference price candidate $249/month; final amount HQ-configurable |
| Regular annual | Recurring annually (one year's payment and annual renewal) | Amount / discount and renewal terms configured by HQ, not hard-coded |
| Founder monthly | Recurring monthly; eligibility and founder-slot limited | Candidate $149/month; eligibility, duration and price guarantee configured in HQ |
| Founder annual | Recurring annually; same founder eligibility | Separate annual amount, guarantee and renewal policy, HQ-configured |
| Lifetime | One-time payment for clearly specified ongoing HON OS entitlement, not unlimited free variable-cost consumption | Founder/regular eligibility, sales cap, deliverable scope, fair-use AI allowance and service terms require explicit owner approval |
| Founder lifetime (optional distinct offer) | One-time payment, founder inventory/eligibility | Available only if separately published by HQ with approved cost/terms; not implied by all founder discounts |

The owner has expressly requested keeping **founder, annual and lifetime** options. Do **not** delete the lifetime mechanism or permanently forbid new lifetime sales. These are commercial offers for the *same product*, not smaller or larger functional tiers.

**Do not lock final prices into migrations or frontend constants.** Build HON HQ **offer administration** with:
- Authorized HQ-owner controls to create/edit draft offer configuration: display name, availability, exact amount and currency, recurring interval versus one-time, new-sale/legacy-continuation visibility, founding eligibility and capacity, start/end dates, publication status, included premium AI usage and fair-use caps, refund/cancellation/renewal/pause rules, and allowed school/organization scope.
- **Review → publish** as explicit human-approved action with current HQ permission recheck, immutable catalog/offer revision and effective date; changes are audited, optimistic-versioned, idempotent and limited to future transactions.
- A published price change **creates a new immutable Stripe Price or versioned provider mapping** as appropriate; it must never edit a historical charge, reprice an existing subscription, reinterpret a lifetime contract, or silently replace customer consent. Creating provider objects or enabling live Stripe requires separate explicit authorization and a safe test-mode plan.
- New purchases use only the backend-verified, current published offer and provider binding. Never accept client-provided amount, founder qualification, plan or entitlement as authority. B6 stays INACTIVE until separately approved and verified.
- Clear historic and grandfathered contract/receipt references, no destructive migration, and stable continuation paths for old Core and Complete subscriptions.
- Legacy Core and HON OS founder monthly can coincidentally share $149; classify using **offer identity and entitlement kind**, never price equality.
- One HON OS entitlement capability policy is consistent across monthly, annual, founder and lifetime; provider/AI/voice usage allowances and fair-use conditions need explicit financial sustainability validation.
- Track quote/offer version, charged amount, currency, tax status, initial and renewal dates, founder terms, refund terms and paid-service-start status on immutable, inspectable evidence.

**Provisional—not final—commercial examples:** regular monthly $249, founder monthly $149, regular/founder annual and lifetime amounts to be chosen later in HON HQ. Existing historic Complete lifetime price (if any) does **not** automatically become the new HON OS lifetime price. The former Complete 12,000 AI credits per month remains a cost/usage hypothesis, not an automatically granted live allowance.

Founder capacity (initially discussed in the range 20–30) and the exact lifetime sale cap, annual discount, founder price-lock period, refunds, taxes, service guarantees and proration are **HQ owner decisions before the offer is published**. Do not infer these values from the example amounts.

No real collection, Stripe-live checkout, revenue recognition or access activation without separately owner-approved terms and proven provider/entitlement policies. Marketing must truthfully distinguish available versus planned features and paid service start date.

## Engineering approach: hide commercial complexity without destroying protections

1. **Audit** all catalog, pricing, checkout, HQ founder inventory, entitlement, AI allowance, invoices/refunds, grandfathered records, and subscription-status surfaces. Produce a matrix: (a) safe to simplify for NEW sales, (b) must remain for existing/historical data, (c) requires separate owner decision, (d) backend dependency.
2. Prefer one canonical **HON OS product / new-sale entitlement policy**, with multiple canonical **offer identifiers** for payment options and a backend-owned published offer/capability contract. Never infer authorization from client-visible SKU, plan label, price amount, a checkout URL, or a single `Complete` string.
3. Update public pricing and new-sale selection to show only **HON OS**, with HQ-published payment options (monthly, annual, founder, lifetime) after the backend policy is reviewed; do not delete internal catalog/ledger/history fields. Preserve signed-session school/organization identity and purchaser authorization.
4. Regular/founder/monthly/annual/lifetime options are **commercial offers for one functional product**, with auditable eligibility, published term versions, renewal or perpetuity conditions, expiry/inventory and provider verification—not separate functional levels.
5. Reconcile commercial labels in new-customer pages, onboarding, marketing, invoice descriptions and support docs. Historical receipts may retain their original plan labels.
6. Add end-to-end tests for **single-product/multiple-offer** availability, founder and lifetime eligibility/caps, annual renewal, immutable price versions, authorized HQ publish, idempotency, multi-school ownership, restricted runtime, private billing data, prices and capability enforcement, canceled/failed checkout, refunds and replay. Fail closed when B6 activation is INACTIVE.
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

**P2 — single HON OS product, HQ-configured payment-offer implementation**
- Claude audits B1–B6 and proposes **one new-sale HON OS product with multiple HQ-configured authorized payment offers**, HQ draft/publish controls, compatibility and grandfathering/test matrix; one focused PR at a time.
- Codex then updates the public pricing and new-sale checkout selection to show the **one HON OS product and its available payment choices** against an independently reviewed merged backend contract.
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

This strategic decision **supersedes only the new-customer public functional-tier packaging and launch commercialization goal** described in `docs/HON_MASTER_DIRECTIVE.md` (section 3, three tiers, and related public catalog examples). It does **not** automatically replace existing backend function contracts, grants, migration history, legacy entitlement records or verified safety invariants. Source changes must be reviewed individually.
