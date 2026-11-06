# HON OS — owner vision and business-policy handoff for Claude Code

**Snapshot:** October 17, 2026. **Audience:** Claude Code, Manus, future engineers and authorized project collaborators.

This folder merges the founder's approved HON OS business objectives with the **existing** Manus engineering handoff. It is a source of owner intent and a guard against repeatedly rebuilding decisions. It is NOT a code audit, a production configuration change, a payment authorization, legal advice, or evidence that planned features already run.

## Mandatory existing engineering authority

Read repository root [AGENTS.md](../../AGENTS.md), [EXTERNAL_AGENT_HANDOFF.md](../EXTERNAL_AGENT_HANDOFF.md), [HON_MASTER_DIRECTIVE.md](../HON_MASTER_DIRECTIVE.md), current [TODO.md](../../TODO.md) and the relevant `docs/architecture/*` contract **before** implementing a feature.

These existing documents define hard safety invariants: PostgreSQL + forced RLS; organization/school tenant scoping; independent HQ/staff/family principals; typed domain services; Action Engine permissions/approvals; idempotency/audit/outbox; safe database fixtures; and truthful distinction between UI reference and working capability. Nothing here relaxes those requirements.

## Read in this order

1. [PRODUCT_VISION_AND_PLANS.md](PRODUCT_VISION_AND_PLANS.md) — users, product positioning, Core vs Complete and the actual school lifecycle.
2. [OWNER_COMMERCIAL_POLICY.md](OWNER_COMMERCIAL_POLICY.md) — subscription/founder/lifetime policy, premium AI costs, payments, planning margins, unresolved terms.
3. [CHAMPIONS_CLUB_AND_GROWTH.md](CHAMPIONS_CLUB_AND_GROWTH.md) — 30-day guarantee, referrals, leaderboard, owner-launchable contests, acquisition phases.
   - [INCLUDED_AI_AND_FAIR_USE.md](INCLUDED_AI_AND_FAIR_USE.md) — 2026-11-06: the AI team is included; internal usage accounting vs Creative Studio credits; fair-use proposal.
4. [HQ_AUTONOMY_AND_AI.md](HQ_AUTONOMY_AND_AI.md) — HQ as operating control plane, governed agents and owner-configurable operations.
5. [IMPLEMENTATION_AND_COLLABORATION.md](IMPLEMENTATION_AND_COLLABORATION.md) — implementation truth, GitHub coordination, first Claude task and development priorities.

## Conflict-resolution policy

- **Latest explicit owner approval** controls commercial/product goals, subject to law and existing customer rights; document any policy resolution.
- Existing domain contracts, RLS, approval controls and financial guardrails control **how** features may safely be built.
- A roadmap request does not override the real current implementation, and implementation history does not silently veto a later owner business decision.
- Treat unresolved terms as unresolved; do not transform an example incentive or fee into a live customer promise.
- If the owner wants Essential removed from new sales, **retain current legacy Essential records and entitlements** until separately reviewed and explicitly migrated. This is already the position of the existing external-agent handoff.
- Commercial prices and premium allowances currently exposed by the public plan catalog are **non-binding planning/display metadata**, not an issued subscription, payment or credit grant.
- Never make claims to customers that competitors lack all AI/marketing features; differentiate HON with verified integrated execution rather than false exclusivity.

## Success

A martial arts owner can independently operate real leads, trials, membership and billing, classes, attendance, testing, family engagement, school marketing, and traceable revenue, on one authorized set of records; a Complete owner delegates approved tasks to governed AI employees. HON's founder can operate HON HQ and marketing/referral campaigns without an ongoing Manus or Claude development session.

**GitHub `main` is canonical; a GitHub push is not a production deployment.**