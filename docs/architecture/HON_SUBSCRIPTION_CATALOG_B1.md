# HON Subscription Billing — Milestone B1: Plan Catalog, Founder Inventory and Subscription Records

**Status:** implemented and tested on disposable databases. Not merged, not deployed, not commercially active. Migration `0154_hon_subscription_catalog.sql`.

**Scope boundary.** This is **HON billing schools**. It shares no table, function or route with **school-to-family billing**:
- Separate from: `billing_accounts`, `memberships`, `invoices`, `membership_payment_schedules`, `apps/api/src/billing`.
- Everything is prefixed `saas_` and served under `/v1/hq/saas/*`.

**Nothing here is financial activation.** The following are pinned by database `CHECK` constraints:
- `charges_enabled = false` and `credit_grants_enabled = false`
- `payment_status = 'NOT_BILLED'` and `paid_through_at IS NULL`

There is no provider call, checkout, charge, invoice, refund, credit grant or balance, and no route for any of them.

## 1. What B1 implements

| Capability | How it works | Proof |
| --- | --- | --- |
| **Versioned catalog** | `saas_catalog_versions` holds `DRAFT`, then `PUBLISHED` (exactly one at a time), then `RETIRED`. Drafts are immutable, so a revision is a new version. Plans and offers can be inserted only into a draft and never change afterwards. | Guards are tested with direct owner writes. |
| **Core and Complete offers** | `REGULAR_MONTHLY`, `FOUNDER_MONTHLY` and `FOUNDER_LIFETIME` per plan. Each lifetime offer carries `allowance: FULL_MONTHLY_PLAN_ALLOWANCE`. | Approved prices round-trip exactly. |
| **Essential is legacy only** | Every catalog contains Essential as `LEGACY_ONLY` with no planned credits. A `CHECK` makes an Essential offer impossible, so Essential schools can only have a `LEGACY_ENTITLEMENT` record. | Constraint and API checks |
| **Different functional entitlements** | `hon.saas_plan_capabilities()` is the canonical list and is enforced by `CHECK`. Core is the conventional operating system plus `assistant.ordinary`. Complete adds `ai.workforce`, `ai.delegated_jobs`, `ai.orchestration`, `marketing.campaigns_ai_managed` and `attribution.ai_insight`. Every plan reports `ordinaryUseConsumesCredits: false`. | Adding `ai.workforce` to Core is refused. |
| **HQ drafting, owner publication** | Drafts: HQ owner, or HQ operator with `hq.billing.manage`. Publish: HQ owner only. Publishing requires terms, both planned allowances and a regular offer for each plan. Founder offers also need their limits, eligibility, hold length and window. | Authority matrix |
| **Founder inventory** | Limits are owner configuration on the catalog: total, lifetime, and an **explicit** monthly limit, so unused lifetime slots are never silently treated as monthly. Other settings: eligibility (`NO_PRIOR_CATALOG_SUBSCRIPTION` or `ANY_ACTIVE_ORGANIZATION`; `UNDECIDED` blocks publication), hold days, and the opening and closing window. Reservations are serialized under one global lock. A slot counts while held (until its hold expires) or once allocated. Lowering a limit below current usage is refused. | Four concurrent reservations for two slots: exactly two succeed. Removing the lock makes the proof fail. |
| **Subscription records** | One live record per organization. Fields: plan, offer, interval (`MONTHLY`, `LIFETIME`, or `NONE` for legacy), price as recorded, status, and period metadata. Status values: `PENDING_ACTIVATION`, `IN_SERVICE`, `SUSPENDED`, `VOIDED`. Monthly periods are anchored to service start, so they never drift. | Anchored period arithmetic |
| **Entitlement relationship** | `organization_entitlements` stays the only functional-access authority, and B1 never writes it. Recording or starting service needs an active entitlement whose tier equals the plan. A tier change made through the existing HQ transition (0146) shows as `alignment: MISMATCH`, and `RESUME` is then refused. | Mismatch is refused, and removing the check fails the proof. |
| **Legacy preserved** | `LEGACY_ENTITLEMENT` records link existing schools (including Essential) to their current entitlement with no price and no periods. Retired catalogs keep the offer and price each record was made on. | Legacy and retired-catalog checks |
| **Evidence** | Every command writes one idempotency receipt (actor, key and SHA-256 fingerprint), one audit row and one inert outbox event (`internalOnly: true`, `executionAllowed: false`). It also writes an append-only subscription history row. | Exact counts, and no history gaps |
| **Isolation** | 10 tables with forced deny-all RLS and no grants. 26 functions with a fixed `search_path`, 10 of them runtime-callable `SECURITY DEFINER`. Tenant, family, delegated and Action Engine context is refused, and support and school staff are refused. | `verify-rls` and `saas-billing-security.mjs` |

## 2. Undecided owner policies (explicit and enforced)

`saas_policy_decisions` holds one row per decision. `status` is pinned to `UNDECIDED` by constraint, so changing it needs a reviewed migration.

| Policy | What it blocks today |
| --- | --- |
| `ANNUAL_BILLING` | `REGULAR_ANNUAL` and `FOUNDER_ANNUAL` drafts return 422 `SAAS_POLICY_UNDECIDED`, and no annual kind exists in the schema. |
| `PLAN_CHANGE_TIMING`, `PRORATION` | `CHANGE_OFFER` (upgrade or downgrade) returns 422. |
| `CANCELLATION_TIMING`, `REFUND_EXECUTION` | `CANCEL` returns 422. Suspension is available, and so is `VOID`, but only for a record that never started service. |
| `TAXES` | No tax is computed or stored. Prices are pre-tax list prices. |
| `PAYMENT_PROVIDER` | There is no checkout, charge, invoice or payment evidence. |
| `FOUNDER_SLOT_RETURN` | An allocated founder slot is never returned to inventory. The one exception: voiding a record that never started service releases its slot. |
| `CREDIT_ROLLOVER`, `TOP_UP_PRICING` | Allowances are planned amounts (`status: NOT_GRANTED`). No top-up exists. |

The 30-day refund guarantee is **not** implemented here. It belongs to B4.

## 3. API contracts for Codex (`@hon/contracts`, `saas-billing.ts`)

The rules match the Champions Club routes:
- Reads take session identity only and return `no-store`.
- Commands are same-origin human JSON with an `Idempotency-Key` UUID and the exact `x-hon-human-command` value, exported as `SAAS_COMMANDS`.
- Every response is `{ data }`, checked by a closed validator. Drift returns 503.

| Method and path | Authority | Header | Types |
| --- | --- | --- | --- |
| `GET /v1/hq/saas/catalog` | Owner or operator | — | `SaasCatalogView`: published, drafts, `policies`, `founderInventory` |
| `POST /v1/hq/saas/catalog/drafts` | Owner or operator | `saas-catalog-draft` | `SaasCatalogDraftInput` → `SaasCatalogDraftReceipt` |
| `POST /v1/hq/saas/catalog/drafts/:catalogId/publish` | Owner | `saas-catalog-publish` | `{}` → `SaasCatalogPublishReceipt` |
| `GET /v1/hq/saas/founder-reservations[?status=]` | Owner or operator | — | `SaasFounderReservationList` |
| `POST /v1/hq/saas/founder-reservations` | Owner | `saas-founder-reserve` | `{organizationId, offerId}` → `SaasFounderReservationReceipt` |
| `POST /v1/hq/saas/founder-reservations/:id/release` | Owner | `saas-founder-release` | `{expectedVersion, reasonCode}` → receipt |
| `GET /v1/hq/saas/subscriptions[?status=]` | Owner or operator | — | `SaasSubscriptionList` (newest 200) |
| `POST /v1/hq/saas/subscriptions` | Owner | `saas-subscription-record` | `SaasSubscriptionRecordInput` → `SaasSubscriptionReceipt` |
| `POST /v1/hq/saas/subscriptions/:id/commands` | Owner | `saas-subscription-command` | `SaasSubscriptionCommand` → `SaasSubscriptionCommandReceipt` |
| `GET /v1/hq/saas/organizations/:organizationId/subscription` | Owner or operator | — | `SaasOrganizationSubscription`: entitlement, current record, `alignment`, history, founder reservations |

`SAAS_OWNER_APPROVED_DRAFT` holds the owner-approved plan intent as a starting draft:
- Core: $149, founder $79, lifetime $1,896, 5,000 credits.
- Complete: $249, founder $149, lifetime $3,576, 12,000 credits.
- Founder inventory: 50 total, 20 lifetime, 30 monthly.

Eligibility, hold length, window and terms stay undecided until HQ sets them.

**Errors:**

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_SAAS_INPUT` |
| 403 | `SAAS_FORBIDDEN`, `HUMAN_UI_REQUIRED` |
| 404 | `SAAS_UNAVAILABLE` |
| 409 | `SAAS_VERSION_CONFLICT`, `SAAS_TRANSITION_NOT_ALLOWED`, `SAAS_CATALOG_NOT_DRAFT`, `IDEMPOTENCY_KEY_REUSED`, `SAAS_OUTCOME_UNKNOWN` (retry with the same key) |
| 422 | `SAAS_POLICY_UNDECIDED`, `SAAS_CATALOG_UNDECIDED`, `SAAS_FOUNDER_LIMIT_BELOW_USAGE`, `SAAS_OFFER_NOT_AVAILABLE`, `SAAS_OFFER_NOT_FOUNDER`, `SAAS_FOUNDER_WINDOW_CLOSED`, `SAAS_FOUNDER_NOT_ELIGIBLE`, `SAAS_FOUNDER_ALREADY_RESERVED`, `SAAS_FOUNDER_SOLD_OUT`, `SAAS_ENTITLEMENT_NOT_ACTIVE`, `SAAS_ENTITLEMENT_MISMATCH`, `SAAS_SUBSCRIPTION_EXISTS`, `SAAS_FOUNDER_RESERVATION_REQUIRED`, `SAAS_FOUNDER_RESERVATION_MISMATCH`, `SAAS_FOUNDER_RESERVATION_EXPIRED`, `SAAS_NO_BILLING_PERIODS`, `SAAS_PERIOD_NOT_ENDED` |

**UI rule:**
- Never present a record as paid, charged, invoiced or credited.
- Show `paymentStatus: NOT_BILLED` and `premiumCredits.status: NOT_GRANTED` as they are.
- `IN_SERVICE` means "service period recorded", not "paid".

## 4. Not implemented in B1 (planned)

- **HON invoices and payment evidence:** B2.
- **AI credit allowances, reservations and balances:** B3.
- **Refund guarantee and Champions fulfillment:** B4.
- **Payment provider in test mode:** B5.
- **Not built in any milestone yet:**
  - school-facing plan or subscription view
  - public pricing or checkout
  - automatic period rollover (there is no scheduler; HQ advances periods explicitly)
  - automatic entitlement changes from subscriptions

## 5. Proposed next milestones (for owner approval)

**B2 — HON invoices and payment-evidence accounting (recordkeeping, no provider).**
- `saas_invoices`: one per subscription period or lifetime purchase. Fields: lines (plan fee, and later credits applied), totals, and a status of `DRAFT`, `ISSUED`, `VOID` or `PAID_EVIDENCED`.
- `saas_payment_evidence`: an append-only ledger of `RECEIVED`, `REFUNDED` and `CHARGEBACK` entries with source `HQ_OWNER_ATTESTATION` (B2) or `PROVIDER` (B5). It is idempotent, audited and has an inert outbox.
- It derives `paid_through_at` and first-paid date, which lifts the B1 pins in a reviewed migration.
- It becomes Champions Club's `HON_BILLING` payment-verification source: first paid date, paid invoice count, refunds and chargebacks.
- Owner decisions needed first:
  - invoice numbering and format
  - taxes, or an explicit pre-tax-only rule
  - whether lifetime is one invoice
  - who may attest payment

**B3 — premium AI credit allowance and reservation accounting.**
- Monthly allowance entries per subscription period, at the plan's planned credits. Lifetime and founder get the full allowance; Champions free months follow policy.
- Accounting only: reserve, then finalize, then release on provider failure, with no double charge on idempotent retry. It links to `ai_usage_ledger` for approved premium operations only.
- Ordinary operations and the ordinary assistant never draw from it.
- 75%, 90% and 100% threshold states.
- Top-up records priced at 2× the verified provider cost, without automatic overage or charges.
- Owner decisions needed first:
  - rollover
  - which operations count as premium
  - the provider-cost source of truth
  - the top-up approval flow
