# Core and Complete entitlement enforcement audit

**Date:** 2026-10-17
**Scope:** Read-only source and committed-test inspection before the Core/Complete enforcement tranche. No provider, payment, production entitlement allocation, external delivery, deployment, or remote database mutation occurred.

## Target boundary

| Tier | Intended commercial boundary | Current safe interpretation |
| --- | --- | --- |
| **Core** | $149/month: conventional school operations, standard staff/parent workflows, standard automation/reporting, planned 5,000 premium AI credits, and a general HON assistant without premium-credit deduction. | Core must remain a real conventional product. Price and 5,000 value are **display/planning metadata only** until commercial and credit economics are separately approved. |
| **Complete** | $249/month: Core plus specialized AI employees, governed delegation, advanced automation/reporting/recommendations, planned 12,000 premium AI credits. | Complete-only boundaries must remain server-enforced and Action Engine/provider controls remain independent of plan display. Price and 12,000 value are **not an active purchased-credit grant**. |
| **Essential** | Legacy/foundation tier from the Master Directive. | Existing active Essential organizations are preserved. This audit does not reprice, deactivate, convert, or remove Essential. |

> The three interface modes—Big-Button, Modern, and Classic—are personal presentation preferences only. They are not tiers and cannot confer a feature, permission, AI authority, provider capability, or credit allowance.

## Implementation matrix

| Area | Implemented and tested | Implemented but not enforced as the requested product boundary | Partial or inconsistent | Missing / blocked |
| --- | --- | --- | --- | --- |
| **Entitlement state** | `organization_entitlements`, active/effective-window reader, forced RLS, function-only runtime read, HQ initial provisioning and committed entitlement boundary tests. | Public $149/$249 and 5,000/12,000 catalog is explicitly non-binding display/planning data. | HQ provisioning accepts legacy Essential/Core/Complete, but no change-plan/upgrade/downgrade transition exists. | Commercial offer, checkout, subscription, payment, active credit grant/allocation, upgrade/downgrade commercial policy, and grandfathering policy. |
| **Conventional Core operations** | Server gates exist for representative CRM, membership foundation, invoice draft/issue, class-session creation, class booking, basic school operations reporting, automation configuration/dry run, Command Center, and direct-human workbenches. Invoice/session/report services now query only the fixed active-entitlement reader as their first tenant-transaction operation and preserve Essential/Core/Complete foundation access. | `TIER_FEATURES` labels Core capabilities but is not universal API enforcement middleware. | Several foundation APIs intentionally allow Essential/Core/Complete; broader endpoint/function coverage is still incomplete. | A complete endpoint/function feature matrix for standard Core operations. |
| **Complete AI / Action Engine** | Complete-only AI Team presentation, invocation planning, selected Marcus/Claire/Chad draft slices, action tier/permission/authority/approval/execution revalidation. | Roster/task profile metadata does not create principals, provider tools, or generic authority. | Eight static AI presentation profiles exist; only three narrow governed draft paths have executable runtime slices. Action Engine execution has a small set of reviewed adapters. | Core general assistant; exact seven-specialist executable model; Complete-wide sales/retention/operational delegation; AI-managed campaigns; advanced recommendations. |
| **AI credits** | Tenant usage ledger projection and 75/90/100 warnings; narrow Complete draft paths record/reserve usage under a 12,000 monthly control. | Public plan allowances and included-credit constants are not commercial allocations. | Generic planning estimates usage but does not debit/reserve; Core 5,000 is not a runtime grant and no Core assistant no-deduction rule exists. | Commercial credit issuance/reset/overage/reconciliation; Core general assistant cost policy. |
| **Providers / integrations** | Provider-neutral routing/control-plane preview, outbox lease/UNKNOWN boundaries, internal campaign planning, communication queueing. | Meta/Google labels and marketing Action Engine metadata are not provider integrations. | OpenRouter code is double-gated and used only by narrow complete draft paths; no external publishing occurs. | Meta/Google OAuth/ad account/campaign flow; Stripe/Square payment adapter; email/SMS/push delivery; provider reconciliation and external consumers. |
| **Presentation / HQ separation** | Scoped theme preferences are server-authorized and audited; staff/HQ routes have session guards; HQ scopes are separate. | Public reference pages intentionally show representative, non-operational Complete visuals. | Page session guards rely on each API retaining its own scope/permission/tier checks. | No school user gains HQ authority through this tranche. |
| **Database, audit, and RLS** | Tenant GUC/RLS architecture, audit/outbox/idempotency patterns, read-only entitlement function and source verifiers are present. | Source/test evidence is not applied-state proof. | Audit/outbox pairing is command-specific, not a global database trigger; outbox worker is not activated. | Fresh disposable-local RLS/ACL/entitlement proof and a safe preflight for the outbox lease test. |

## Enforcement gaps that must not be misrepresented

1. The public pricing surface has **no checkout, subscription, provider payment, credit grant, or commercial activation**.
2. No Core general assistant exists today, and no server rule establishes “general assistant does not deduct premium credits.”
3. No Meta/Google integration, AI-managed campaign publication, provider delivery, or payment processor path is implemented or authorized for activation.
4. The canonical AI Team roster has **eight presentation profiles** (Alex, Chad, Maya, Marcus, Jordan, Claire, Lena, Eian), not seven executable specialist employees.
5. Existing Essential behavior remains part of the locked product foundation and is not silently changed by Core/Complete work.

## Approved smallest implementation direction

The safe first enforcement change is **not commercial billing**. It is an HQ-only, server-enforced, auditable organization entitlement transition for **Core ↔ Complete only**:

- It preserves existing Essential records and does not create an Essential conversion path.
- It requires current HQ scope, idempotency, optimistic concurrency, an explicit allowed target tier, and an effective timestamp.
- It writes the entitlement change, immutable audit evidence, idempotency result, and inert outbox event atomically through fixed database/service boundaries.
- It does not accept client entitlement authority, raw SQL, payment state, price, credit grant, provider credential, external delivery, or school/HQ context bridging.
- Existing API gates continue to independently read the active entitlement at request/execution time.

The next separately required decision record must define the **Core general assistant** task scope, no-premium-credit rule, cost owner, limits, privacy, and fallback posture before that assistant or a Core credit allowance can be implemented.

## Validation posture

This audit is a source/test-evidence matrix, not production proof. The later implementation must run focused contract/security tests plus safe disposable-local entitlement/RLS verification. It must not run against remote Supabase targets, allocate production credits, activate providers/payments, send customer communications, or deploy.
