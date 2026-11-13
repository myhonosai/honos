# Included AI team: internal usage accounting, fair use and customer billing

**Owner clarification, 2026-11-06 18:25Z (David).** This page states the commercial intent. It does not authorize paid providers, billing changes, credit grants or production changes. Where it conflicts with older wording in [OWNER_COMMERCIAL_POLICY.md](OWNER_COMMERCIAL_POLICY.md) or [HQ_AUTONOMY_AND_AI.md](HQ_AUTONOMY_AND_AI.md) about "premium AI credits" for agent work, this page wins.

## Owner decisions 2026-11-12 (David), these win over the proposal below

1. **No default per-school limit on conversations.** A paying school's conversations with HON and the AI team have no default per-school dollar limit and no per-person daily cap. (Since 0310 there is no organization agent budget either; any ceiling HQ sets for one school still applies.) The proposed fair-use steps and rate limits below (items 2 and 3) are **not adopted**. Built in R2 (#222, migration 0288): a paying school has no default ceiling (HQ reads `NO_CEILING`).
2. **A paid school's AI money is its creative credits.** About $30 a month of AI **provider cost** is given to the school as its **12,000 monthly creative credits** (wallet 0202). This is cost, not the top-up price: a $30 top-up pack buys 3,000 credits. Creative and heavier work (images, video, and future heavy jobs such as website building) spends those credits. When they run out the school buys a top-up pack or waits for next month's refresh. Nothing else is charged.
3. **Trial schools: $15.** While a free trial owns the school's access, its internal AI cost ceiling defaults to $15 (R2, `hon.ai_school_trial_default_ceiling_micros()`). Trial Creative Studio funding (the trial credit lot) is a separate change, not yet on main.
4. **HQ keeps emergency tools.** HQ can still set a ceiling for one school or pause one school's AI (R2), or pause an organization (0195).
5. **Organization agent budget removed (decided 2026-11-13).** The interim 12,000-unit organization agent budget (0194, OD-23) no longer caps a paying organization (migration 0310, [AI_ORG_AGENT_CEILING_REMOVED.md](../architecture/AI_ORG_AGENT_CEILING_REMOVED.md)). Only HQ's per-school ceiling or pause and the organization pause can stop a paying school's agent spend; an operator-only override remains as a backstop.

**Rule for new heavy features.** Images and video already reserve creative credits through `hon.saas_creative_reservations` (0202, 0216, 0276). The first heavy generator, AI website drafts (WB1, 0344, [CREATIVE_WEBSITE_DRAFTS.md](../architecture/CREATIVE_WEBSITE_DRAFTS.md)), reserves per page through that path with test providers only. Any further one must reserve creative credits through that same wallet path (which also carries the S4 and R2 pause guards), with HQ-configurable rates, and must not be billed as included conversation.

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

## Fair-use and abuse protections (2026-11-06 proposal; items 1-3 superseded by the 2026-11-12 decisions above)

Goal: keep the included AI economical and safe without ever charging the customer or quietly creating a paid AI tier.

1. **Monthly included-AI budget per school, internal only.** Keep the existing organization ceiling as the hard safety limit. HQ sets it per school from a target provider cost (owner to set, e.g. a dollar amount per school per month). The customer is never shown units.
2. **Graceful steps, never a charge.**
   - 75% and 90%: HQ alert only (Olivia/finance view). Nothing changes for the school.
   - 100%: Detailed replies and long specialist drafts pause for the rest of the month; Standard HON replies keep working under a daily cap. Message: "HON has reached this month's included limit for detailed work. Short answers still work. Nothing is charged."
   - Hard stop (owner-set, e.g. 125%): all included-AI provider calls stop until the next month or until HQ raises that school's budget. Same "nothing is charged" message.
3. **Per-person rate limits** (proposed defaults): 30 HON replies per hour and 200 per day per staff member; 20 Detailed replies per day; at most one reply in flight per person and three per school; continuation stays at 3 steps.
4. **Human-only use.** Included AI runs only from signed-in human staff sessions (`HUMAN_UI`), never API keys, automations or integrations, unless a later governed feature is approved.
5. **Input bounds stay.** Question 2,000 characters; facts and history built by the database; idempotency so a resend never calls twice.
6. **Anomaly alerts to HQ.** A school whose daily provider cost exceeds a set multiple of its average, or repeated identical questions, raises an HQ alert. HQ can pause a whole organization instantly (`/v1/hq/ai/spend-pauses`) and, since R2 (0288), one school (`/v1/hq/ai/school-cost-limits`).
7. **No silent paid tier.** Any future option to buy more included-AI capacity needs its own owner-approved commercial terms. Until then, hitting a limit only pauses work.

## What must change to match (follow-up slice "I1", after #148 → #150 → #151)

No code in #148, #150 or #151 deducts customer-purchased or creative credits, touches the creative wallet, or touches the legacy premium-credit tables (AI-0 INV-12 proves no allowance, reservation or credit-ledger write). The items below are wording and API naming, mostly already on `main`:

- Ask HON contract `HON_REPLY_MODES.reservedCredits` (new in #148) → rename to an internal-units name.
- Planner summary `AiInvocationPlanSummary.customerCreditEstimate` (and the plan column `customer_credit_estimate`) → internal-units name.
- Readiness API (`requestCredits`, `agentBudget.committedCredits/ceilingCredits`) and the refusal reason `CUSTOMER_BUDGET_EXCEEDED` → internal-units names and an "included AI limit" reason for customers. **I1a** maps `CUSTOMER_BUDGET_EXCEEDED` and `ORGANIZATION_AI_BUDGET_REACHED` to "Included AI limit reached this month. Nothing is charged" on the workbenches; the API renames are I1b.
- Staff workbenches for Marcus, Chad and Kai print "customer credits N" → remove from customer view (keep for HQ). **Done in I1a:** the line now reads "Included in your HON OS subscription. Nothing is charged to your school for this draft." Tokens and provider cost are no longer shown to school staff.
- School `ai/usage` read (`includedCredits`, `remainingCredits` from `INCLUDED_AI_CREDITS`) → HQ-only, or present as "included AI available" without a balance.
- School subscription FAQ "What are premium AI credits? 5,000 / 12,000" → creative credits only, with the included AI team described as included. **Done in I1a** (en/es/ko): the FAQ and the plan cards now describe the owner-approved creative wallet (12,000 included creative credits per eligible paid school per month, the same on every plan, `SAAS_CREATIVE_MONTHLY_INCLUDED_CREDITS`, wallet 0202). The legacy Core 5,000 / Complete 12,000 offer field (`monthlyPremiumCredits`, `premiumAiCreditPlanningAllowance`) is no longer shown to schools as a creative allowance or a premium allowance. It is **not** creative-wallet evidence, and any tier-specific creative amount needs its own owner decision. The HQ pricing labels for that legacy field, the legacy allowance readiness panel (`SchoolCreditStatus`) and the API renames remain for I1b.
- Legacy premium-credit program (0156) categories `AI_EMPLOYEE_TASK`, `DEEP_RESEARCH` (inactive) → must not be used for included agents; decide whether to retire them.

## Owner decisions

1. ~~Approve the fair-use steps above~~ Decided 2026-11-12: no cap on conversations.
2. ~~Set the target monthly included-AI provider cost per school~~ Decided 2026-11-12: about $30 a month, given as the 12,000 creative credits; $15 on trial.
3. ~~Approve the per-person rate limits~~ Decided 2026-11-12: none.
4. Retire the legacy premium-credit categories `AI_EMPLOYEE_TASK` and `DEEP_RESEARCH`, or keep them for a later approved add-on.
5. Approve the I1 follow-up slice (naming and UI wording, no billing or provider change).
