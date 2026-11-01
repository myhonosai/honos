# HON OS new-school onboarding (D7)

**Status:** this is migration `0183`. It is not deployed and has not been applied to any persistent database.

- **Paid access stays INACTIVE.** The `0170` CHECK pins it, so nothing here changes a real school until a separately reviewed activation migration.
- **Test mode only**, with no real Stripe call.
- **Reserved numbers:** `0179` (E1b-2) and `0180` (E1c) stay reserved.
- **Owner decision D7 (2026-10-23):** a brand-new school must be able to buy HON OS without already having an active paid Complete entitlement. This milestone implements that.

## What a new school can now do

1. **Register.** The school is created awaiting its first payment, with no access.
2. **See its offers.** It reads the published HON OS offers, and the server decides `ELIGIBLE` for it.
3. **Buy one offer** in test mode. Every 0182 rule still applies.
4. **Get activated.** The verified payment activates HON OS (`COMPLETE`, `ACTIVE`) in the same transaction that records the payment.

This works for all six offer kinds: regular monthly, regular annual (auto-renewing or prepaid), founder monthly, founder annual, lifetime and founder lifetime.

## Registration (private)

`hon.initialize_saas_hon_os_school_account(ownerSubject, input, key, requestId, correlationId)` is the billing-side step of the B6 plan (§2.1).

**Who can call it.** No runtime role can execute it. The public sign-up must call it through a separately reviewed path after it has verified the identity and recorded terms acceptance. That path is Manus's sign-up side and does not exist yet.

**Input.** Exactly these keys: `legalName`, `displayName`, `schoolName`, `schoolSlug` and `timezone`.
- Text values are trimmed strings of 1–120 characters.
- The slug is lowercase `a-z0-9` with single hyphens, at most 63 characters.
- The time zone must be a real IANA zone.

**Refusals.**
- The subject must map to exactly one active human principal (`SAAS_FORBIDDEN`).
- The identity must not already hold any school, HQ or family access (`SAAS_OWNER_NOT_ELIGIBLE`).
- Paid access must be ACTIVE (`SAAS_ACCESS_NOT_ACTIVE`).

**Concurrency.** Registration is idempotent per key (`saas_claim_request`). A per-identity lock means concurrent requests with different keys still create exactly one school.

**What it creates, in one transaction:**
- the organization;
- the entitlement, `COMPLETE` but **`SUSPENDED`** (every status-gated function refuses it);
- the school;
- the system `OWNER` role with every permission (the same as HQ provisioning `0019`/`0022`) and the owner's grant;
- the access state `AWAITING_FIRST_PAYMENT` and an `APPLIED` transition with reason `NEW_SCHOOL_REGISTERED`;
- `saas.access.initialize` audit and outbox rows.

**Before payment, the school can:**
- read its billing account (`access.state = AWAITING_FIRST_PAYMENT`);
- read the HON OS offers;
- start a checkout.

It has no capabilities, and the staff scope resolvers refuse it.

## Checkout

`POST /v1/schools/:schoolId/hon-os-offers/checkout` (unchanged) now also accepts an organization **awaiting its first payment while paid access is ACTIVE**. For that organization the entitlement-active and tier checks are skipped.

Everything else from 0182 still applies:
- the offer is published and on sale, with supported terms;
- no live subscription and no open checkout;
- `NEW_ORGANIZATIONS_ONLY` eligibility;
- the sale limit and the single founder pool are counted under one lock with the hold the checkout creates;
- the browser sends only `offerId`.

While paid access is INACTIVE, an awaiting school is an ordinary suspended school. It is refused with `SAAS_ENTITLEMENT_NOT_ACTIVE`, and its offers show `NOT_ELIGIBLE_ENTITLEMENT`.

## Activation

The signature-verified completion event (or `async_payment_succeeded`) runs every 0182 check, which are unchanged:
- expiry, including an unswept expiry;
- amount and currency;
- recurring shape;
- subscription exists;
- explicit stop-sales (D6);
- sale limit;
- founder pool, against the checkout's own set limit.

Then:

- **Organization awaiting payment, paid access ACTIVE.** The subscription is recorded at the accepted offer (snapshot and digest) with tier `COMPLETE`. The B6A first-payment step then runs in the same transaction:
  - the entitlement becomes `COMPLETE`, `ACTIVE`, starting at the payment;
  - the access state becomes `PAYMENT_ACTIVE`;
  - an `APPLIED` transition is recorded.

  The webhook reports `ACCESS_ACTIVATED`. If that step fails, the payment stays recorded and the activation rolls back to a savepoint as `NEEDS_REVIEW` (`ACCESS_ACTIVATION_NEEDS_REVIEW`). There is never a partial grant.
- **Organization awaiting payment, paid access INACTIVE.** The checkout is held as `PAID_NEEDS_REVIEW` with reason `ACCESS_PROGRAM_INACTIVE`. No subscription is created, and the hold no longer reserves inventory.
- **Any other mismatch.** `PAID_NEEDS_REVIEW` with the reason, also recorded as a `NEEDS_REVIEW` access transition.
- **Organizations not awaiting payment** (provisioned schools) follow the 0182 path exactly. Their entitlement never changes and the webhook reports `SUBSCRIPTION_ACTIVATED`.

`saas_apply_first_payment_access` now also checks the HON OS offer ID and the accepted-offer digest against the checkout. It compares nullable columns with `IS DISTINCT FROM`.

## HQ retry

`POST /v1/hq/saas/payments/checkouts/:checkoutId/access-retry` (HQ owner only, unchanged contract) now also retries a HON OS checkout held with `ACCESS_PROGRAM_INACTIVE`.

**Inputs.** It replays the original verified event; the caller supplies nothing.

**Rechecks at the retry:**
- expiry, against the original payment time;
- stop-sales;
- the **sale limit** (`SALE_LIMIT_REACHED`) and the **founder pool** (`FOUNDER_UNAVAILABLE`), as of the retry;
- refund or dispute (`SAAS_ACCESS_PAYMENT_REVERSED`).

A held payment never oversells. If someone else took the slot, the retry stays `NEEDS_REVIEW` for HQ to refund.

## AI credits

**No allowance is opened at HON OS activation, even when the credit program is active.**
- Credits stay planning-only (`premiumCredits.status = NOT_GRANTED`). The school billing view shows `NOT_YET_OPENED`.
- Lifetime credits are not approved, so nothing is granted for them.
- Legacy Core/Complete first-payment activation is unchanged.
- **Open risk:** once the credit program is activated, the existing usage path (`saas_current_allowance`) would open HON OS allowances on demand per D5, including lifetime offers. Before that program is activated, a credit-policy decision must confirm this or block lifetime.

## Security boundary

- **Private functions.** Registration and `saas_activate_hon_os_checkout_core` are not runtime-executable. The grants reconciliation (`infra/postgres/010`) and the security registry (`saas-billing-security.mjs`) are updated.
- **Never authority:** a browser price, kind, organization or school; a success URL; an entitlement claim; or the selected school. Activation reads only the checkout's frozen accepted offer and the provider-verified event.
- **Tenant isolation.** One school's owner cannot read or buy for another school. HQ, support and staff without `billing.hon.purchase` are refused.
- **Lock order.** The HON OS inventory lock, then the checkout, then the organization, the same as 0182. The retry takes the inventory lock of the checkout's own path.

## For Codex (frontend)

There is no new route or contract shape.
- **Awaiting school:** show the HON OS offers from the existing read. Use `access.state = AWAITING_FIRST_PAYMENT` and `access.activation = UNAVAILABLE` from the billing account read to explain that nothing is unlocked until payment.
- **After payment:** `access.state = PAYMENT_ACTIVE`.
- **Never** unlock anything from a success URL.

## Evidence

- **New proof:** `packages/database/scripts/test-saas-hon-os-new-school-onboarding.mjs` (disposable database, simulated Stripe, paid access ACTIVE simulated and restored). It covers every rule above, including:
  - registration refusals, idempotency and a concurrent same-identity race;
  - every offer kind activating once;
  - five concurrent duplicate deliveries and an out-of-order first invoice;
  - a failed async payment, then a successful one;
  - a cancelled checkout paid late, then a rebuy;
  - an expired checkout paid late;
  - five concurrent checkout attempts by one school;
  - three payments held while inactive: one retried to activation, one `SALE_LIMIT_REACHED`, one `FOUNDER_UNAVAILABLE`;
  - a refund blocking a retry;
  - a provisioned school buying through the 0182 path unchanged;
  - no AI allowance with the credit program active.
- **0182 proof** gains two cases:
  - a version-1 founder hold honored after version 3 lowers the founder cap below the allocated count;
  - `ENTITLEMENT_CHANGED` when HQ moves a school from Complete to Core (the real 0146 transition) between checkout and payment.
- The B6A, 0181, 0182, entitlement-coverage and billing-security proofs pass with 0183 applied.

## Not in this change, and launch dependencies

1. **Public sign-up (Manus).** Identity verification, terms acceptance record and the reviewed path that calls the initializer. Until then, no real school can register itself.
2. **Paid-access activation.** A reviewed migration to flip `saas_access_program` to ACTIVE, after the owner approves B6 D1, D2 and D12 and runs in the real Stripe sandbox.
3. **D8.** Done in `0184` ([HON_OS_ONLY_NEW_SALES.md](HON_OS_ONLY_NEW_SALES.md)): legacy Core/Complete new sales are closed for every new customer, so an awaiting school sees and can buy only HON OS.
4. **Policy and refunds.** The credit policy for HON OS (see AI credits), refunds of held payments, B6B (grace, suspension, cancellation, refund and dispute effects) and live mode.
