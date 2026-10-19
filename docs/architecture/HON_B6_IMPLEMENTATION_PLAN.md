# HON OS B6: payment-controlled access — implementation plan

**Status: PLAN, nothing implemented.** It builds on main `387c800` (B1–B5.1 merged). Paid access stays **off** until the owner approves the policy and a reviewed migration flips `saas_access_program` (today INACTIVE by CHECK).

Target journey: new school registration → Core or Complete selection → verified subscription payment → account activation → the plan's features and monthly AI allowance.

## 1. What the plan can rely on today

| Approved by the owner and already enforced in code | Where |
|---|---|
| Core $149 / 5,000 credits; Complete $249 / 12,000 credits | B1 catalog (`SAAS_OWNER_APPROVED_DRAFT`) |
| Founder $79/$149 monthly; paid lifetime $1,896/$3,576; 30 monthly + 20 lifetime; atomic inventory | B1 founder program |
| Paid lifetime and earned free months keep the **full** monthly allowance | B3 allowance basis, B4 free periods |
| 30-day, 100% first-purchase refund guarantee (records only; execution unavailable) | B4 |
| Stripe as provider, **test mode only** | `PAYMENT_PROVIDER` v4 DECIDED (0170) |
| Verified payment evidence, derived payment status, school billing reads, HQ dry run | B5, B5.1 |
| Essential stays legacy only; no annual plans | B1 |

Nothing about **access** (D1–D15 in [the B6 proposal](HON_PAID_ACCESS_B6_PROPOSAL.md)) is approved yet. The recommended terms are recorded as `saas_access_policy_terms` v1, PROPOSED.

## 2. B6a: first-payment activation (the paid-launch path)

**Needs owner approval of D1 (activate on verified payment), D2 (no access before first payment) and D12 (HQ-owner exceptions).**

### 2.1 New-school registration (with Manus)

**Ownership:**
- **Manus** owns the public sign-up and CRM: verified owner identity, school profile, terms acceptance.
- **Claude** owns the billing-side initialization function that sign-up calls once the identity is verified.

**What `initialize_school_account` does** (new, private), in one transaction:
- creates the organization, school and system OWNER role (all permissions, including `billing.hon.view`, `billing.hon.purchase` and `settings.language.manage`) and the owner's grant;
- creates the `organization_entitlements` row with `status = 'SUSPENDED'` and tier `CORE` as a placeholder. Every one of the 136 status-gated functions in the [inventory](HON_ENTITLEMENT_ENFORCEMENT_INVENTORY.md) already refuses a suspended entitlement;
- creates an access state `AWAITING_FIRST_PAYMENT` that records the fact.

It reuses the 0019/0022 provisioning pattern. There is no new entitlement status; the `hon.membership_status` enum stays as it is.

**Payment-free surfaces while awaiting payment:**
- B5.1 billing reads and the B5 plan and checkout routes;
- language and settings.

The B5 purchaser identity check does not require an active entitlement, and the B5.1 reads deliberately allow a lapsed entitlement. B5 checkout's entitlement checks (active status, matching tier) are what §2.2 relaxes, and only for awaiting schools.

### 2.2 Plan choice at checkout

- B5 limits checkout to the provisioned tier (`SAAS_ENTITLEMENT_MISMATCH`).
- B6a relaxes this **only while the organization is `AWAITING_FIRST_PAYMENT`**: any published Core or Complete offer is allowed.
- The checkout already freezes plan, offer, catalog version, amount, founder reservation, purchaser and school.

### 2.3 Activation (the transition authority)

`saas_activate_checkout` (B5) gains one step, run in the **same transaction** that records the subscription, invoice and provider-verified evidence:
- **When** the access program is ACTIVE **and** the organization is `AWAITING_FIRST_PAYMENT` **and** the checkout plan is Core or Complete:
  - the existing entitlement row moves to the purchased tier, `status = 'ACTIVE'`, `effective_from` = payment time, `version + 1`;
  - this follows the 0146 pattern: version-checked update, `hq_entitlement_audit`-style evidence, internal-only outbox;
  - the access state becomes `ACTIVE` with reason `FIRST_PAYMENT`.
- **When** the program is INACTIVE (today): nothing changes, and the school shows `PENDING_ACCOUNT_ACTIVATION` (B5.1).
- **Any mismatch** (state changed, plan unavailable) records `PAID_NEEDS_REVIEW` for HQ, never a partial grant.
- The B3 allowance for period 0 opens at the plan amount (5,000 or 12,000) in the same transaction, so credits are ready immediately.

### 2.4 HQ exceptions (D12)

- HQ-owner-only, with a reason, an expiry of at most 90 days, a version check and audit.
- Uses the same transition function; operators and support cannot grant one.

### 2.5 Central gate and behavioural coverage proof

- **Read:** a central `hon.organization_access_allows(org, capability)` read over the entitlement and the access state.
- **Coverage proof:** call every runtime-callable school function listed in the inventory with an otherwise-valid fixture while the entitlement is SUSPENDED, and assert refusal.
  - Billing reads, plan, checkout, language and family portals are explicitly allowed.
  - The 3 `TIER_ONLY` and 53 `UNGATED` functions each get a decision: gate, or allow with a reason.
- This proof is **policy-independent** and can be built before any approval.

### 2.6 Migrations and tests

- One migration, numbered after whatever is on main and on Manus's branch at the time.
- The program flip is its own migration, after the owner approves.
- Proofs to run:
  - registration to an awaiting school;
  - checkout for the chosen plan;
  - verified payment to an ACTIVE entitlement with the correct tier and allowance;
  - inactive program means no change;
  - mismatch goes to review;
  - an exception and its expiry;
  - the coverage proof;
  - tenant isolation;
  - founder inventory contention;
  - idempotent redelivery.

## 3. B6b: after the remaining decisions

Built on the same transition function:
- past-due grace, restriction (premium AI paused) and suspension;
- reactivation on payment;
- cancellation at period end;
- refund and dispute effects;
- founder-price loss rule;
- lifetime protection.

Each is a single transition with evidence, driven by the B5 verified events and the B2 payment status.

## 4. Owner decisions still open

| Needed for | Decision | Recommendation (recorded as PROPOSED terms v1) |
|---|---|---|
| **B6a** | D1 First-payment activation | Immediate on verified payment |
| **B6a** | D2 New-school access before payment | None (plan, checkout, billing and settings only); no trial |
| **B6a** | D12 Exceptions | HQ owner only, at most 90 days, reason required |
| **B6a** | Self-serve registration terms | Final customer terms and the acceptance record (with Manus) |
| B6b | D3 Grace | 7 days of full access |
| B6b | D4 Restriction and suspension | Premium AI paused from day 8; staff read-only plus billing from day 22; family features continue; no data deletion |
| B6b | D5 Reactivation | Immediate on verified payment; no back-filled credits |
| B6b | D6 Cancellation | End of the paid period; no proration |
| B6b | D7 Refund (30-day guarantee) | Access ends at the verified refund; founder slot not returned |
| B6b | D8 Dispute | Suspend pending HQ review; restore if the dispute is won |
| B6b | D9 Founder price | Kept while continuously paid (grace included) |
| B6b | D10 Paid lifetime | Never past due; ends only on refund or a lost dispute; not transferable |
| B6b | D11 Earned free months / Champions lifetime | Count as paid periods once reward fulfillment is activated |
| Later | D13 Plan changes, D14 Dunning messages, D15 Taxes | Unavailable; Stripe receipts only; taxes required before live mode |

## 5. Next step without any approval

Build the coverage proof (§2.5) and the `initialize_school_account` design review with Manus. Both are policy-independent and leave access unchanged.
