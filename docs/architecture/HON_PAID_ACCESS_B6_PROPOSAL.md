# HON OS B6 proposal: paid access (payment → entitlement)

**Status: PROPOSAL for owner review.**
- Nothing here is implemented or authorized.
- Payment does not change school access today, and B6 must not change that silently.
- Every row marked **OWNER DECISION** blocks the part of the implementation that depends on it.

This document also answers the backend contract requested in issue #29, Gate 2.

## 1. Where things stand

| Capability | Today (B1–B5) |
|---|---|
| School access | `hon.organization_entitlements`: tier ESSENTIAL/CORE/COMPLETE; status ACTIVE/SUSPENDED/ARCHIVED; effective window. Set only by HQ provisioning (`HqOnboardingService`) and the HQ CORE↔COMPLETE transition (0146) |
| Enforcement | About **55 feature migrations** each embed their own check (`status = 'ACTIVE'` and the effective window). There is **no single central access gate**, and no proof that every school-facing function honours SUSPENDED |
| Purchase | B5 hosted test-mode checkout, **only for the school's already-provisioned tier**. The offer, catalog version, amount, founder reservation, organization, school and purchaser are frozen on the checkout |
| Payment truth | Signature-verified or API-recovered Stripe events produce B2 invoices and `PROVIDER_VERIFIED` evidence. B1 `paymentStatus` is derived (`PAID`/`DUE`/`PAST_DUE`/`REFUNDED`/`DISPUTED`) |
| AI allowance | B3 monthly allowance per subscription period (Core 5,000, Complete 12,000; lifetime and earned free months get the full amount). It is not gated by payment status |
| New school | No self-serve registration. HQ provisions the organization, school, OWNER role and tier |

**The gap:** a newly registered owner cannot choose a plan and receive the matching access from a verified payment. A past-due, refunded or disputed school also keeps full access until HQ acts.

## 2. Proposed model

- **Policy gate:** add a `PAID_ACCESS` policy record and an HQ-owner switch `saas_access_program`, created INACTIVE (the same pattern as the credit program and reward fulfillment). While it is INACTIVE, behaviour is exactly as today.
- **One server authority:** `hon.saas_apply_access_transition` is the only function that changes an entitlement because of billing.
  - It is private, `SECURITY DEFINER`, versioned and idempotent.
  - It writes the B1–B3-style audit and outbox and the 0146-style entitlement evidence.
  - It is called only from inside verified-event application, or from an HQ-owner command, never from a browser.
- **Access state:** `hon.saas_access_states` holds one row per organization with these states:
  - `AWAITING_FIRST_PAYMENT`
  - `ACTIVE`
  - `PAST_DUE_GRACE`
  - `RESTRICTED` (premium AI suspended)
  - `SUSPENDED`
  - `CANCELLED_PENDING_END`
  - `ENDED`
  - `EXCEPTION`

  Each row records a reason, `since`, the evidence id and a version. The entitlement row is updated from this state in the same transaction.
- **Central enforcement:** a central `hon.organization_access_allows(org, capability)` read, and a **coverage proof** that enumerates every runtime-callable school function and shows that each denies under SUSPENDED (and premium AI under RESTRICTED). The ~55 feature checks are not rewritten one by one in a single risky step; the proof is the safety net.
- **Unchanged:** Essential legacy subscribers, existing provisioned schools (they start in `ACTIVE` with reason `PROVISIONED`), school-to-family billing, CRM data and Champions rewards.

## 3. Policy decisions needed

| # | Topic | Recommendation | OWNER DECISION needed |
|---|---|---|---|
| D1 | **First-payment activation** | Grant the purchased tier **immediately** on verified payment (`checkout.session.completed` with `paid`, or `async_payment_succeeded`), effective at the payment time. A success URL is never evidence | Approve |
| D2 | **New-school plan choice** | A new school is created `AWAITING_FIRST_PAYMENT` with **no feature access** except plan selection, checkout and account settings. Its chosen Core or Complete offer becomes its tier on D1 | Approve; also decide whether a new school gets any trial access (recommend none) |
| D3 | **Past-due grace** | `invoice.payment_failed` → `PAST_DUE_GRACE` with **full access for 7 days**. Stripe retries per its Smart Retries settings | Grace length |
| D4 | **Restriction, then suspension** | Day 8: `RESTRICTED`; premium AI credits suspended (`SUSPENDED_ALLOWANCE`); CRM, classes and family-facing features keep working. Day 22: `SUSPENDED`; staff get read-only access plus billing; family-facing features keep working; **no data is deleted** | The day counts, what stays available when suspended, and whether family portals continue |
| D5 | **Reactivation** | A verified payment of the outstanding invoice restores `ACTIVE` immediately and automatically. The allowance resumes for the current period without back-filling suspended days | Approve; decide the back-fill rule |
| D6 | **Cancellation timing** | A school cancels at **period end**, keeps access through the paid period, then `ENDED`. No proration and no partial refund outside the 30-day guarantee | Approve (CANCELLATION_TIMING, PRORATION) |
| D7 | **30-day refund guarantee** | A provider-verified full first-purchase refund ends paid access at the refund time (`ENDED`, reason `REFUNDED`), and any founder slot is **not** returned to inventory | Access on refund; founder-slot return (FOUNDER_SLOT_RETURN) |
| D8 | **Chargeback** | `charge.dispute.created` puts the school straight into `SUSPENDED` pending HQ review. Winning the dispute restores the prior state | Approve |
| D9 | **Founder monthly protection** | The founder price holds while the subscription is continuously paid, including inside the grace window. Losing it requires `ENDED` (cancel, refund, or suspension past N days) | The founder-price loss rule |
| D10 | **Paid lifetime** | Never past-due (no renewals). Ended only by a refund or a lost chargeback. Full monthly allowance for life of the account | Approve; lifetime transferability (recommend: not transferable) |
| D11 | **Earned free months and Champions lifetime** | Count as paid periods for access, the same as D10 or D5. Fulfillment stays disabled until activated | Confirm once rewards are activated |
| D12 | **Administrative exceptions** | An HQ-owner-only `EXCEPTION` state (comp access, extended grace) requires a reason, an expiry ≤ 90 days, a version check and audit. Operators and support cannot grant it | Who may grant; maximum length |
| D13 | **Plan changes** | Core↔Complete self-serve changes stay **UNAVAILABLE** in B6. HQ's existing non-commercial transition remains | Separate decision (PLAN_CHANGE_TIMING, PRORATION) |
| D14 | **Notifications** | Stripe's own test-mode receipts and emails only. HON-sent dunning messages are a separate approval | Approve |
| D15 | **Taxes** | No live charge until TAXES is decided (Stripe Tax or recorded treatment) | Required before live mode |

## 4. Answers to issue #29, Gate 2 (the backend contract)

1. **Verified purchaser context:**
   - B5's `require_saas_school_purchaser` already resolves the human from the verified identity subject (never a URL or form value). It requires `billing.hon.purchase` at the exact school, granted to that school's OWNER role, and refuses HQ, support and family identities.
   - For new schools, **self-serve registration** must be added. Proposed split: Manus owns the registration and CRM side; Claude owns the billing-side organization initialization. The registering identity becomes the OWNER of exactly one new organization and school.
   - Multi-school organizations purchase per organization, from any school where the purchaser holds the permission; billing is organization-scoped.
2. **Chosen plan versus current access:**
   - B5 checkout today is limited to the provisioned tier (`SAAS_ENTITLEMENT_MISMATCH` otherwise).
   - B6 allows any published Core or Complete offer **only while the organization is `AWAITING_FIRST_PAYMENT`**. The checkout already freezes the offer, catalog version, amount, currency, organization, school, purchaser and founder reservation, and the browser sends only `offerId`.
   - Plan changes for active schools stay unavailable (D13). Essential is never converted.
3. **Payment evidence:** delivered in B5.
   - Only signature-verified webhooks or API-recovered events count, with provider `STRIPE` (real sandbox) or `STRIPE_SIMULATED`.
   - Evidence `source` is `PROVIDER_VERIFIED` versus `HQ_ATTESTATION`, and the mode is `TEST`.
   - Pending, terminal and `PAID_NEEDS_REVIEW` checkout states exist. A success URL, session creation or unknown provider outcome is never payment.
4. **Paid-access policy:** §3, D1–D15. Nothing changes automatically until the owner approves the policy and the HQ owner activates `saas_access_program`.
5. **Server effect:** §2.
   - One private transition function, run inside verified-event application in the **same transaction** as the payment record.
   - It applies tenant binding, current policy revalidation, version checks, idempotency, audit and outbox.
   - A failed or mismatched grant becomes `PAID_NEEDS_REVIEW` for HQ, never a partial state.
6. **Readable outcome:** extend `GET /v1/schools/:schoolId/hon-plan` with:
   - `access: { state, effectiveTier, since, reason }`
   - `allowance: { periodStart, periodEnd, granted, consumed, reserved, remaining, suspended }`

   Payment status, subscription period, effective entitlement and allowance are reported separately and never inferred from one another.
7. **School invoices:** a new purchaser-authorized, organization-scoped, paginated `GET /v1/schools/:schoolId/hon-plan/invoices` plus a detail route. Each invoice shows its number, period, totals and settlement, with evidence `source` and provider/mode distinctions. There is no HQ fallback and no school-to-family billing mixing.
   - **This needs no policy decision**, so it can be built right after B5 merges, as part of B5.1.

## 5. Proposed sequencing

- **B5.1 (delivered in migration 0164; [details](HON_SCHOOL_BILLING_READS_B5_1.md)):**
  - `api_version` refusal in the normalizer (merged in #30);
  - school billing reads: invoices, detail, evidence, refunds, entitlement, activation, allowance (§4.6, §4.7);
  - `PAYMENT_PROVIDER` recorded as DECIDED (Stripe, test mode only).
  - Inert B6 foundation:
    - `saas_access_program` (INACTIVE by CHECK);
    - versioned `saas_access_policy_terms` v1 (PROPOSED by CHECK, carrying the D3, D4, D6–D10 and D12 recommendations);
    - `PAID_ACCESS` policy PROPOSED;
    - the HQ dry run `GET /v1/hq/saas/access/:organizationId` (enforcement NONE);
    - the generated [entitlement enforcement inventory](HON_ENTITLEMENT_ENFORCEMENT_INVENTORY.md).
  - Still to come: the real-sandbox harness (readiness doc §6), which waits on credentials.
- **B6a (after D1, D2, D12):**
  - self-serve new-school initialization (with Manus);
  - `AWAITING_FIRST_PAYMENT`;
  - first-payment activation through a private transition function that updates the existing `organization_entitlements` row (0146 pattern: version check, evidence, outbox);
  - exceptions;
  - the central gate and the behavioural coverage proof.

  The access program flips from INACTIVE only in a reviewed migration after the owner approves.
- **B6b (after D3–D11):** grace, restriction, suspension, reactivation, cancellation, refund and dispute transitions, founder and lifetime protection, allowance suspension.
- **Live mode:** a separate milestone after D15 and a real-sandbox evidence review.

## 6. Migration numbering

- #26 (B5) keeps **0158**.
- Manus's #27 (`0158_flexible_billing_accounts.sql`) must be renumbered to the next free number when it is synchronized with main after B5 merges, and its own proofs rerun.
- Claude's next migrations take the number after whichever lands first. Claude will not edit Manus's files.
