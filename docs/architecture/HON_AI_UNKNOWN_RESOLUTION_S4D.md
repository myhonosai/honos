# S4-d: lost AI provider outcomes (UNKNOWN) and HQ owner resolution

Status: draft, owner-authorized build (2026-11-01). Not deployed. Migration `0196_ai_unknown_resolution.sql` (number proposed; the owner allocates). Stacked on S4-c (0195), S4-b (0194), S4-a (0193) and AI-0 (PR #97). Owner decision AI-D3 (2026-10-31): a human HQ owner resolves with provider evidence; no automatic retry, release or refund.

## Problem (AI-8, KF-AI8)

When a provider call ends with an unknown outcome (timeout after send, or the provider answered but nothing could be recorded), the agent's hold stays reserved forever:
- It kept counting in every later month. After S4-b it blocked **every** agent of the organization, not only its own.
- No function could settle it: late `fail_*` and `record_*` are refused because the call is no longer `SENDING`.

## Change

| Piece | What it does |
|---|---|
| `hon.ai_hold_counts(status, heldAt, window, at)` | The counting rule. A `SENDING` hold younger than the stale limit (1 hour) always counts: a call in flight is never double-allowed, even across a window boundary. An `UNKNOWN` hold, or a stale `SENDING` hold, counts only in the budget window in which it was held. Any other hold always counts (fail closed). |
| `hon.ai_org_committed_credits` (redefined) | S4-b's organization total, with each hold filtered by the rule above. A hold's time is its row's `updated_at` (prepare sets `SENDING`, `fail_*` sets `UNKNOWN`, in the same call). |
| `hon.ai_unknown_resolutions` | An immutable record per resolved call: agent, invocation, organization, school, prior status, hold time, released credits, decision, reason, evidence, the ledger row written (if any), key, fingerprint, resolver and time. Forced RLS; no runtime table access; update, delete and truncate are refused. |
| `hon.resolve_ai_unknown_invocation(subject, agent, id, input, key, requestId, correlationId)` | **Human HQ owner only.** Closed input per decision. **`RECORD_PROVIDER_COST`** needs the provider generation id, input and output tokens and cost; it writes exactly one agent ledger row **in the original window**, with credits computed exactly as `record_*` does. **`NO_PROVIDER_CHARGE`** needs a provider lookup reference; it writes no ledger row. **`WRITE_OFF`** needs the best-known cost; it writes a zero-credit row, so HON absorbs the cost and it stays visible for reconciliation. Every decision releases the hold, leaves the call `UNKNOWN`, and writes the resolution, an audit row and an inert outbox event. Idempotent per key (a reused key with different input is refused); each call can be resolved once. A fresh `SENDING` call and a recorded call are refused `AI_UNKNOWN_NOT_RESOLVABLE`. |
| `hon.read_ai_unknown_invocations_from_hq(subject)` | The HQ queue for HQ billing readers. It lists up to 200 open lost outcomes, oldest first, and shows whether each still limits its school this window. It also lists the latest 100 resolutions and the stale limit. |
| `GET /v1/hq/ai/unknown-invocations`, `POST /v1/hq/ai/unknown-invocations/:agent/:invocationId/resolve` | The API. Reads use `SaasReadGuard`. The command uses `SaasCommandGuard` with the exact `ai-unknown-resolve` human-command header, same-origin JSON, an `Idempotency-Key`, and no query string. The browser never names the resolver. |

## Deliberate choices

- **No provider call.** The HQ owner enters evidence from the provider's own usage record. Fetching it automatically from a provider usage API is an external call and needs separate authorization (AI-D3).
- **No money moves.** Schools are never charged money for agent credits, so a resolution only releases a hold and records usage.
- **No budget lock.** A resolution only lowers holds. It takes one row lock (the invocation) and never waits for `ai.budget:*`, so it cannot form a cycle with prepares.
- **The call stays `UNKNOWN`.** No new status was added, so the existing services and validators need no change. The resolution record is the evidence, and `usage_id` points at the ledger row when there is one.
- **The stale limit is 1 hour.** Provider calls time out in seconds, so this leaves a wide margin before a live call could be treated as lost.

## Evidence (local, disposable PostgreSQL 16)

- **AI-0:** passes with 20 invariants and **no open known failures**. KF-AI8 is `FIXED_BY_S4D`.
- **INV-19:** the counting rule checked directly. A last-window `UNKNOWN` hold blocks neither its own agent nor another agent. A current-window `UNKNOWN` hold still counts. A stale `SENDING` hold follows the same rule. Late agent evidence is still refused. The HQ queue lists all four cases with their window status, and a school owner cannot read it.
- **INV-20:**
  - A school owner is refused.
  - Seven invalid inputs, an unknown agent, an unknown invocation and an agent/invocation mismatch are each refused.
  - `RECORD_PROVIDER_COST` writes one row (2 credits for 1,800 tokens) in the original window and releases 6; its replay writes nothing; key reuse is refused; it cannot run twice; the agent path still refuses a late record.
  - `NO_PROVIDER_CHARGE` writes no row and the school can spend again.
  - `WRITE_OFF` of a stale `SENDING` call writes a zero-credit row with the cost.
  - In-flight and recorded calls are refused.
  - Three audit rows and three outbox events are written; resolutions are immutable; resolved items leave the queue.
- **Mutation:** counting lost outcomes in every window fails INV-19.
- **API:** `apps/api/test/ai-unknown-resolution.test.cjs`.

## Open, not built here

- **HQ queue and resolution screen (Codex).** Validators and the command name are ready.
- **Escalation monitoring:** more than 5 `UNKNOWN` outcomes in 24 hours pauses the organization, and anything older than 72 hours alerts HQ. The S4-c pause already exists as the action; the monitor is a later slice.

## Rollback

Restore the S4-b `ai_org_committed_credits`, then drop the resolve and read functions, the helpers and the resolution table. Ledger rows written by resolutions stay, because they are real usage evidence.
