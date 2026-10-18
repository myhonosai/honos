# HON Subscription Billing — Milestone B2: HON Invoices and Payment Evidence

**Status:** implemented, tested and merged (`3d6e818`). Not deployed, not commercially active. Migration `0155_hon_invoices_payment_evidence.sql`.

**Scope boundary.** This covers **HON invoicing schools**. It shares no table, function or route with school-to-family billing:
- Separate from `billing_accounts`, `memberships`, `invoices`, `membership_payment_schedules` and `apps/api/src/billing`.
- All tables are `saas_*`. Routes are under `/v1/hq/saas/*`.

**Disabled by constraint or absence:**

| Disabled | How |
| --- | --- |
| Payment collection | `collection_enabled = false` |
| Invoice delivery | `delivery_status = 'NOT_SENT'` |
| Provider-verified evidence | `source = 'HQ_ATTESTATION'` and `provider_event_id IS NULL` |
| Provider calls, refund execution, AI credit grants, reward fulfillment, deployment | No code path |

## 1. Owner direction recorded (2026-10-18)

Decisions live in `saas_policy_records`, an append-only log over the B1 baseline.

**No recorded decision enables an action.** Every record has `actions_enabled = false`, pinned by constraint. `saas_require_policy` unblocks an action only when the latest record is `DECIDED` *and* `actions_enabled` is true, which only a later reviewed migration can set.

| Policy | Status | Decision | Still blocked |
| --- | --- | --- | --- |
| `FOUNDER_PROGRAM` | DECIDED | 50 total: 30 monthly, 20 paid lifetime, one founder offer per organization | Founder offers publish only once the owner sets eligibility, hold and window on a catalog |
| `FOUNDER_RESERVATION_HOLD` | PROPOSED | 1 day | Set per catalog; `SAAS_OWNER_APPROVED_DRAFT` now starts with `reservationHoldDays: 1` |
| `FOUNDER_SLOT_RETURN` | DECIDED | Expired or unpaid reservations return; activated founder subscriptions keep their slot on cancellation | Cancellation itself is unavailable |
| `FOUNDER_ALLOWANCE` | DECIDED | Full monthly allowance for founder and lifetime | Allowances are planned amounts until B3 |
| `REFUND_GUARANTEE` | DECIDED | 30-day full refund on the first eligible purchase | Refund execution is disabled; refunds can only be recorded as evidence |
| `CANCELLATION_TIMING` | PROPOSED | End of paid period | `CANCEL` returns 422 |
| `PLAN_CHANGE_TIMING` | PROPOSED | Billing-period boundary | `CHANGE_OFFER` returns 422 |
| `PRORATION` | PROPOSED | No automatic proration | Nothing is prorated |
| `CREDIT_ROLLOVER` | DECIDED | No rollover | Allowances not granted (B3) |
| `TOP_UP_PRICING` | DECIDED | 2× independently verified fully loaded provider cost | No verified cost is recorded, so there are no top-ups |
| `ANNUAL_BILLING` | UNDECIDED | — | Annual offers cannot be drafted |
| `TAXES` | UNDECIDED | — | No tax is assumed (see §2) |
| `REFUND_EXECUTION`, `PAYMENT_PROVIDER` | UNDECIDED | — | No refund execution, no provider |

## 2. Invoices

**Lifecycle:** `DRAFT`, then `ISSUED`, with `VOID` reachable from either.

**Rules for creating an invoice:**
- **Who:** HQ owner, or HQ operator with `hq.billing.manage`.
- **Subscription:** a catalog subscription whose service has started (`IN_SERVICE` or `SUSPENDED`).
  - Legacy and not-yet-started records are refused with `SAAS_INVOICE_NOT_BILLABLE`.
- **Monthly, regular or founder:** one live invoice per period index, for a period that has started. The service period is taken from the subscription's anchored period.
- **Paid lifetime:** one live `LIFETIME_PURCHASE` invoice per subscription.
- **First line:** a `PLAN_FEE` at the price recorded on the subscription, described from the catalog plan. Example: "HON Core — founder monthly — service period 2026-10-18 to 2026-11-18".

**Adjustments:**
- `DISCOUNT` (negative) or `CORRECTION` (signed), at most 20 lines.
- Allowed only while tax is unresolved.
- The subtotal can never go negative.
- Champions credits are **not** an adjustment kind; that is B4.

**Tax is never assumed:**
- Every invoice starts `UNRESOLVED`, with no tax amount and no total.
- Only the HQ owner can record `SET_TAX`, choosing either:
  - `NO_TAX_APPLICABLE`, or
  - `TAX_LINES` (1 to 5 jurisdiction lines with explicit amounts).
- A **verification reference** is required, and the system never computes or defaults a rate.
- Lines freeze once tax is recorded.
- Issuing with unresolved tax returns 422 `SAAS_INVOICE_TAX_UNRESOLVED`, and a constraint also forbids it.

**Numbering:**
- Assigned only at issue: `HON-<UTC year>-<6-digit sequence>`.
- Gapless per year: one sequence row is incremented under its row lock, and a rolled-back issue consumes no number.
- Voided drafts never receive a number. A voided issued invoice keeps its number.
- The proof issues two invoices concurrently and checks they get distinct consecutive numbers.

**Voiding:** HQ owner only. An issued invoice that has any payment evidence cannot be voided (`SAAS_INVOICE_HAS_EVIDENCE`).

**Audit:** every draft, adjustment, tax decision, issue and void writes one idempotency receipt, one audit row and one inert outbox event. Lines, totals and numbers are immutable after issue.

## 3. Payment evidence (append-only)

**Entries:**
- **Kinds:** `PAYMENT_RECEIVED`, `REFUND` and `CHARGEBACK`.
- **Recorded by:** HQ owner only, on issued invoices only.
- **Fields:**
  - occurred-at (never in the future)
  - external reference (unique per invoice and kind)
  - optional note
- **Refunds and chargebacks:**
  - must reference the payment they reverse, on the same invoice
  - cannot exceed what remains of that payment
  - cannot predate it

**Overpayment:** refused (`SAAS_PAYMENT_EXCEEDS_BALANCE`).

**Attestation is never verification.** The API input has no `source` field, and every entry is stored as `HQ_ATTESTATION` with `providerVerified: false`. `PROVIDER_VERIFIED` exists in the reporting model but cannot be stored: it waits for a separately approved provider milestone (B5) and its webhook verification.

**Evidence has no other effect.** It never changes a subscription, founder reservation, entitlement, Champions attribution or reward. The proof snapshots all of these before and after.

**Settlement per invoice:**
- **Amounts:** `receivedMinor`, `refundedMinor`, `chargedBackMinor`, `netMinor`, `verifiedNetMinor` (always 0 today) and `balanceMinor`.
- **State:** `UNPAID`, `PARTIALLY_PAID`, `PAID_ATTESTED`, `REVERSED`, `NOT_ISSUED` or `VOID`.
- `PAID_VERIFIED` cannot occur until a provider exists.

## 4. Payment standing (for future Champions qualification)

`GET /v1/hq/saas/organizations/:id/payment-standing` returns two strengths.

| Strength | Counts | Use |
| --- | --- | --- |
| `verified` | Provider-verified evidence only. Always empty today | The **only** strength Champions Club may consume as `HON_BILLING` |
| `recorded` | Verified evidence plus HQ attestations | HQ bookkeeping only. Never rewards |

Each strength reports:
- `firstPaidAt`
- `paidThroughAt`: end of the last *consecutively* paid monthly period of the current subscription
- `lifetimePaid`
- `paidInvoiceCount`
- `refundedInvoiceCount`
- `chargebackInvoiceCount`

An invoice counts as paid only while its net evidence covers its total, so a refund or chargeback removes it.

`championsPaymentSource` is `NOT_CONNECTED`. Champions Club was not modified, and its `HON_BILLING` source still refuses, as M1 designed.

## 5. API (`@hon/contracts`, `saas-invoicing.ts`)

| Method and path | Authority | Header | Types |
| --- | --- | --- | --- |
| `GET /v1/hq/saas/invoices[?status=]` | Owner or operator | — | `SaasInvoiceList` (newest 200) |
| `POST /v1/hq/saas/invoices` | Owner or operator | `saas-invoice-draft` | `SaasInvoiceDraftInput` → `SaasInvoiceReceipt` |
| `GET /v1/hq/saas/invoices/:invoiceId` | Owner or operator | — | `SaasInvoiceDetail` (lines, evidence, settlement) |
| `POST /v1/hq/saas/invoices/:invoiceId/commands` | `ADD_ADJUSTMENT`: owner or operator. `SET_TAX`, `ISSUE`, `VOID`: owner | `saas-invoice-command` | `SaasInvoiceCommand` → `SaasInvoiceCommandReceipt` |
| `POST /v1/hq/saas/invoices/:invoiceId/payment-evidence` | Owner | `saas-payment-evidence` | `SaasPaymentEvidenceInput` → `SaasPaymentEvidenceReceipt` |
| `GET /v1/hq/saas/organizations/:organizationId/payment-standing` | Owner or operator | — | `SaasPaymentStanding` |

**New 422 codes:**
- `SAAS_INVOICE_NOT_BILLABLE`, `SAAS_INVOICE_PERIOD_NOT_STARTED`, `SAAS_INVOICE_EXISTS`
- `SAAS_INVOICE_TOO_MANY_LINES`, `SAAS_INVOICE_NEGATIVE_TOTAL`, `SAAS_INVOICE_TAX_UNRESOLVED`, `SAAS_INVOICE_ZERO_TOTAL`
- `SAAS_INVOICE_HAS_EVIDENCE`, `SAAS_INVOICE_NOT_ISSUED`
- `SAAS_EVIDENCE_IN_FUTURE`, `SAAS_EVIDENCE_DUPLICATE_REFERENCE`, `SAAS_EVIDENCE_RELATED_MISMATCH`, `SAAS_EVIDENCE_BEFORE_PAYMENT`
- `SAAS_PAYMENT_EXCEEDS_BALANCE`, `SAAS_REVERSAL_EXCEEDS_PAYMENT`

**UI rules:**
- Show `PAID_ATTESTED` as "Recorded as paid by HQ (not processor-confirmed)".
- Never show "sent", "charged" or "collected".
- Never treat `recorded` standing as qualifying a referral.

## 6. Not implemented in B2 (planned)

- Sending invoices, collecting payment, checkout, provider webhooks, `PROVIDER_VERIFIED` evidence: B5.
- Executing refunds and evaluating the 30-day guarantee window: B4.
- Applying Champions credits or free months to invoices: B4.
- Tax computation and tax configuration beyond per-invoice owner-verified treatment: pending the `TAXES` decision.
- Pre-service (advance) invoicing, automatic invoice generation per period, the school-facing invoice view and invoice documents (PDF).

## 7. Proposed B3 — monthly AI credit allowances, reservations, consumption, release and warnings

> **Implemented in B3:** see [HON_PREMIUM_CREDITS_B3.md](HON_PREMIUM_CREDITS_B3.md). The proposal below is kept for history.

This is accounting only: no provider calls and no automatic charges.

**1. Allowance periods**
- One allowance row per subscription service period, with planned credits copied from the catalog plan:
  - Core: 5,000
  - Complete: 12,000
  - Founder and lifetime: full allowance (`FOUNDER_ALLOWANCE`)
- Lifetime uses calendar-month allowance periods anchored to service start.
- No rollover (`CREDIT_ROLLOVER`): unused credits expire with the period, recorded explicitly.
- Granting stays pinned off until the owner approves activation, so B3 can ship as "planned allowance" accounting first.

**2. Ledger** (append-only), one entry per movement:
- `RESERVE`: estimated, idempotent per Action Engine request
- `FINALIZE`: actual, never more than reserved without a new approval
- `RELEASE`: unused amount, or the full amount on provider failure
- `EXPIRE`: at period end

**3. Integrity rules**
- Idempotent retry never double-charges.
- Reservations are serialized per subscription.
- The balance is derived from the ledger.
- Only operations classified as premium can reserve. Ordinary operations and the ordinary assistant never touch the ledger, as the plan capabilities already state.

**4. Thresholds:** 75%, 90% and 100% states on each period, as warning records only. Notifications wait for approved outbound messaging. At 100%, premium reservations are refused; there is no automatic overage.

**5. Top-ups:** modelled, but unavailable until a verified provider-cost record exists (`TOP_UP_PRICING` = 2× that cost). Top-up purchases would invoice through B2.

**6. Links:** connects to the existing `ai_usage_ledger` for approved premium operations, without changing Action Engine behavior until reviewed.

**Owner decisions needed:**
- which operations count as premium, and their credit price per operation
- the provider-cost source of truth and who verifies it
- whether a suspended subscription keeps its allowance
- whether Champions free months carry the full allowance (policy says full allowance for founder and lifetime)
