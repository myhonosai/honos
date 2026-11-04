# S4-a: durable AI usage evidence

Status: draft PR, owner-authorized build (2026-11-01), stacked on AI-0 (PR #97). Not deployed. Migration `0193_ai_spend_durable_evidence.sql` (number proposed; the owner allocates migration numbers).

Implements the first S4 slice from the approved S4 security design (owner decisions **AI-D6**: replace the record/fail steps and split cost recording from draft creation; **AI-D7**: hold completed results when access lapses, recover after access returns). Fixes **AI-14**, **AI-16**, and **AI-5** for agent rows.

## Problem (AI-0 KF-AI14)

For Marcus, Claire and Chad, a provider call already in flight when access lapsed (entitlement suspended or expired, permission removed) got its provider answer, but `record_*` and `fail_*` re-ran the full access gate. Nothing could be written: no `ai_usage_ledger` row for a charged call, and the invocation stayed `SENDING` with its credit hold. The ledger write also shared one transaction with the action-engine proposal, so any proposal failure rolled back the usage row (AI-16).

## Change

| Object | Change |
|---|---|
| `hon.ai_evidence_actor(subject)` | New, internal (no runtime grant). Resolves the direct human requester (HUMAN_USER, HUMAN_UI, no action/delegation context, subject matches the session principal). Checks no entitlement, role, permission or school status. |
| `record_marketing_result`, `record_teaching_result`, `record_chad_follow_up_result` | Evidence-only actor; still require current tenant, `requested_by = actor`, `SENDING`, no prior usage, and every existing result validation. Writes one ledger row (`source_invocation_id` = invocation), releases the hold, stores the draft, ends `RESULT_RECORDED` (or `FAILED` / `RESULT_BUDGET_EXCEEDED` as before). |
| `fail_*_invocation` (3) | Evidence-only actor; otherwise unchanged (UNKNOWN keeps the hold for S4-d). |
| `bind_*_proposal` (3) | Full existing gate unchanged; now binds from `RESULT_RECORDED` or `RESULT_HELD` instead of `SENDING`. |
| `read_*_result_payload` (3, new, runtime) | Full gate. Returns the exact proposal payload for a recorded or held result with no proposal yet; otherwise NULL. |
| `hold_*_result` (3, new, runtime) | Evidence-only actor. Moves `RESULT_RECORDED` to `RESULT_HELD` / `ACCESS_LAPSED` **only if the full gate now refuses** (checked in a subtransaction); otherwise refuses `AI_ACCESS_NOT_LAPSED`. |
| Invocation status/reason CHECKs | Add `RESULT_RECORDED`, `RESULT_HELD`, reason `ACCESS_LAPSED`. |
| `ai_usage_ledger.source_invocation_id` | New nullable column + partial unique index: one ledger row per agent invocation. Existing and B3 rows stay NULL. |

Services (`marketing-assistant`, `teaching-assistant`, `chad-follow-up-assistant`):

1. Transaction 1 records only. On failure it records `UNKNOWN` (now possible after a lapse) and reports `*_PERSISTENCE_UNKNOWN` as before.
2. Transaction 2 creates the CONFIRM proposal and binds it. On any failure the service calls `hold_*`; if access really lapsed the result is held and the caller gets 403 `*_RESULT_HELD`; otherwise the result stays `RESULT_RECORDED` and the original error is returned.
3. The existing `POST …/:id/retry` route resumes a recorded or held result through `read_*_result_payload` and bind. It never calls the provider.

## Security boundary

- Starting, reserving, reading the payload and binding keep the full existing gate. Only evidence of an already-made provider call is unguarded, and only for the requester's own row in the current tenant.
- New runtime grants: the three payload reads and three holds. `ai_evidence_actor` has none. Nothing for PUBLIC, anon, authenticated or service_role (migration and canonical `010_supabase_hon_runtime.sql`).
- No program, policy, allowance, ceiling, provider or payment change. Zero network calls in tests.

## Evidence

AI-0 proof (`test-ai-spend-authority-baseline.mjs`): KF-AI14 flipped to `FIXED_BY_S4A` and replaced by **INV-13**: for each agent and each of three lapse kinds (suspended, expired, `ai.invocation.plan` removed) exactly one provider call, exactly one ledger row with provider cost, hold released, `RESULT_HELD` / `ACCESS_LAPSED`, no proposal, nothing left `SENDING`; retry refused while lapsed; after access returns retry binds once (`AWAITING_APPROVAL`) with no provider call or extra ledger row. A forced proposal failure leaves `RESULT_RECORDED` with its ledger row; hold is refused while access is current; a replayed record is refused; a second ledger row for the same invocation is refused by the unique index. Other probes (KF-AI2, KF-AI9, KF-AI8, KF-AI3) still reproduce as before.

## Not in this slice

Organization budget and lock (S4-b), access-source decision and exception deny (S4-c), UNKNOWN resolution (S4-d), B3 settle after a lapse (tested when S4-b adds the B3 guard). Frontend labels for the two new states belong to Codex; the web validators were widened only so existing screens keep loading.
