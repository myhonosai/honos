# No organization agent budget for paying organizations (migration 0310)

**Owner decision (David, 2026-11-13 04:10Z):** remove the hidden organization agent budget on conversations. It follows
the 2026-11-12 decisions in [docs/hon/INCLUDED_AI_AND_FAIR_USE.md](../hon/INCLUDED_AI_AND_FAIR_USE.md): a paying
school's conversations with HON and the AI team are not capped, and its creative and heavier work spends its 12,000
monthly creative credits.

## Before

Every organization that a free trial does not own had an interim monthly agent budget of 12,000 internal units
(0194, OD-23). Every agent prepare, the reserve guard (0288) and the planner (0287) compared
`committed + estimate` against `hon.ai_org_ceiling(org, at)` under the `ai.budget:<org>` lock, and refused with
`CUSTOMER_BUDGET_EXCEEDED`, `AI_ORG_BUDGET_EXCEEDED` or `NO_ELIGIBLE_ROUTE`.

## After

- `hon.ai_org_ceiling` and `hon.ai_org_display_ceiling` return `hon.ai_org_no_ceiling_units()` (2,147,483,647) for an
  organization that a trial does not own. Every caller keeps its shape and its lock order; the comparison never refuses
  on the organization total. No prepare, guard or planner body changes.
- The trial branch (0246, 0272) is unchanged: trial credits, the daily cap and the per-request cap still apply, and the
  R2 $15 trial cost ceiling (0288) still applies.
- `hon.ai_org_agent_ceiling_overrides` (forced RLS, migration owner only, no runtime grant, no API) can still set a
  ceiling for one organization. It is an operator backstop and is what the proofs use to keep testing the 0194 lock.
  HQ's tools in the app are the R2 per-school ceiling and pause (0288) and the organization or platform pause (0195).
- HQ shows "N agent credits committed (no organization limit)" for such an organization
  (`AI_ORG_AGENT_NO_CEILING_UNITS`). Readiness `agentBudget.ceilingCredits` carries the same value.

## Unchanged

Per-call provider cost ceilings, reply modes and token budgets, provider cost verification, UNKNOWN holds and HQ
resolution, access decisions (S4-c), HQ pauses, R2 per-school ceilings and pauses, the creative wallet, and the
included-AI wording.

## Risk

With no organization budget and no per-school default, nothing automatic stops a paying school's agent spend. The only
stops are HQ's per-school ceiling or pause and the organization or platform pause. HQ should watch per-school cost
(`/v1/hq/ai/school-cost-limits`, `/v1/hq/ai/usage`) once real providers are on. This is the owner's accepted trade-off.

## Tests

- AI-0 INV-39 (new): no override means the no-ceiling value and readiness show it; past 12,000 units HON still answers
  with one provider call; an override restores the ceiling at once (refused before any provider call); removing it lifts
  the ceiling; the table and helpers never reach the runtime; the table has forced RLS.
- AI-0 fixtures (`makeOrg`) set an override of 12,000 so INV-14, INV-15 and the other budget-lock invariants still run
  against a real ceiling. The plan and teaching proofs do the same where they prove a budget refusal.
