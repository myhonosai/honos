# HON Subscription Billing — Milestone B3: Premium AI Credit Allowances and Usage Accounting

**Status:** implemented and tested on disposable databases. Not merged, not deployed, not commercially active. Migration `0156_hon_premium_credit_accounting.sql`.

**Ships inactive.**
- The credit program starts `INACTIVE`. While it is inactive, no allowance is opened and no premium reservation is made.
- Only the HQ owner can activate it, and only with an authorization reference and published pricing.
- Never available: purchases, top-ups or overage. All three are pinned by constraint, and none has a route.
- No provider is called here: the future premium job runtime makes provider calls and reports their outcome.

## 1. What counts as premium

**Never premium.** These never touch the premium ledger: ordinary HON assistant conversations, CRM, attendance and scheduling, reporting and dashboards, deterministic automation, third-party lead sync, and routine operations (`SAAS_INCLUDED_OPERATIONS`).
- Their provider usage stays in the existing `ai_usage_ledger`, governed by the existing per-assistant fair-use caps and routing cost ceilings.
- HQ sees that usage (`ordinaryUsageThisMonth`, with `premiumDeduction: NONE`), but it is never deducted from the allowance.

**Premium.** Only HQ-published operations are premium. Categories:
- `IMAGE_GENERATION`
- `VIDEO_GENERATION`
- `VOICE_GENERATION`
- `AI_EMPLOYEE_TASK`
- `DEEP_RESEARCH`
- `CAMPAIGN_OPTIMIZATION`
- `OTHER_APPROVED`

**Plan differences are preserved.** Each operation names the B1 capability it requires. `AI_EMPLOYEE_TASK` must require the workforce, delegated-jobs or orchestration capability, and `CAMPAIGN_OPTIMIZATION` must require AI-managed campaigns. Both are Complete-only, so Core schools cannot reserve them (`SAAS_OPERATION_NOT_IN_PLAN`).

## 2. Pricing linked to verified provider economics (no invented prices)

**1. Provider cost evidence** (`saas_provider_cost_evidence`, append-only, HQ owner only):
- Fields:
  - provider (from the existing `hq_ai_provider_connections`) and model
  - cost unit (`IMAGE`, `VIDEO_SECOND`, `AUDIO_SECOND`, `TOKEN_1K`, `REQUEST`, `TASK`)
  - measured units, billed cost, fully loaded cost (never below billed)
  - the provider billing or usage reference, and the period it covers
- Source: `HQ_OWNER_VERIFIED_PROVIDER_BILLING`.
- There is no default or assumed cost.

**2. Versioned pricing** (`saas_pricing_versions` and `saas_operation_prices`):
- **Drafts:** HQ owner, or operator with `hq.billing.manage`.
- **Publishing:** owner only, and terms are required.
- **Each operation price** stores:
  - the approved customer-facing price in credits per unit
  - a per-request unit cap
  - the required capability
  - the cost evidence it is based on, in the same unit (`SAAS_PRICING_COST_EVIDENCE_MISMATCH` otherwise)
- **Published prices are frozen.** A change is a new version.
- **HQ views show unit economics:** fully loaded cost per unit and per credit. School views never show provider cost.

**3. Estimates.** `GET /v1/schools/:id/ai-credits/estimate` returns the estimated credits before execution, whether the work is allowed, and the refusal reason if not. It writes nothing.

## 3. Allowances

- **One authoritative allowance per subscription allowance period:** `saas_credit_allowances`, unique on (subscription, period).
  - **Monthly regular or founder:** the subscription's recorded billing period.
  - **Paid lifetime and legacy Core/Complete:** calendar months anchored in UTC to service start, for as long as service continues.
- **Credits come from the B1 catalog plan:** Core 5,000, Complete 12,000.
  - Founder, paid lifetime and legacy subscriptions get the **full** plan allowance (`allowance_basis`: `REGULAR`, `FOUNDER`, `LIFETIME`, `LEGACY`).
  - A guard makes allowance credits immutable, so they can never be reduced after opening.
  - Champions free months and referral-earned lifetime will use the same full allowance when B4 fulfills them.
- **Opening:**
  - Lazy, at the first reservation of the period, or by an HQ `OPEN_CURRENT` command.
  - Opening is a grant, so it needs an `IN_SERVICE` subscription and an active program.
  - Essential has no premium allowance.
- **No rollover.** When a period ends, its open allowance is closed with an `EXPIRE` entry for the unused balance, either automatically at the next reservation or by HQ `EXPIRE`. The next period starts at the full allowance.

## 4. Ledger and premium job lifecycle

**The ledger.** `saas_credit_ledger` is append-only. Each reservation has exactly one `RESERVE`, then either `FINALIZE f` plus `RELEASE (r − f)`, or `RELEASE r`. Each closed allowance has one `EXPIRE`. Balances are derived from the ledger:
- committed = consumed + held
- available = allowance − committed

The lifecycle, step by step:

| Step | Who | Effect |
| --- | --- | --- |
| `RESERVE` | Premium job runtime, as the requesting staff member (`ai.premium.request` at the exact school) | Checks: program active, subscription in service, operation published, unit cap, plan capability, available balance. Records the organization, school, subscription, user, AI employee key, operation, pricing version, provider and model, and the Action Engine request or work item. |
| Retry | Same key | Returns the original reservation. Credits are never held twice; a different body with the same key returns 409. |
| `SUCCEEDED` | Requester | Finalizes the actual units × price, never above the reservation (`SAAS_FINAL_EXCEEDS_RESERVATION`), and releases the rest. Provider cost goes to `ai_usage_ledger` with `customer_credits = 0`. |
| `FAILED` | Requester | Releases everything. Any provider cost still incurred is recorded, not erased. |
| `UNKNOWN` | Requester | Credits stay held. There is no blind retry: settling again returns 409. |
| Resolve | HQ owner, with a provider evidence reference | `SUCCEEDED` (finalize actual units and cost) or `NOT_CHARGED` (release). |

**Concurrency.** Every reservation and settlement for a subscription is serialized by the subscription row lock and an advisory lock. In the proof, eight simultaneous reservations against 12,000 credits produce exactly six successes and two `SAAS_CREDITS_EXHAUSTED`.

**Thresholds.**
- At 75%, 90% and 100% committed, a threshold event is recorded once per allowance. The notification status is pinned to `NOT_SENT`, because outbound messaging is not activated.
- At 100%, or whenever the request exceeds the available balance, the reservation is refused. There is no top-up and no overage.

**Suspension** (owner decision recorded as `SUSPENDED_ALLOWANCE`):
- A suspended subscription gets no new allowance and can start no new premium job.
- Existing allowances and ledgers are kept.
- In-flight reservations still settle, so incurred provider cost is recorded.
- Deactivating the program behaves the same way.

**Requester only.** Only the staff member who reserved can settle (`SAAS_FORBIDDEN` otherwise). If that staff member loses access mid-job, the runtime reports `UNKNOWN` through HQ resolution. Remaining work: HQ tooling for reservations stuck in `RESERVED`.

## 5. Owner decisions recorded

These are append-only policy records with `actions_enabled = false`.

| Policy | Status | Recorded |
| --- | --- | --- |
| `PLAN_ALLOWANCES` | DECIDED | Core 5,000 and Complete 12,000; full allowance for founder, lifetime, Champions free months and referral lifetime; no rollover |
| `PREMIUM_OPERATIONS` | DECIDED | HQ-published, verified-cost-linked pricing; the included operations never consume credits |
| `SUSPENDED_ALLOWANCE` | DECIDED | No new grants or jobs while suspended; in-flight work settles |
| `PAYMENT_ATTESTATION` | DECIDED | HQ owner only (already enforced in B2) |
| `TAXES` | UNDECIDED (version 3) | Zero tax is never assumed; issuing needs a documented authoritative verification reference |
| `TOP_UP_PRICING` | DECIDED (version 3) | 2× verified fully loaded provider cost; top-ups and their purchase stay unavailable |

Cancellation, proration, refund execution, annual billing and live payment processing all remain disabled.

## 6. API (`@hon/contracts`, `saas-credits.ts`)

| Method and path | Authority | Header | Types |
| --- | --- | --- | --- |
| `GET /v1/hq/saas/credits` | Owner or operator | — | `SaasCreditProgramView` |
| `POST /v1/hq/saas/credits/program` | Owner | `saas-credit-program` | `SaasCreditProgramInput` → `SaasCreditProgramReceipt` |
| `POST /v1/hq/saas/credits/cost-evidence` | Owner | `saas-cost-evidence` | `SaasCostEvidenceInput` → `SaasCostEvidenceReceipt` |
| `POST /v1/hq/saas/credits/pricing-drafts` | Owner or operator | `saas-pricing-draft` | `SaasPricingDraftInput` → `SaasPricingReceipt` |
| `POST /v1/hq/saas/credits/pricing-drafts/:id/publish` | Owner | `saas-pricing-publish` | `{}` → `SaasPricingPublishReceipt` |
| `POST /v1/hq/saas/credits/allowances` | Owner or operator | `saas-credit-allowance` | `SaasAllowanceCommand` (`OPEN_CURRENT`, `EXPIRE`) → `SaasAllowanceReceipt` |
| `POST /v1/hq/saas/credits/reservations/:id/resolve` | Owner | `saas-credit-resolve` | `SaasCreditResolveInput` → `SaasCreditResolveReceipt` |
| `GET /v1/hq/saas/organizations/:id/credits` | Owner or operator | — | `SaasOrganizationCredits` (allowances, reservations with provider cost, ordinary usage) |
| `GET /v1/schools/:schoolId/ai-credits` | School staff with `ai.premium.request` | — | `SaasSchoolCredits` (no provider cost) |
| `GET /v1/schools/:schoolId/ai-credits/estimate?operation=&units=` | School staff | — | `SaasCreditEstimate` |

**Runtime-only, with no HTTP route:** `SaasBillingService.reservePremiumCredits` and `settlePremiumCredits` (`SaasCreditReserveInput`, `SaasCreditSettleInput`). The future premium job runtime calls them around each provider call. No school route can reserve or purchase credits.

**Permission.** The migration adds `ai.premium.request`, which is staff-assignable and granted to existing system `OWNER` roles. It does nothing while the program is inactive.

## 7. Implemented vs unavailable

**Implemented (B3):** everything in §2 to §6, proven on disposable PostgreSQL with 30 commands through the real API service, concurrency and mutation checks.

**Unavailable by design:**
- top-up purchase
- automatic overage, card charges and any payment collection
- notifications for thresholds
- provider execution (no premium job runtime is wired yet)
- school-initiated reservation
- the automatic scheduler for period rollover (HQ advances periods; allowances follow)

**Not yet integrated:**
- the existing Marcus, Claire and Chad assistant flows still use their existing fair-use accounting; they are ordinary use and correctly stay outside premium credits
- wiring real premium operations (image, video, voice, AI employee jobs) into reserve and settle through the Action Engine

## 8. Proposed B4 — 30-day refund guarantee and Champions Club fulfillment (superseded)

Implemented in a narrower, safer form in [B4](HON_REFUNDS_CHAMPIONS_REWARDS_B4.md): no subscription consequences, no lifetime subscription records and no Champions billing connection until terms and B5 exist. The original proposal follows for reference.

Recordkeeping and approvals only. Executing a real refund requires a provider (B5) and explicit owner approval.

**1. Refund requests:**
- One per first eligible HON plan purchase (B2 invoice).
- Eligibility is computed from the B2 evidence:
  - first plan purchase
  - inside 30 days of the first recorded payment
  - including founder and lifetime, per the published final terms
- Lifecycle: `REQUESTED`, `APPROVED` or `DECLINED`, then `EXECUTED_EVIDENCED` once refund evidence (B2 `REFUND`) is recorded.
- Approval: HQ owner, idempotent and audited.
- Effects:
  - The founder slot is retained or returned per `FOUNDER_SLOT_RETURN`.
  - The subscription ends at the end of the period or immediately, per the finalized `CANCELLATION_TIMING`; this stays blocked until terms are approved.
  - Credits in an open allowance are expired, never clawed back as money.
- Report of the refund liquidity reserved against paid-lifetime receipts.

**2. Champions fulfillment:**
- Connect Champions `HON_BILLING` to the B2 **verified** standing only. Until B5 exists, it stays `NOT_CONNECTED`, and owner attestation remains the explicit Champions source.
- Apply approved Champions liabilities (M2 and M4) as:
  - B2 invoice credit lines, as a new adjustment kind, owner-approved and capped at the invoice subtotal
  - free months: a zero-price service-period record that still opens a **full** B3 allowance (new basis `CHAMPIONS_FREE_MONTH`)
  - referral-earned lifetime: a lifetime subscription record (basis `CHAMPIONS_LIFETIME`), with a full monthly allowance
- Each fulfillment is idempotent, audited and reversible only through the M2 reversal review. Nothing is issued while financial activation stays disabled.

**Owner decisions needed for B4:**
- final refund terms: founder and lifetime coverage, what counts as the first purchase, partial-month handling
- cancellation timing
- whether Champions credits may reduce an invoice to zero
- free-month stacking rules
- the clawback rule (already pending from Champions M2)
