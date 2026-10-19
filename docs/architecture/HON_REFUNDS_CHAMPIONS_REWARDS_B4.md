# HON Subscription Billing — Milestone B4: 30-Day Refund Guarantee and Champions Reward Application

**Status:** PR open for owner review; **not merged**. Migration `0157_hon_refunds_champions_fulfillment.sql`, contracts `@hon/contracts` `saas-refunds-rewards.ts`.

B4 connects existing systems instead of adding parallel ones:
- B1 subscriptions
- B2 invoices and payment evidence
- the B3 credit allowance ledger
- the Champions Club M2 reward ledger, with M1 attributions and M5 automatic reconciliation

**Nothing moves money:**
- Refund execution is `UNAVAILABLE`, and every refund request is pinned to `executionStatus: NOT_EXECUTED` and `subscriptionConsequence: BLOCKED_PENDING_TERMS`.
- Prizes are never issued, and cash payouts are disabled by constraint.
- Reward application ships behind an owner switch that is `INACTIVE`.
- A preview is never fulfillment: every preview row carries `fulfilledNotice: PREVIEW_IS_NOT_FULFILLMENT`.

## 1. Refund guarantee (records, approvals and accounting only)

Owner policy `REFUND_GUARANTEE` v3 is `DECIDED` as `FIRST_PURCHASE_30_DAY_FULL_REFUND_ALL_OFFERS`. It covers regular Core and Complete, founder monthly and paid lifetime.

**First eligible purchase:** the organization's issued HON invoice with the earliest recorded `PAYMENT_RECEIVED`. A later purchase never restarts the window.

**Window:** `[firstPaidAt, firstPaidAt + 30 days)`. Day 30 itself is excluded.
- Eligibility uses `requestReceivedAt`, the moment the customer asked.
- A request received inside the window but recorded later is still covered.
- A future receipt time is refused.

**Amount:** 100% of what is still recorded as paid on that invoice (B2 net of refunds and chargebacks).
- Account credit is not cash. A $149 invoice reduced to $49 by a welcome credit refunds $49.

**Refusals (422):** `SAAS_REFUND_NO_PAID_PURCHASE`, `SAAS_REFUND_BEFORE_PAYMENT`, `SAAS_REFUND_WINDOW_EXPIRED`, `SAAS_REFUND_REQUEST_OPEN`, `SAAS_REFUND_ALREADY_GRANTED`, `SAAS_REFUND_NOTHING_TO_REFUND`.

**Lifecycle:**

```
REQUESTED --APPROVE (owner)--> APPROVED --MARK_EVIDENCED (owner)--> REFUND_EVIDENCED
          \-DENY (owner)-----> DENIED
```

- **Intake:** owner or operator (`hq.billing.manage`) records the customer's request. Eligibility is computed, never asserted.
- **Approve:** fixes `approvedAmountMinor` at the current recorded net.
- **Deny:** needs a reason: `OWNER_DECLINED_TERMS`, `FRAUD_SUSPECTED` or `DUPLICATE_REQUEST`.
- **Mark evidenced:** requires B2 `REFUND` evidence on that invoice covering the approved amount. The refund itself happens outside HON until B5.
- **Duplicates:** at most one live (non-denied) request per organization, enforced by a partial unique index and serialized per organization. A granted refund refuses any further request.
- **Audit trail:** status history is append-only (`saas_refund_history`), and every command carries an idempotency receipt, an audit row and an inert outbox event.
- **No side effects:** no subscription, founder slot, entitlement or allowance changes. Cancellation timing and founder-slot consequences stay blocked until final terms exist.

**Refund reserve report** (`GET /v1/hq/saas/refunds/reserve`) has three parts:
- first purchases still inside their window with no live request, split into paid lifetime and monthly
- approved refunds not yet evidenced
- pending requests

`recommendedReserveMinor` is their sum. Amounts are `RECORDED`, meaning HQ-attested until a provider exists.

## 2. Rewards ladder (accounting from Champions M2)

`CHAMPIONS_REWARD_LADDER` v2 is `DECIDED`. Amounts come from the published Champions reward policy, not from B4.

| Qualified referrals | Liability (M2 entry) | B4 application |
|---|---|---|
| 1–4 | $100 `REFERRER_CREDIT` each | `ACCOUNT_CREDIT` grant to the referrer |
| each referred school | $100 `WELCOME_CREDIT` | `ACCOUNT_CREDIT` grant to the referred school |
| 5 | `FREE_MONTHS` (6 total) | 6 `FREE_PERIODS` rows |
| 10 | `FREE_MONTHS` (12 total incl. the 6 → +6) | 6 more `FREE_PERIODS` rows |
| 20 | `PRIZE` | never applied (`SAAS_REWARD_PRIZE_MANUAL`) |
| 30 | `LIFETIME_MEMBERSHIP`, `FULL_PLAN_ALLOWANCE` | `LIFETIME_CONVERSION` recorded as `CONVERSION_BLOCKED` |

## 3. Applying rewards (owner, behind the fulfillment switch)

**Switch:** `saas_reward_fulfillment` is a singleton that ships `INACTIVE`. Only the HQ owner can activate it, with an authorization reference. `prizes_issued` and `cash_payouts` are pinned false.

**Who applies:** the HQ owner, one Champions entry at a time (`POST /v1/hq/saas/rewards/:rewardEntryId/apply`), and only when all of these hold:
- the entry is `APPROVED` and `AS_EARNED`; owner substitutes and prizes stay manual
- the entry version matches
- no open referral payment alert concerns it
- the beneficiary has a live HON subscription
- fulfillment is `ACTIVE`

**Uniqueness:** one application per entry ever (unique `reward_entry_id`). The entry row is locked, and applications are serialized per beneficiary.

**Account credit:**
- A grant is recorded in an append-only ledger.
- `POST /v1/hq/saas/invoices/:invoiceId/account-credit` (owner) consumes usable grants first-in-first-out onto a **draft** invoice whose tax is still unresolved, as a negative `ACCOUNT_CREDIT` line, capped at the invoice subtotal.
- The `GET` on the same path is a preview that changes nothing.
- A zero-total invoice can be drafted but **cannot be issued**: `ZERO_DOLLAR_INVOICE` is `UNDECIDED`, so B2 refuses with `SAAS_INVOICE_ZERO_TOTAL`.
- Credit applied to an invoice that is later voided is restored.
- Unused balance is tracked as granted, applied, available and blocked.

**Free months:**
- They are recorded per billing period (primary key `(subscription_id, period_index)`), so they are never counted twice.
- They must start at or after the current period and never overlap an invoiced or already-free period.
- A free period can never be invoiced: a trigger on `saas_invoices` raises `SAAS_PERIOD_FREE`.

**Lifetime:** converting a monthly subscription to lifetime is a plan change, so B4 records the application and does not change the plan, entitlement or founder history.

**Original history** of plans, offers and entitlements is never rewritten.

## 4. Refunds, chargebacks and reversals of referred schools

**Alert sources** (`saas_referral_payment_alerts`, status `OPEN`):
- B2 `REFUND` or `CHARGEBACK` evidence on a school referred by a `QUALIFIED` attribution (trigger on `saas_payment_evidence`)
- an approved refund request for such a school

**Effect of an open alert:**
- It blocks the referred school's own welcome credit.
- It blocks all of the referrer school's ladder rewards, both unapplied entries and unapplied account-credit balances.
- The preview shows `BLOCKED_REVIEW`, and applying refuses with `SAAS_REWARD_PAYMENT_ALERT_OPEN`.
- Each alert lists `affectedApplications` (benefits already applied) for owner review.
- `automaticReversal` is always `NONE` and `debtCreated` is always `false`. Nothing fulfilled is reversed, clawed back or charged; `REWARD_CLAWBACK` stays `UNDECIDED`.

**Resolution (owner):**
- `ATTRIBUTION_DECIDED` is accepted only once Champions has actually decided the attribution (no longer `QUALIFIED`). Champions M5 then reconciles, and affected liabilities move to `REVERSAL_REVIEW`.
- `NO_QUALIFICATION_IMPACT` resolves the alert with a reference.

## 5. AI allowance consistency (B3 ledger, no second ledger)

- A free month opens the normal B3 allowance for that period with the **full** plan amount (Core 5,000, Complete 12,000). It is labelled `CHAMPIONS_FREE_MONTH` by a trigger.
- B3 rules still apply:
  - one allowance per period
  - no rollover (the previous period expires)
  - no grant while suspended or while the credit program is inactive
- Lifetime keeps the B3 `LIFETIME` basis and the full monthly allowance.
- No premium provider is activated.

## 6. API (HQ only; owner or operator unless noted)

| Method and path | Purpose |
|---|---|
| `GET /v1/hq/saas/refunds?status=` | refund requests |
| `GET /v1/hq/saas/refunds/reserve` | refund reserve report |
| `POST /v1/hq/saas/refunds` (`saas-refund-request`) | record a request |
| `POST /v1/hq/saas/refunds/:id/decision` (`saas-refund-decide`, owner) | approve, deny or mark evidenced |
| `GET /v1/hq/saas/organizations/:id/refund-eligibility?receivedAt=` | eligibility preview |
| `GET /v1/hq/saas/organizations/:id/rewards` | reward preview (states, blockers, credit balance, free periods, alerts) |
| `POST /v1/hq/saas/rewards/fulfillment` (`saas-reward-fulfillment`, owner) | activate or deactivate |
| `POST /v1/hq/saas/rewards/:rewardEntryId/apply` (`saas-reward-apply`, owner) | apply one entry |
| `GET`/`POST /v1/hq/saas/invoices/:id/account-credit` (`saas-account-credit-apply`, owner) | preview or apply credit |
| `GET /v1/hq/saas/referral-alerts?status=` | alerts |
| `POST /v1/hq/saas/referral-alerts/:id/resolve` (`saas-referral-alert-resolve`, owner) | resolve an alert |

- Commands need the exact human-command header, same-origin fetch metadata, JSON and an `Idempotency-Key`.
- Responses are closed contracts, so any drift returns 503.
- School and family roles have no route.
- There is no refund execution, payout, prize, reversal or clawback route.

## 7. Implemented vs unavailable

- **Implemented and proven** (disposable PostgreSQL 16, `test-saas-refunds-rewards-integrity.mjs` through the real API and Champions services): everything above.
- **Unavailable by design:**
  - refund execution
  - subscription consequences of a refund (cancellation and founder-slot handling)
  - issuing zero-total invoices
  - lifetime plan conversion
  - prize issue
  - cash payouts
  - clawback or debt
  - customer-facing reward notifications
- **Not yet connected:**
  - Champions `HON_BILLING` qualification reading B2 **provider-verified** standing (requires B5)
  - the Codex HQ screens for these contracts

## 8. Owner decisions needed

1. Final customer refund terms, and when refund execution may be enabled (needs the B5 provider).
2. Cancellation timing and founder-slot handling after a granted refund.
3. `ZERO_DOLLAR_INVOICE`: may a fully credited invoice be issued at $0?
4. `REWARD_CLAWBACK`: what happens to benefits already applied when a referral is reversed.
5. Lifetime conversion terms for referral-earned lifetime (plan record, billing end and founder interplay).
6. When to activate reward fulfillment.
