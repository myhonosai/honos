# Included AI team: internal usage accounting, fair use and customer billing

**Owner clarification, 2026-11-06 18:25Z (David).** This page states the commercial intent. It does not authorize paid providers, billing changes, credit grants or production changes. Where it conflicts with older wording in [OWNER_COMMERCIAL_POLICY.md](OWNER_COMMERCIAL_POLICY.md) or [HQ_AUTONOMY_AND_AI.md](HQ_AUTONOMY_AND_AI.md) about "premium AI credits" for agent work, this page wins.

## Policy

HON OS is sold as **one subscription with an included AI team**. It is not a chatbot where customers buy credits for every reply.

- **Included, no customer credits:** HON (central assistant), Kai (Teaching & Curriculum), and the school specialists Alex, Chad, Maya, Marcus, Jordan, Claire and Lena. Conversations with them and their governed work (drafts, analysis, delegated tasks) never deduct customer-purchased or creative credits.
- **Creative Studio is separate:** image, video and other creative media generation uses the per-school **creative-credit wallet** (included monthly allowance plus optional purchased packs under approved terms). That is the only customer-facing credit balance.
- **Internal protections stay:** the per-call provider cost ceiling (Ask HON: $0.08 per call), reply modes, token budgets, organization AI budget lock, provider cost verification, UNKNOWN recovery, emergency pauses and authorization all remain. They exist for HON OS profitability and safety, not for customer billing.

## Two ledgers, never mixed

| | Included AI team (internal) | Creative Studio (customer) |
|---|---|---|
| What | HON, Kai, specialists: text inference | Image / video / creative media jobs |
| Ledger | `hon.ai_usage_ledger`, `spend_class = 'AGENT_INFERENCE'` | Creative wallet (0202), `spend_class = 'CREATIVE_MEDIA'` |
| Unit | Internal usage units (1 unit ≈ 1,000 tokens, input + output) plus measured provider cost in USD microunits | Creative credits from the school's own lots |
| Limit | Internal monthly fair-use budget per organization (interim 12,000 units, OD-23) | The school's wallet balance |
| Customer sees | Whether the AI team is available, never a balance or a price per message | Balance, allowance, purchased packs, job estimate |
| Who manages | HQ (cost, margin, per-school usage, alerts, pauses) | School owner (with HQ oversight) |

The code still names the internal unit `customer_credits` / `reserved_credits` / `requestCredits` in several places (columns and APIs that predate this clarification). These are **internal usage units**. They must never be labelled, summed or displayed as purchased credits, creative credits or a pay-per-message charge.

## Fair-use and abuse protections (proposal for owner approval)

Goal: keep the included AI economical and safe without ever charging the customer or quietly creating a paid AI tier.

1. **Monthly included-AI budget per school, internal only.** Keep the existing organization ceiling as the hard safety limit. HQ sets it per school from a target provider cost (owner to set, e.g. a dollar amount per school per month). The customer is never shown units.
2. **Graceful steps, never a charge.**
   - 75% and 90%: HQ alert only (Olivia/finance view). Nothing changes for the school.
   - 100%: Detailed replies and long specialist drafts pause for the rest of the month; Standard HON replies keep working under a daily cap. Message: "HON has reached this month's included limit for detailed work. Short answers still work. Nothing is charged."
   - Hard stop (owner-set, e.g. 125%): all included-AI provider calls stop until the next month or until HQ raises that school's budget. Same "nothing is charged" message.
3. **Per-person rate limits** (proposed defaults): 30 HON replies per hour and 200 per day per staff member; 20 Detailed replies per day; at most one reply in flight per person and three per school; continuation stays at 3 steps.
4. **Human-only use.** Included AI runs only from signed-in human staff sessions (`HUMAN_UI`), never API keys, automations or integrations, unless a later governed feature is approved.
5. **Input bounds stay.** Question 2,000 characters; facts and history built by the database; idempotency so a resend never calls twice.
6. **Anomaly alerts to HQ.** A school whose daily provider cost exceeds a set multiple of its average, or repeated identical questions, raises an HQ alert. HQ can pause that one school instantly (existing `/v1/hq/ai/spend-pauses`).
7. **No silent paid tier.** Any future option to buy more included-AI capacity needs its own owner-approved commercial terms. Until then, hitting a limit only pauses work.

## What must change to match (follow-up slice "I1", after #148 → #150 → #151)

No code in #148, #150 or #151 deducts customer-purchased or creative credits, touches the creative wallet, or touches the legacy premium-credit tables (AI-0 INV-12 proves no allowance, reservation or credit-ledger write). The items below are wording and API naming, mostly already on `main`:

- Ask HON contract `HON_REPLY_MODES.reservedCredits` (new in #148) → rename to an internal-units name.
- Readiness API (`requestCredits`, `agentBudget.committedCredits/ceilingCredits`) and the refusal reason `CUSTOMER_BUDGET_EXCEEDED` → internal-units names and an "included AI limit" reason for customers.
- Staff workbenches for Marcus, Chad and Kai print "customer credits N" → remove from customer view (keep for HQ).
- School `ai/usage` read (`includedCredits`, `remainingCredits` from `INCLUDED_AI_CREDITS`) → HQ-only, or present as "included AI available" without a balance.
- School subscription FAQ "What are premium AI credits? 5,000 / 12,000" → creative credits only, with the included AI team described as included.
- Legacy premium-credit program (0156) categories `AI_EMPLOYEE_TASK`, `DEEP_RESEARCH` (inactive) → must not be used for included agents; decide whether to retire them.

## Owner decisions

1. Approve the fair-use steps above, or set different thresholds.
2. Set the target monthly included-AI provider cost per school that HQ budgets from.
3. Approve the per-person rate limits, or change them.
4. Retire the legacy premium-credit categories `AI_EMPLOYEE_TASK` and `DEEP_RESEARCH`, or keep them for a later approved add-on.
5. Approve the I1 follow-up slice (naming and UI wording, no billing or provider change).
