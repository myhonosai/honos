# S4-b: organization agent budget and lock

Status: draft, owner-authorized build (2026-11-01). Not deployed. Migration `0194_ai_org_budget_lock.sql` (number proposed; the owner allocates). Stacked on S4-a (0193) and AI-0 (PR #97).

## Problem

- **AI-2 (KF-AI2).** Each agent's prepare compared the monthly ceiling with the shared ledger plus **its own** open holds only. At used 11,990, Marcus (6), Claire (6) and Chad (3) all reached the provider: 12,005 committed against 12,000.
- **AI-3 (KF-AI3).** Same-agent serialization depended on an incidental row lock, not on an explicit budget lock.
- **AI-17 (latent).** The agent ceiling summed every ledger row. Creative (B3) usage would have reduced the agent limit once creative rows carry credits.

## Change

| Piece | What it does |
|---|---|
| `hon.ai_spend_window(org, at)` | The single definition of the budget window. It is still the UTC calendar month; a paid-period window needs its own owner decision. |
| `hon.ai_org_ceiling(org, at)` | The 12,000 interim ceiling (OD-23). It is now the only `12000` literal in any spend path (AI-0 INV-1). |
| `hon.ai_org_committed_credits(org, at)` | Agent-inference ledger credits in the window, plus every open hold on the three agent tables, across all schools of the organization. |
| `hon.ai_budget_lock(org)` | `pg_advisory_xact_lock('ai.budget:<org>')`. It is the **first** declaration of every prepare, taken before the agent gate locks organization, school and principal rows. The total is computed later, in a statement that starts after the lock, so it sees every earlier committed hold. |
| `prepare_marketing/teaching/chad_follow_up_invocation` | The per-agent sums are replaced by the organization total under the lock. A refusal keeps the existing durable outcome, `BLOCKED` / `CUSTOMER_BUDGET_EXCEEDED`, and never reaches a provider. |
| `ai_spend_reserve_guard` triggers | Defense in depth. Any increase of `reserved_credits` on the three agent tables, through any path, re-checks the organization total under the same lock. An excess raises `AI_ORG_BUDGET_EXCEEDED` (42501, which the services already map to 403). |
| `ai_usage_ledger.spend_class` | Values: `AGENT_INFERENCE`, `CREATIVE_MEDIA`, `HQ_INTERNAL`. Existing B3-linked rows are backfilled to `CREATIVE_MEDIA`. `record_*` writes `AGENT_INFERENCE`, and `saas_record_provider_usage` writes `CREATIVE_MEDIA`. Planning eligibility and the agent budget count agent rows only. |

## Lock order and deadlock freedom

1. `ai.budget:<org>`, **first** (the prepare's first declaration).
2. The agent gate's organization, school, principal and role row locks (the existing marketing and teaching gates take `organizations ... FOR UPDATE`).
3. The invocation row `FOR UPDATE`, then the HQ catalog and route rows `FOR SHARE`, as today.

Only agent prepares take `ai.budget:*`, and a prepare that holds it never waits for another prepare. Bind, record, hold, entitlement, exception and activation writers take row locks but never the budget lock, so they cannot form a cycle with it.

**Why first, not last (a correction to the design).** The S4 design put the budget lock last. INV-15 found a real deadlock with that order:
- Claire's prepare held `organizations FOR UPDATE` (taken by its gate) and waited for `ai.budget`.
- Chad's prepare held `ai.budget` and then needed a foreign-key `KEY SHARE` on the same organization row for its later writes.

Taking the budget lock before any gate row lock removes that cycle. The PostgreSQL log showed no deadlocks across repeated AI-0 runs after the change.

**Pre-existing, not introduced here.** Concurrent `bind_marketing_proposal` and `bind_teaching_proposal` calls in one organization can deadlock on the gates' organization row locks (observed once in the log while three agents finished together). PostgreSQL aborts one of the two. The service reports a conflict, and the recorded result stays `RESULT_RECORDED` for retry, so nothing is lost. A shared gate lock order is a follow-up item.

## Deliberate choices

- **The spend class has a default of `AGENT_INFERENCE`.** The design said "no default". A default that counts against the agent budget fails closed, because an unclassified row can only reduce the agent allowance. Every in-database writer also sets the class explicitly, and existing disposable fixtures that insert ledger rows keep working.
- **The refusal reason is unchanged.** Prepare keeps `CUSTOMER_BUDGET_EXCEEDED`, so the existing UI copy and contracts need no change. Only the trigger path, which a correct prepare never reaches, raises `AI_ORG_BUDGET_EXCEEDED`.
- **B3 is not in the agent budget.** Under AI-17, creative spend has its own wallet. The B3 program stays closed, and its budget guard arrives with the creative-wallet slices.
- **UNKNOWN holds still count in every window.** Changing that is S4-d (KF-AI8, AI-D3). After S4-b a stale hold blocks every agent in the organization, not just its own; the AI-0 KF-AI8 probe records that.

## Evidence (local, disposable PostgreSQL 16)

- AI-0 passes with 15 invariants. KF-AI9 and KF-AI8 still reproduce (open, owned by S4-c and S4-d).
- **INV-14:** all 6 arrival orders at used 11,990. In each order, two agents are admitted and the third is refused `BLOCKED` before any provider call. Committed never exceeds 12,000.
- **INV-15:** a blocker holds the budget lock, and both prepares of 6 pairs (marcus/marcus, claire/claire, chad/chad, marcus/claire, marcus/chad, claire/chad) are observed waiting on the advisory lock. On release, exactly one is admitted. The winner's provider call is held, so the loser's decision cannot depend on how fast the winner's smaller actual usage is recorded.
- **Mutation:** turning `ai_budget_lock` into a no-op fails INV-15 ("prepares were not both blocked").

## Rollback

Restore the 0193 versions of the three prepare functions, `record_*` and `plan_ai_invocation`, then drop the six triggers and the five functions. The `spend_class` column can stay; it is inert without the readers.
