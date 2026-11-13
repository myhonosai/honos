# HQ Ask HON, the HQ executives and the HQ AI text budget (migrations 0263 B1, 0264 B2)

Status: source only, not deployed. Fake providers only in tests; the real runtime stays behind
`OPENROUTER_PAID_CALL_APPROVED`. Nothing here turns it on.

## What it is

HQ gets its own HON conversation. An HQ person asks HON a question about HON OS itself, and HON answers from the
HQ platform overview (`hon.read_hq_platform_overview`, 0127) plus this month's HQ AI text budget. It mirrors the
school conversation, but it has no organization or school, and it is paid from a separate monthly **HQ AI text
budget**. That budget follows the 0253 HQ Creative Studio pattern: the human HQ owner sets a credit cap per UTC
month, which is an internal planning limit and never a charge, a provider budget or a payment.

HON reads and recommends only. It never sends, changes, approves, pauses or charges anything. Recommendations are
text, and an HQ person acts through the existing HQ screens.

## Who can do what

| Action | Who |
|---|---|
| Ask, read own turns (`GET /v1/hq/hon`, `POST /v1/hq/hon/turns`) | HQ owner, or HQ operator holding `hq.dashboard.view` |
| Set the monthly cap (`POST /v1/hq/hon/budget`) | HQ owner only |
| See cap history and the review queue; resolve a held turn (`POST /v1/hq/hon/turns/:id/resolution`) | HQ owner only |

Only an HQ grant counts. School roles, support grants, family access and a lapsed grant are refused. School
authority never reaches HQ, and nothing in HQ HON reads or writes a school's data, AI budget, `ai_usage_ledger`,
`ai_invocation_plans` or school conversation tables.

## One turn (S4 for HQ)

1. The API refuses with 503 `HQ_HON_PROVIDER_NOT_CONNECTED` before any write while the provider runtime is not
   ready.
2. `hon.ask_hq_hon` validates the closed input `{question, replyMode, agentKey}` and takes the asker+key lock. A
   replay returns the same turn and never reserves or calls again; the same key with another body is refused.
3. Platform emergency pause gate: the `AGENT_INFERENCE` or `ALL` pause with no organization refuses
   (`HQ_HON_PAUSED_BY_HQ`). A school's own pause never applies to HQ.
4. The database chooses the route: the cheapest active, healthy OpenRouter text model whose cost for the mode's
   budgets fits the cost ceiling. Otherwise it refuses with `HQ_HON_NO_ELIGIBLE_ROUTE`. No caller ever names a
   provider or model.
5. Under the period lock it checks that the cap is set, that fewer than 3 turns are in progress, and that the
   mode's fixed credits fit (STANDARD 10, DETAILED 15, the school HON numbers). It then inserts the turn
   ANSWERING, re-checks authority after the write, and returns the facts once.
6. The API makes **one** provider call (`specialist: 'hq_hon'`, its own system prompt, "HON OS HQ facts" label,
   step 1, no tone, no continuation, no suggestions).
7. `hon.record_hq_hon_result` records the outcome exactly once, by the asker in person, so a lapsed grant never
   loses an in-flight result:
   - ANSWERED charges `ceil((input + output tokens) / 1000)` credits, never above the reservation. Measured tokens
     and the provider-reported cost are stored.
   - A result over the input or output budget, or over the cost ceiling, is never trusted. It is held UNDER_REVIEW
     as `UNVERIFIED_RESULT`. The API does the same for malformed output or any suggestion.
   - FAILED (provider rejected) charges nothing, and its cost stays UNKNOWN unless reported. NOT_SENT charges
     nothing and costs a known zero.
   - UNKNOWN is held UNDER_REVIEW. INTERRUPTED is accepted only after 120 seconds.
8. The HQ owner resolves a held turn with evidence, as CHARGED (0 up to the reservation) or NOT_CHARGED. No reply is
   ever shown for a resolved turn.

## Concealment

Each turn stores the permissions its facts used (`source_permissions`, B1: `hq.dashboard.view`). An answer is shown
only while the reader still holds every one; otherwise `reply` is null and `concealed` is true.

## The six HQ executives (B2, 0264)

The executives of the locked HQ catalog (`packages/contracts/src/hq-overview.ts`) answer in the same conversation, on the
same budget and S4 path. Each reads aggregate facts under one HQ permission; the HQ owner holds them all.

| Agent | Catalog role | Permission | Facts (counts and sums only) |
|---|---|---|---|
| HON | Executive AI Coordinator | `hq.dashboard.view` | HQ platform overview, HQ AI text budget |
| Chase | Growth | `hq.marketing.read` (or `hq.marketing.manage`) | HQ campaigns by status, running and ending soon, active planned budget; HQ creative budget |
| Mia | Customer Success | `hq.support.manage` | HQ support cases by status, open by priority, open over 7 days, opened and closed this month |
| Ethan | Product | `hq.billing.manage` | provider connection states, active text models, platform and school AI pauses, HQ AI text and creative budgets |
| Olivia | Finance | `hq.billing.manage` | HON OS invoices by status and issued this month; refund requests by status and awaiting decision |
| Ryan | Revenue | `hq.billing.manage` | subscriptions by status, in service by plan and offer, recorded this month, monthly list price total; paid-access states |
| Sophia | Operations | `hq.onboarding.manage` | organizations by status, onboarding requests, HQ access exceptions active, scheduled and expiring in 14 days |

- No organization, school, person, case subject, invoice number or note ever enters a prompt. Nothing reads a school's
  AI budget, `ai_usage_ledger`, `ai_invocation_plans` or conversation tables.
- Olivia's and Ryan's facts carry a note, and every executive prompt says, that HON OS does not collect payments yet:
  recorded prices and invoices are records, never collected revenue.
- `read_hq_hon_conversation` adds `availableAgents`: the agents the reader may ask now, in catalog order, HON first.
- An answer whose permission the reader no longer holds is concealed (`source_permissions`), as in B1.
- Each executive has its own system prompt (`HQ_EXECUTIVE_PROMPTS`); the API passes the turn's agent as `hqAgent`.
  HON's B1 prompt is unchanged byte for byte.

## Evidence

- `packages/database/scripts/test-hq-hon-conversation.mjs` (Champions fixture), with a fake provider only. It
  covers posture, authority, the pause, route, cap and in-progress refusals, facts without school identity,
  replay and key reuse, every outcome, measured settlement, owner resolution, concealment after a lapse,
  immutability and nothing written school-side.
- AI-0: the new spend table and functions are pinned in `ai-spend-entrypoints.json` (`spendTables`,
  `spendReferences`, runtime privileges, triggers). They are pinned the same way as `hq_creative_generations`.
- B2: the same proof asks every executive as the HQ owner (facts shape, no identity, the agent's permission stored, one
  call with `hqAgent`), checks `availableAgents` for each operator kind, refuses every executive the asker may not use
  without writing, and conceals an answer after the operator's permission is removed.
- `apps/api/test/hq-hon.test.cjs`: closed contracts, the HQ prompt, 503 before any write without the paid-call
  approval, one call per turn, every outcome mapping, replay, refusals and rule codes.
