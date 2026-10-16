# Blueprint Update 2.2 — integration map

**Source of authority:** [HON Master Directive](../HON_MASTER_DIRECTIVE.md), [Blueprint Update 2.1](BLUEPRINT_UPDATE_2_1_INTEGRATION_MAP.md), and the approved October 2026 Blueprint 2.2 amendment.

**Purpose:** add **HON ClassPass & Walk-In**, **HON Self-Service Kiosk**, and **HON AI Model Intelligence & Routing** to the same governed HON OS without creating duplicate billing, scheduling, identity, AI, or execution systems. This is additive. It does not replace existing Essential/Core/Complete behavior, AI employee identities, customer pricing, credit allowances, Action Engine authority, or previous implementation priorities.

## Non-negotiable constraints

1. **One platform and one authority path.** New flows reuse transaction-bound tenant scope, forced RLS, verified principals, live permissions, entitlements, normal domain services, idempotency, audit/outbox, and the Action Engine where a consequential action is proposed.
2. **Conventional software first.** ClassPass, walk-in, kiosk, school operations, and parent experiences remain useful with AI, voice, and any external provider unavailable.
3. **AI is not authority.** Model output may analyze, draft, summarize, classify, plan, and propose. It cannot bypass tenant scope, roles, entitlements, financial restrictions, communication consent, human approval, or audit requirements.
4. **No unreviewed provider activation.** Existing validated routes remain intact until a replacement candidate passes relevant HON evaluation tests. No paid provider call, production deployment, model-default change, or customer-facing external action is authorized by this map.
5. **Presentation is not a security boundary.** Big-Button/Phone, Modern HON, and Classic/Agency modes use the same APIs, scope checks, permissions, and domain records.

## A. HON ClassPass & Walk-In

### Existing components to reuse

- School-owned class sessions, booking modes (`WALK_IN`, `OPTIONAL_BOOKING`, `REQUIRED_BOOKING`), capacity, cancellation, attendance, and exact class-booking integrity checks.
- Membership, billing-account, invoice, payment-attempt, entitlement, idempotency, audit, and transactional-outbox foundations.
- Existing restricted runtime role, school/organization ownership, and action/provider boundaries.

### Bounded missing functionality

- A school-configured ClassPass product/allowance and a server-controlled redemption ledger that is distinct from membership term, payment schedule, payer, and participant.
- A governed human/UI purchase and reversal lifecycle only after the payment/reconciliation boundary is ready. No raw card handling, inferred payment success, automatic refund, or AI-created credit.
- A deterministic admission/redeem decision for an eligible scheduled walk-in, including school/program/class eligibility, capacity/waitlist behavior, expiry/remaining-use rules, idempotency, optimistic concurrency, audit, and an inert/local-only outbox until a reviewed consumer exists.
- Staff/parent views that clearly distinguish a booking, a walk-in eligibility decision, a redemption, attendance, and an unknown payment/provider outcome.

### Dependencies and security requirements

ClassPass follows reliable membership, billing, scheduling, attendance, and provider-reconciliation foundations. It must never bypass class capacity, school ownership, human financial authority, payment reconciliation, or receipt evidence. It must not turn a trial, a generic customer record, or an AI proposal into a redeemed pass.

### Acceptance evidence

A disposable-local integrity suite must cover two schools, cross-school denial, capacity and waitlist outcomes, duplicate/concurrent redemption, expiration, allowed and forbidden reversals, role/tier revocation, RLS/ACL posture, audit/outbox atomicity, and absence of direct payment/provider calls. No live payment test is implied.

## B. HON Self-Service Kiosk

### Existing components to reuse

- The completed ClassPass admission/redemption service, check-in/attendance boundary, school context, session authentication, and conservative unknown-outcome behavior.

### Bounded missing functionality

- A kiosk-device/session model with a sharply limited school/terminal scope, short-lived interaction state, safe reset/lock behavior, and an explicit staff recovery path.
- A minimal self-service discovery and check-in flow that never becomes a directory, exposes private family/student/payment information, or treats a scan/tap/provider response as success without server verification.
- Clear unavailable/needs-staff states for capacity, missing eligibility, ambiguous identity, unknown payment/reconciliation, and provider/outage conditions.

### Dependencies and security requirements

Kiosk follows the ClassPass and check-in backend rather than duplicating admission, attendance, payment, or identity logic. It has no general staff/HQ authority, cannot change membership/pricing, cannot issue credits/refunds, cannot view protected records beyond the exact verified interaction, and never receives raw payment credentials.

### Acceptance evidence

Validate device/session expiry, terminal-school isolation, replay and concurrent scans, cross-school and ambiguous-identity denial, screen reset/redaction, no directory enumeration, staff-only recovery, and no external payment or message effect without separately approved adapters.

## C. HON AI Model Intelligence & Routing

### Existing components to reuse

- HQ provider control plane: code-owned provider registry, provider connection health, immutable catalog records, tenant-bound ordered routing policies, capability/modality checks, tier checks, cost budget selection, exact versioning, audit, and no authority gain from routing.
- Invocation planning: policy/catalog/provider snapshots, provider cost and customer-credit ledger records, durable work, Action Engine proposals, idempotency, and conservative `UNKNOWN` handling.
- Existing focused AI employee routes: Marcus marketing drafts, Claire teaching drafts, and Chad follow-up drafts. They retain their fixed task scope, human review, and no-delivery boundaries.

### Current live OpenRouter catalog check — evaluation candidates only

The public OpenRouter catalog was queried on **2026-10-16** without an inference request. The proposed candidates are currently routable exact IDs:

| Candidate name in amendment | Verified current OpenRouter ID | Catalog observation | HON status |
|---|---|---|---|
| GPT-6 Luna | `openai/gpt-6-luna` | Text/image/file input; structured output and tools advertised; 1,050,000-token catalog context; multiple provider endpoints | **Evaluation candidate only** |
| Gemini 3.8 Flash | `google/gemini-3.8-flash` | Text/image/file/audio/video input; structured output and tools advertised; 1,048,576-token catalog context; multiple Google endpoints | **Evaluation candidate only** |
| Claude Sonnet | `anthropic/claude-sonnet-5.5` | The amendment's family label maps to this current concrete Sonnet candidate; text/image/file input; structured output and tools advertised; 1,000,000-token catalog context | **Evaluation candidate only** |

The public catalog is time-sensitive. Every production candidate must be re-read through the provider catalog immediately before HQ registration, including exact ID, current price, supported parameters, endpoint availability, data policy, regional/provider restrictions, and expiration status. HON must persist concrete IDs, not `latest` aliases, in an approved catalog record. The current catalog check does **not** assign any production default or invoke a paid model.

### Missing functionality

1. **Task profiles, not a second gateway.** Extend the existing policy/catalog path with reviewed task profiles for agent + task category. Each profile will reference an approved default, ordered fallback(s), optional advanced-reasoning candidate, required capabilities/modalities, per-request budget, timeout/retry category, and provider/privacy restrictions. These settings cannot grant tools or authority.
2. **Provider-aware invocation adapter.** Preserve the existing HON provider runtime boundary while translating an approved route profile into explicit OpenRouter provider constraints such as provider order/allow list, fallback policy, required parameter support, data-collection/ZDR policy, latency/throughput preference, and price ceiling. Never expose this capability to the browser or model.
3. **Delivered local/mock evaluation harness.** [Local / Mock AI Model Evaluation](AI_MODEL_EVALUATION.md) compares candidate metadata against identical privacy-safe fixture IDs with the required **35% / 25% / 20% / 10% / 10%** scorecard, hard structured-output/permission/hallucination/escalation/consistency gates, deterministic no-I/O ranking, and no production assignment. Its reusable manifest covers marketing, sales, teaching, permission compliance, hallucination risk, escalation behavior, and repeated consistency. Local fixture content and any model call remain outside product source/runtime until separately reviewed and authorized.
4. **HQ evidence and reporting.** Extend the existing usage ledger/reporting projection only where necessary to relate requested versus actual model, task category, selected provider endpoint, latency, fallback/retry outcome, and relevant Action Engine/work-item evidence. Preserve approved credit allowances and pricing.

### Task-based routing policy

The approved candidate matrix remains **evaluation-only**, not hard-coded customer defaults or an entitlement/authority map:

| HON function | Primary evaluation candidate | Advanced evaluation candidate |
|---|---|---|
| General AI Assistant | `openai/gpt-6-luna` | `google/gemini-3.8-flash` |
| Marcus — Marketing | `google/gemini-3.8-flash` | `anthropic/claude-sonnet-5.5` |
| Chad — Sales | `openai/gpt-6-luna` | `google/gemini-3.8-flash` |
| Claire — Teaching | `google/gemini-3.8-flash` | `anthropic/claude-sonnet-5.5` |
| Retention AI | `openai/gpt-6-luna` | `anthropic/claude-sonnet-5.5` |
| School Command Center | `openai/gpt-6-luna` | `google/gemini-3.8-flash` |
| AI Workflow Planning | `openai/gpt-6-luna` | `anthropic/claude-sonnet-5.5` |
| Simple Classification | smaller validated structured-output candidate | escalate through an approved profile only when necessary |

The following functions remain **candidate evaluation categories**:

- General assistant: everyday operations/questions versus complex business reasoning.
- Marcus: everyday copy, campaign creation, advertising analysis, and complex campaign strategy.
- Chad: lead conversations, follow-up drafts, objection handling, and membership recommendation drafts.
- Claire: lesson planning, curriculum assistance, testing preparation, and advanced instructional planning.
- Retention and School Command Center: explained operational summaries, retention evidence, and strategic recommendations.
- Simple classification: a smaller validated structured-output candidate with automatic escalation only through a reviewed profile.

A stronger or more expensive model is selected only when the approved task profile, capability requirement, and budget warrant it. Every request remains server-controlled and progresses through the same Action Engine/normal-domain-service path for anything consequential.

Essential, Core, and Complete remain the existing subscription tiers and are not a proxy for model intelligence. Each tier must retain a useful, reliable general AI assistant within its approved product surface and allowance; higher tiers may unlock advanced workflows, automation, and premium AI usage allowances. This map changes neither approved customer pricing nor credit allocations.

### Acceptance evidence

Before a model may become an HQ-approved production default, prove with local/mock fixtures that the selected concrete model/profile is capability-compatible, schema-valid, privacy/provider-policy compliant, budget-bounded, timeout/retry safe, redacted in audit logs, and unable to escalate authority. Then require an explicit owner-authorized bounded provider validation; record actual provider, model, tokens, cost, latency, fallback/retry state, and resulting Action Engine/work-item evidence. No benchmark, catalog listing, or provider claim alone is sufficient.

## Sequence and priority

1. Finish and retain the validated current foundations; do not redesign them around this amendment.
2. Build ClassPass only after dependable membership/billing/scheduling/attendance contracts are reused.
3. Build Kiosk only after ClassPass and the check-in backend expose a bounded, auditable admission result.
4. Progress AI model intelligence alongside AI employee infrastructure: start with contracts, fixture evaluation, and HQ evidence; defer production model defaults and paid validation until separately approved.
5. Apply the requested three AI-avatar styles as presentation assets only. They do not alter employee identity, permissions, pricing, routing, or authority.

## References

- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- [OpenRouter provider routing controls](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Live public OpenRouter model catalog](https://openrouter.ai/api/v1/models)
