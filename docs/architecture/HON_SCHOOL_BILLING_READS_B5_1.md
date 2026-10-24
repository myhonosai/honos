# HON Subscription Billing B5.1: school billing reads and the inactive paid-access foundation

**Status:** implemented on `claude/hon-billing-b5-1` (migration `0170`). The work is **read-only**: no route here writes anything, and no entitlement is ever changed. Payment data in the proofs comes from the deterministic Stripe simulator (`STRIPE_SIMULATED`) and from B2 HQ attestation. **No real Stripe sandbox** has been used.

## 1. What a school can read

**Who can read:** staff holding the new **`billing.hon.view`** permission at the exact school.
- The permission is granted to every system OWNER role; new HQ-provisioned owners get it automatically.
- Identity rules match the B5 purchaser: one active principal, an eligible staff member, and no family or platform role.
- HQ financial permissions never apply. HQ, support, family and other-organization identities get `403 SAAS_FORBIDDEN`.
- The read **does not require an active entitlement**, so a school whose access lapsed can still see its billing.

**Scope:** billing is organization-level. Every authorized school of a multi-school organization sees the same records, and `schoolCount` reports how many active schools the organization has.

**Never visible to schools:**
- draft invoices;
- HQ evidence notes and receipt references;
- refund customer references and notes;
- the internal tax verification reference;
- actors and versions;
- any other organization's data;
- school-to-family membership billing.

| Route (all `GET`, `Cache-Control: private, no-store`, no body) | Contract (`@hon/contracts`) |
|---|---|
| `/v1/schools/:schoolId/hon-billing` | `SaasSchoolBillingAccount` · `validateSaasSchoolBillingAccount` |
| `/v1/schools/:schoolId/hon-billing/invoices?status=&kind=&cursor=&limit=` | `SaasSchoolInvoicePage` · `validateSaasSchoolInvoicePage`; query via `validateSaasSchoolInvoiceQuery` |
| `/v1/schools/:schoolId/hon-billing/invoices/:invoiceId` | `SaasSchoolInvoiceDetail` · `validateSaasSchoolInvoiceDetail` |
| `/v1/hq/saas/access/:organizationId` (HQ owner/operator) | `SaasAccessReadiness` · `validateSaasAccessReadiness` |

### Invoice list

**Ordering:** newest issued first. The page key is the issue time to the millisecond plus the invoice id. Both are immutable, so walking `nextCursor` returns every issued or void invoice exactly once, even while new invoices are issued.

**Filters and paging:**
- `status`: `ISSUED` or `VOID`.
- `kind`: `SUBSCRIPTION_PERIOD` or `LIFETIME_PURCHASE`.
- `limit`: 1–100, default 25.
- `cursor`: `encodeSaasSchoolInvoiceCursor(page.nextCursor)`.

Any other query key, or any invalid value, is `400`.

### Invoice detail

The detail adds:
- **Lines:** plan fee, discount, correction, account credit (negative) and tax.
- **Settlement:** received, refunded and charged-back amounts; net; verified net; balance; state.
- **Payment evidence:** `source` is `PROVIDER_VERIFIED` or `HQ_ATTESTATION`, with `providerVerified` and `providerMode: 'TEST'`.
- **B4 refund records** for that invoice, with `execution: 'UNAVAILABLE'`.

`paymentVerification` summarizes the evidence:
- `PROVIDER_VERIFIED`: provider-verified evidence covers the total.
- `HQ_RECORDED`: an HQ attestation covers it.
- `NONE` otherwise.

An HQ-recorded payment is never presented as provider-verified; the contract rejects that combination.

**Errors:** a missing invoice, another organization's invoice and a draft are all `404 SAAS_UNAVAILABLE`, indistinguishable from each other.

### Account (access and allowance readiness)

The account read comes only from canonical records. It introduces no new source of truth.

- **`entitlement`:** the `organization_entitlements` row (`tier`, `status`, effective window, `version`, `inEffect`). It is the only access authority.
- **`access`:**
  - `source: 'PROVISIONED'` and `paymentActivated: false`: both stay fixed until B6 is approved.
  - `paidAccessProgram: 'INACTIVE'`.
  - `alignment`: `ALIGNED`, `NO_SUBSCRIPTION`, `PLAN_MISMATCH` or `SUBSCRIPTION_NOT_IN_SERVICE`.
  - `activation`:
    - `READY`: the entitlement is in effect and matches the subscription, or there is no subscription.
    - `PENDING_ACCOUNT_ACTIVATION`: a paid subscription whose entitlement is not in effect or does not match.
    - `UNAVAILABLE` otherwise.

    A payment alone never yields `READY`, and the contract enforces this.
- **`subscription`, `subscriptionHistory`, `subscriptions`:** the B1 record, its version history, and historical plan terms (catalog version, offer, price).
- **`payment`:** the derived B1 payment status (`PAID`, `DUE`, `PAST_DUE`, `REFUNDED`, `DISPUTED` or `NOT_BILLED`), its verification strength, `paidThroughAt` and `unpaidSince`. It also carries B2 standing (verified versus recorded facts, evidence counts, `providerVerification`).
- **`allowance`:** the B3 ledger for the current period.
  - Fields: `grantedCredits`, `consumedCredits`, `reservedCredits`, `remainingCredits`, `usedPercent`, `basis`, and the plan's `plannedMonthlyCredits`.
  - `state` is one of: `AVAILABLE`, `EXHAUSTED`, `NOT_YET_OPENED`, `PERIOD_CLOSED`, `PROGRAM_INACTIVE`, `SUSPENDED`, `SUBSCRIPTION_NOT_IN_SERVICE`, `NO_SUBSCRIPTION` or `ACCESS_NOT_ACTIVE`.
  - `suspensionPolicy: 'UNDECIDED'`.
- **`refunds`:** the organization's B4 refund requests (school projection).

## 2. B6 foundation (inert)

| Piece | What it is | Why it cannot act |
|---|---|---|
| `saas_access_program` | Singleton program record | `CHECK (status = 'INACTIVE')` and `CHECK (mutations_enabled = false)`; the table is immutable. Activation needs a reviewed migration after owner approval |
| `saas_access_policy_terms` v1 | The recommended terms as a versioned contract: 7-day grace, restrict after 7 days, suspend after 21, the rest as in the B6 proposal | `CHECK (status = 'PROPOSED')`; immutable |
| Policy `PAID_ACCESS` | Decision `UNDECIDED`; record v2 `PROPOSED` (`HON_RECOMMENDED_TERMS_V1`) | `actions_enabled` is false by constraint |
| Policy `PAYMENT_PROVIDER` v4 | `DECIDED`, `STRIPE_TEST_MODE_ONLY` (the owner's 2026-10-19 approval) | Live mode is still impossible by constraint |
| `saas_access_condition(org)` | Observed billing condition from B1, B2 and B5 records | Private, `STABLE` |
| `read_saas_access_readiness_from_hq` | HQ **dry run**: the state the proposed terms would assign (`ACTIVE`, `AWAITING_FIRST_PAYMENT`, `PAST_DUE_GRACE`, `RESTRICTED`, `SUSPENDED`, `ENDED` or `NO_ACCESS`), with the reason and days unpaid | `enforcement: 'NONE'`; nothing reads it to enforce |
| `report-entitlement-enforcement.mjs` | Generates [HON_ENTITLEMENT_ENFORCEMENT_INVENTORY.md](HON_ENTITLEMENT_ENFORCEMENT_INVENTORY.md): every runtime-callable function classified as `STATUS_GATED`, `TIER_ONLY`, `UNGATED`, `HQ_SCOPE` or `PROVIDER_SCOPE` | Read-only catalog analysis |

**The eventual B6 transition authority** (not built) will reuse the existing entitlement row and the 0146 pattern:
- versioned update;
- HQ-style evidence;
- outbox with `internalOnly`.

It will run inside verified-event application, in the same transaction as the payment record. No second access system is planned.

## 3. Evidence

`test-saas-school-billing-integrity.mjs` is registered in CI. It runs against a disposable PostgreSQL 16 database through the real API services and proves:
- **Authorization:** every refusal listed in §1, plus a revoked grant and a role named like a family or platform identity.
- **Multi-school:** two schools of one organization see the same records.
- **Pagination:** a complete walk with a new invoice issued mid-walk, and two invoices sharing an issue millisecond.
- **Visibility:** drafts, notes and references stay hidden.
- **Payment strength:** provider-verified versus HQ-recorded payments; refund and chargeback records.
- **Readiness:** `READY` for a paid, aligned school; `PENDING_ACCOUNT_ACTIVATION` for a paid school whose entitlement HQ suspended (the billing read still works).
- **Allowance:** equals the B3 school credits read.
- **Dry run:** `ACTIVE`, `RESTRICTED` and later `SUSPENDED` for an unpaid renewal, `ENDED` for a refunded lifetime, and `SUSPENDED` for a dispute.
- **Inert program:** the access program and terms cannot be changed even with guards disabled.
- **No writes:** the reads write nothing to requests, audit, outbox, allowances, ledger, invoices, evidence, events, checkouts or refunds. Entitlements and school-to-family billing are unchanged.

## 4. Not in B5.1

- payment-driven access changes;
- self-serve registration;
- plan changes;
- live mode;
- refund execution;
- taxes;
- customer notifications.

These are in [HON_PAID_ACCESS_B6_PROPOSAL.md](HON_PAID_ACCESS_B6_PROPOSAL.md) (owner decisions D1–D15).
