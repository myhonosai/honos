# HON Champions Club — Reward Accounting (Milestone 2)

**Status:** Implemented and tested on a disposable local database. **Not merged, not deployed, not commercially activated.**

This is an accounting foundation. It records what a school has earned as a **liability**. It does not:
- issue a credit or change billing
- start a free month or activate a lifetime membership
- buy or ship a prize
- create any external obligation

`financial_activation` is pinned to `false` by a database constraint, and there is no "fulfilled" or "issued" state. Fulfillment needs HON subscription billing, owner approval and a later reviewed migration.

Builds on [Milestone 1](CHAMPIONS_CLUB_BACKEND.md). Migration: [`0149_champions_club_reward_accounting.sql`](../../packages/database/migrations/0149_champions_club_reward_accounting.sql). Contracts: [`champions-club-rewards.ts`](../../packages/contracts/src/champions-club-rewards.ts).

## Reward ladder (owner-approved, stored as a versioned policy)

| Qualified referrals | Reward recorded | Kind | Beneficiary |
| --- | --- | --- | --- |
| Each, 1–4 | $100 HON subscription credit | `REFERRER_CREDIT` | Referring school's organization |
| Each qualified referral | $100 HON subscription welcome credit | `WELCOME_CREDIT` | Referred organization |
| 5 | 6 free months | `FREE_MONTHS` (ordinal 1) | Referrer |
| 10 | 12 free months **total**: the second entry records 6 more, since the 6 from milestone 5 are included | `FREE_MONTHS` (ordinal 2) | Referrer |
| 20 | Owner-selected electronics or experience prize. Kind, description and cost are recorded at approval, within the policy's prize budget | `PRIZE` | Referrer |
| 30 | Lifetime HON membership at the referrer's current tier | `LIFETIME_MEMBERSHIP` | Referrer |

- **AI allowance:** free-month and lifetime entries carry `aiAllowance = FULL_PLAN_ALLOWANCE`, enforced by constraint. Earned free periods and lifetime membership keep the full regular monthly AI credit allowance.
- **Separate accounting:** each kind has its own amount column and shape constraint:
  - subscription credits: `credit_minor`
  - free periods: `free_months`
  - lifetime: `lifetime_tier`
  - prizes: `prize_*`
- **Rules between milestones:** not modeled. Nothing accrues for 6–9, 11–19 or 21–29 qualified referrals until the owner decides otherwise.

## Lifecycle

Each entry has one of four states:

| State | Meaning | How it is reached |
| --- | --- | --- |
| `ACCRUED` | Earned and recorded as a liability | Reconciliation, or restored from review |
| `APPROVED` | Owner has recorded plan basis, fulfillment form and any substitute or prize details | Owner APPROVE from `ACCRUED` |
| `REVERSAL_REVIEW` | Basis was lost (count dropped, or the referred school was refunded or reversed) | Reconciliation, from `ACCRUED` or `APPROVED` |
| `VOIDED` | No longer a liability | Owner VOID |

- **Reconciliation** (HQ owner or operator, per referrer school) is idempotent in effect. It:
  - accrues missing milestones and welcome credits under the published reward policy
  - moves live entries whose basis is gone to `REVERSAL_REVIEW`; **it never voids**
  - returns reviewed entries to their prior state when the basis comes back
- **No duplicates:**
  - Milestones are keyed by kind and ordinal, so a later policy that moves a threshold (for example 5 → 6) cannot pay the same milestone twice.
  - A partial unique index allows one live entry per milestone and one live welcome credit per referral.
- **Owner decisions** (all owner-only, all recordkeeping):
  - **APPROVE:** records the beneficiary's plan basis (`MONTHLY`, `ANNUAL`, `FOUNDER` or `PAID_LIFETIME`) and applies the published rule for that basis:
    - `AS_EARNED`: no substitute.
    - `OWNER_SUBSTITUTE`: a described substitute with a value.
    - `UNDECIDED`: refused.
    - A paid-lifetime member can only receive an owner-recorded substitute, never a duplicate lifetime or meaningless free months. This is enforced on both the policy and the entry.
    - A prize also needs kind, description and cost within budget. An undecided budget refuses.
  - **VOID:**
    - `FRAUD_CONFIRMED`, `DUPLICATE` and `OWNER_CORRECTION` are owner judgment on any live entry.
    - `BASIS_REVERSED` is the clawback. It needs `REVERSAL_REVIEW` and clawback rule `VOID_UNFULFILLED`.
  - **RETAIN:** keeps an entry under review as earned (clawback rule `RETAIN_EARNED`). A retained entry is never flagged again.
- **Rules follow the current policy:** decisions use the owner's current published rules. Amounts stay as accrued.

## Configurable and inactive until approved

These may stay `UNDECIDED` in a published reward policy. Each blocks only the decisions that depend on it:

| Setting | Values | Blocks while undecided |
| --- | --- | --- |
| `clawbackRule` | `VOID_UNFULFILLED`, `RETAIN_EARNED` | VOID for `BASIS_REVERSED`, and RETAIN |
| `monthlyRule`, `annualRule`, `founderRule` | `AS_EARNED`, `OWNER_SUBSTITUTE` | APPROVE for that plan basis |
| `paidLifetimeRule` | `OWNER_SUBSTITUTE` | APPROVE for paid-lifetime members |
| `prizeBudgetMinor` | 0–$20,000 | Prize approval |

The ladder itself (amounts and thresholds) must be complete to publish. Qualification periods and payment evidence stay in the Milestone 1 program policy, where `HON_BILLING` still fails closed.

## API (under `/v1`)

| Method and path | Authority | Command header |
| --- | --- | --- |
| `GET /hq/champions/rewards/program` | HQ owner or operator | — |
| `POST /hq/champions/rewards/policy-drafts` | HQ owner or operator | `champions-reward-policy-draft` |
| `POST /hq/champions/rewards/policy-drafts/:policyId/publish` | HQ owner | `champions-reward-policy-publish` |
| `POST /hq/champions/rewards/schools/:schoolId/reconcile` | HQ owner or operator | `champions-rewards-reconcile` |
| `GET /hq/champions/rewards/ledger[?status=]` (newest 200 plus liability totals by status and kind) | HQ owner or operator | — |
| `POST /hq/champions/rewards/entries/:entryId/decisions` | HQ owner | `champions-reward-decide` |
| `GET /schools/:schoolId/champions/rewards` (own progress, next milestone, own rewards) | School staff | — |

The same request posture as Milestone 1 applies: idempotency key, exact command header, same-origin human JSON, closed validators, no selectors.

New 422 codes:
- `CHAMPIONS_REWARD_RULE_UNDECIDED`
- `CHAMPIONS_REWARD_SUBSTITUTE_MISMATCH`
- `CHAMPIONS_PRIZE_OVER_BUDGET`
- `CHAMPIONS_CLAWBACK_NOT_PERMITTED`

**Privacy:** a school sees its referrer milestones and any welcome credit it received. A referred school never sees which school referred it. HQ sees organization and school IDs, never personal data.

## Evidence

- `apps/api/test/champions-club-rewards.test.cjs`: contracts, service mapping, routes, no fulfillment route.
- `pnpm db:test-champions-club-rewards` (also in CI) on a disposable database covers:
  - authority
  - the whole ladder to 30
  - idempotent reconciliation
  - re-accrual after a fraud void
  - reversal, restore, clawback void and retain
  - approval rules by plan basis
  - prize budget
  - liability totals
  - immutability
  - that **entitlements, memberships, invoices, payment schedules and shared audit are unchanged**
  - the API service on real output
- Its assertions were mutation-checked: removing the retained-entry guard fails the proof.

## Owner decisions still open

1. **Clawback rule:** void unfulfilled, or retain earned.
2. **Founder-plan rule:** monthly and annual default to as-earned in fixtures only; the owner sets the real values.
3. **Paid-lifetime substitute:** what substitute members receive, decided case by case or as a rule.
4. **Prize budget**, and prize tax handling.
5. **Rewards between milestones.**
6. **Fulfillment:** how credits and free months apply once HON billing exists. This needs a separate approved milestone.
