# S4-c: AI spend access decision and HQ emergency pause

Status: draft, owner-authorized build (2026-11-01). Not deployed. Migration `0195_ai_spend_access_decision.sql` (number proposed; the owner allocates). Stacked on S4-b (0194), S4-a (0193) and AI-0 (PR #97). Owner decision AI-D1 = A (2026-10-31): an HQ access exception grants product access only, never AI spend.

## Problem

- **AI-9 (KF-AI9).** A D9/D10 HQ access exception with COMPLETE scope sets the entitlement to COMPLETE ACTIVE. The receipt says `aiCredits: NONE`, but the agent gates only read the entitlement, so an unpaid school with an exception reached the provider and wrote a ledger row.
- **AI-1.** Nothing decided AI spend from how access was obtained (paid, trial, exception, legacy). Every paid-access state needs an explicit decision, including states that do not exist yet.
- **No emergency stop.** HQ had no way to stop AI spend for one organization, or for the platform, without changing entitlements.

## Change

| Piece | What it does |
|---|---|
| `hon.ai_spend_allowed(org, at, class)` | The single access decision for new spend. `NULL` means allowed (the existing entitlement and role gates still run); anything else is a refusal reason. Order: HQ pause, promotional hook, live exception (`AI_EXCEPTION_NO_AI`), legacy (no access-state row: unchanged), then the access-state mapping. |
| `hon.ai_access_state_decision(state, inEffect, trialFunded)` | A pure mapping so every state is testable on its own. Paid states need an entitlement in effect (`AI_ACCESS_LAPSED` otherwise). Awaiting/registered/trial-ended refuse `AI_ACCESS_NOT_PAID`. Trial only with approved trial funding (`AI_TRIAL_FUNDING_NOT_APPROVED`). Past due, suspended, review hold and ended each have their own reason. Any unknown state refuses `AI_ACCESS_UNKNOWN_STATE`. |
| `ai_spend_start_guard` triggers | `BEFORE INSERT` on the three agent invocation tables: no new request while the decision refuses. |
| `ai_spend_reserve_guard` (redefined) | The decision runs first on every hold increase, so a request begun before an exception or pause is refused at prepare, before any provider call. Then the S4-b budget check. |
| `ai_spend_b3_guard` | `BEFORE INSERT` on `saas_credit_reservations` with the `CREATIVE_MEDIA` class. B3 stays closed; this applies the same decision when it opens. |
| `hon.ai_spend_pauses` | Append-only HQ pause records. Organization or platform (`organization_id` NULL) scope; class `AGENT_INFERENCE`, `CREATIVE_MEDIA` or `ALL`; at most one active pause per scope and class. Only the end fields may be filled, once; delete and truncate are refused. Forced RLS, no runtime table access. |
| `hon.command_ai_spend_pause(subject, input, key)` | PAUSE or RESUME. Human HQ owner only (`require_saas_hq_actor(subject, true)`). Idempotent per key with a fingerprint; a reused key with different input is refused. A second active pause for the same scope is refused `AI_SPEND_PAUSE_ALREADY_ACTIVE`; resuming nothing is refused `AI_SPEND_PAUSE_NOT_ACTIVE`. |
| `hon.read_ai_spend_pauses_from_hq(subject)` | HQ billing readers: up to 200 pauses, active first. |
| `GET/POST /v1/hq/ai/spend-pauses` | The API. Reads use `SaasReadGuard`; the command uses `SaasCommandGuard` with the exact `ai-spend-pause` human-command header, same-origin, JSON only, an `Idempotency-Key`, and no query. The browser never names the actor; the database decides authority. |
| Hooks | `ai_promotional_access` and `ai_trial_funding_available` both return false. Approving promotional AI access or trial AI funding is a separate owner decision with its own records. |

## What is never refused

Evidence steps (`record_*`, `fail_*`) are not gated, as S4-a requires. A call that was already in flight when an exception was granted or a pause started still records its usage. INV-16 proves it.

## Deliberate choices

- **A pause stops new work at the next begin, prepare or reserve; it does not cancel a call already at the provider.** Cancelling provider calls is not possible after the request has been sent, and the usage must still be recorded.
- **Refusals raise 42501.** The three agent services already map 42501 to 403, so no service code changed. The specific reason is in the database message and the pause or exception record.
- **Legacy organizations are unchanged.** An organization with no access-state row and no live exception keeps today's behavior, so the existing pilot schools are not affected.
- **Pause conflicts are 422 rule refusals,** not idempotency conflicts, so an HQ screen can show "already paused" and "nothing to resume".

## Evidence (local, disposable PostgreSQL 16)

- AI-0 passes with 18 invariants. KF-AI9 is `FIXED_BY_S4C`; KF-AI8 still reproduces (S4-d).
- **INV-16:** all three agents, unpaid school with a live COMPLETE exception: begin refused; a request begun before the grant is refused at prepare; provider calls 0. A call in flight at grant time records one ledger row.
- **INV-17:** every access state in both entitlement conditions; an unknown state; a real `AWAITING_FIRST_PAYMENT` row refuses; a legacy organization is allowed.
- **INV-18:** a school owner cannot pause or read; HQ owner pause, replay, key reuse, second active pause, class scoping, cross-organization isolation; all agents refused while paused; resume, replay and resume-nothing; platform-wide ALL pause and resume; update and delete refused.
- **API:** `apps/api/test/ai-spend-pause.test.cjs` covers the contracts, the guard refusals (none reach the database), the subject binding and the error mapping.

## Open, not built here

- **HQ pause screen (Codex).** The API and validators are ready (`validateAiSpendPauseList`, `validateAiSpendPauseInput`, `SAAS_COMMANDS.aiSpendPause`).
- **Agent screens** should show a plain message for the new refusal reasons. Today they surface as the existing 403 copy.
- **Promotional AI access and trial AI funding** need owner decisions before the hooks return anything.

## Rollback

Drop the triggers, the pause table and functions, and restore the S4-b `ai_spend_reserve_guard`. No other data changes.
