# HON OS purchase binding (migration 0182)

Status: **implemented in a reviewable PR, not merged, not deployed, not applied to any persistent database.** Proven only on a disposable database with the Stripe **simulator** (provider `STRIPE_SIMULATED`). No real Stripe sandbox call has been made, live mode stays impossible, B6 paid access is unchanged and INACTIVE, and no AI credits are granted.

Builds on [HON_OS_COMMERCIAL_OFFERS.md](HON_OS_COMMERCIAL_OFFERS.md) (0181). Migration numbering: 0179 stays reserved for E1b-2 and 0180 for E1c.

## What a school can now do

A school owner (staff with `billing.hon.purchase` at that exact school) can buy **one** HON OS offer from the **published** HQ offer set, in TEST MODE, by sending only the offer ID. The server freezes the exact offer (price, kind, renewal, price lock, refund window, cancellation timing, planned credits, fair-use and terms references, set version and approved preview digest) as the **accepted offer** on the checkout, with its SHA-256 digest, and copies it verbatim to the subscription. Later HQ edits, stops or new versions never change it.

| Offer kind | Provider session | HON record | Recurring obligation |
|---|---|---|---|
| `REGULAR_MONTHLY`, `FOUNDER_MONTHLY` | `mode=subscription`, recurring `month` | monthly periods anchored to the verified payment | yes, at the accepted price |
| `REGULAR_ANNUAL`, `FOUNDER_ANNUAL` with `AUTO_RENEW_AT_LOCKED_PRICE` | `mode=subscription`, recurring `year` | 12-month periods | yes, at the accepted price |
| Annual with `NO_AUTO_RENEWAL` | `mode=payment` | one 12-month paid term | **none** |
| `LIFETIME`, `FOUNDER_LIFETIME` | `mode=payment` | `LIFETIME_PURCHASE` invoice, no periods | **none** |
| Annual with `AUTO_RENEW_AT_CURRENT_PRICE` | refused (`SAAS_OFFER_TERMS_UNSUPPORTED`) | – | – |

Stripe line item and invoice label: `HON OS — <offer display name>`. Legacy Core/Complete checkouts keep their existing labels.

## Rules enforced by the database

Opening a checkout (one transaction, serialized by the `saas.hon_os.inventory` and per-organization advisory locks, and holding `SHARE` locks on offer sets and sales stops so publishing or stopping waits for it):

1. Payment program is `TEST_MODE` (`SAAS_PAYMENTS_NOT_ACTIVE`).
2. The offer belongs to the **published** set, is inside its sales window and not stopped (`SAAS_OFFER_NOT_AVAILABLE`). Draft, discarded, retired, future and unknown offers all get this code.
3. Terms are sellable (`SAAS_OFFER_TERMS_UNSUPPORTED`, decision D4).
4. Organization ACTIVE with an ACTIVE entitlement, not awaiting first payment (`SAAS_ENTITLEMENT_NOT_ACTIVE`), tier `COMPLETE` (`SAAS_ENTITLEMENT_MISMATCH`). A purchase never changes the entitlement.
5. No live subscription of any source (`SAAS_SUBSCRIPTION_EXISTS`; legacy subscribers cannot switch yet, D7).
6. `NEW_ORGANIZATIONS_ONLY` offers: no prior verified or attested payment (`SAAS_OFFER_NOT_ELIGIBLE`).
7. No other open checkout for the organization (`SAAS_CHECKOUT_OPEN`).
8. Per-offer `saleLimit`: subscriptions + live checkouts (`SAAS_OFFER_SOLD_OUT`).
9. Founder offers: **one HON OS founder pool**, cumulative across set versions, limited by the published set's `founderTotalLimit`, counting founder subscriptions + live founder checkouts (`SAAS_FOUNDER_SOLD_OUT`, D1). Separate from the legacy founder inventory. The open checkout is the hold (D2); cancellation or expiry returns it.

Activation happens only from a signature-verified provider event (B5 path). Anything that does not match moves the checkout to `PAID_NEEDS_REVIEW` for the HQ owner, with no subscription and no automatic refund: `PAID_AFTER_CLOSE` (checkout expired, cancelled or past its validity window, even if no sweep closed it), `AMOUNT_MISMATCH`, `RECURRING_MISMATCH` (one-time offer paid through a provider subscription, or the reverse), `ENTITLEMENT_CHANGED`, `SUBSCRIPTION_EXISTS`, `OFFER_SALES_STOPPED` (an explicit HQ stop-sales on that offer at or before the payment), `SALE_LIMIT_REACHED`, `FOUNDER_UNAVAILABLE`.

**Routine price change vs explicit stop (owner decision D6, revised 2026-10-23).** A checkout is valid for its window (just under 24 hours, the provider session expiry). During that window the school keeps the exact accepted offer even if HQ publishes a new price version (which retires the old offer) or the offer's own sales window closes; the payment activates at the accepted price and terms. Only an explicit stop-sales sends the payment to review. HQ can stop a published offer, and also a **retired** offer while it still has a live checkout, so an emergency stop remains possible after a routine price replacement. A stop on a retired offer with no live checkout is refused (`SAAS_OFFER_NOT_PUBLISHED`). Stop-sales, checkout opening and activation are serialized on the same lock. Expiry, provider verification, inventory, founder pool and every mismatch check are unchanged.

Renewals apply only to monthly subscriptions and to annual subscriptions with a provider `year` subscription, only on an anchored period boundary, and only at the accepted price. Everything else is `NEEDS_REVIEW` (`PERIOD_MISMATCH`, `AMOUNT_MISMATCH`, `SUBSCRIPTION_NOT_BILLABLE`).

Other consumers:

- **Refunds:** the window is the accepted offer's `refundWindowDays` (legacy purchases stay 30 days); stored per request as `window_hours`.
- **Credits (planning only):** planned monthly credits come from the accepted offer; the credit program stays INACTIVE and nothing is granted (D5).
- **Payment standing, school billing account, invoices:** annual periods are 12 months; HON OS records carry `source: HON_OS_OFFER`.

## HTTP API (for Codex)

| Method / path | Human command header | Body | Response |
|---|---|---|---|
| `GET /v1/schools/:schoolId/hon-os-offers` | – | – | `SaasHonOsSchoolOfferView` |
| `POST /v1/schools/:schoolId/hon-os-offers/checkout` | `saas-hon-os-checkout-start` | `{offerId}` only | `SaasHonOsCheckoutReceipt` + `providerCall` |
| `POST /v1/schools/:schoolId/hon-plan/checkout/:checkoutId/cancel` | `saas-checkout-cancel` (existing) | `{expectedVersion}` | existing cancel receipt |
| `GET /v1/hq/saas/offers` | – | – | `SaasHonOsOfferManagementView` |

Both commands need an `Idempotency-Key` UUID and the same-origin headers, exactly like the existing billing routes. Contract types are in `packages/contracts/src/saas-offers.ts` and `saas-payments.ts`.

**School view changes (0181 → 0182):**

- `purchase`: `TEST_MODE` | `UNAVAILABLE` (was `NOT_CONNECTED`). Show a buy button only when `TEST_MODE` **and** the offer's `eligibility` is `ELIGIBLE`.
- Each offer gains `recurringBilling`: `MONTH` | `YEAR` | `NONE` | `null`. Use it for "renews monthly / renews yearly / one-time payment" copy. `null` only with `NOT_AVAILABLE_TERMS`.
- `eligibility` values: `ELIGIBLE`, `NOT_ELIGIBLE_EXISTING_SUBSCRIPTION`, `NOT_ELIGIBLE_PRIOR_PURCHASE`, `NOT_ELIGIBLE_ENTITLEMENT`, `CHECKOUT_IN_PROGRESS`, `SOLD_OUT`, `FOUNDER_SOLD_OUT`, `NOT_AVAILABLE_TERMS`, `NOT_AVAILABLE`. `REQUIRES_HQ_FOUNDER_RESERVATION` is gone (founder offers are self-serve with an atomic hold). Display these; never re-derive them.
- New `checkout` (latest HON OS checkout, the existing `SaasCheckout` shape) and `purchased` (`subscriptionId`, `offerId`, `offerKind`, `displayName`, `priceMinor`, `recurringBilling`, `offerSetVersion`, `acceptedOfferDigest`, `status`, `serviceStartedAt`). `purchased` shows what the school accepted, which can differ from today's published price.

**Checkout receipt:** `{checkout, purchase:{productName, offerDisplayName, recurringBilling, offerSetVersion, termsReference, acceptedOfferDigest}, replayed, providerCall}`. Redirect to `checkout.checkoutUrl` when `providerCall` is `OPENED` or `ALREADY_OPEN`. Return URLs land on `/schools/:schoolId/hon-plan?checkout=…&result=success|cancelled`; the result parameter is not proof of payment, so re-read the school view.

**HQ management view:** `honOsSales` is now `{offers:[{offerId, setVersion, offerCode, offerKind, displayName, priceMinor, saleLimit, saleStatus, subscriptions, openCheckouts, paidNeedsReview}], founderPool:{limit, allocated, held, remaining}}` (the published set's offers plus any older offer that had a checkout), and `purchase` is `TEST_MODE` | `UNAVAILABLE`. These are test-mode records, not revenue. `saleStatus` is `ON_SALE`, `TERMS_UNSUPPORTED` (published but never purchasable, e.g. `AUTO_RENEW_AT_CURRENT_PRICE` until a secure repricing system exists) or `NOT_ON_SALE` (retired, stopped, closed or not yet open). HQ screens must show `TERMS_UNSUPPORTED` prominently so a published offer is never mistaken for purchasable.

**Contract widenings that touch existing screens:** `SaasCheckout`, `SaasSubscription`, invoice, refund and school-billing views accept the offer kinds `REGULAR_ANNUAL`, `FOUNDER_ANNUAL`, `LIFETIME`, the interval `ANNUAL`, source `HON_OS_OFFER` and checkout reasons `OFFER_SALES_STOPPED`, `SALE_LIMIT_REACHED`, `RECURRING_MISMATCH`. Legacy JSON key sets are unchanged. Exhaustive `switch`/label maps over these enums need the new members.

New error codes (422): `SAAS_OFFER_NOT_ELIGIBLE`, `SAAS_OFFER_SOLD_OUT`, `SAAS_OFFER_TERMS_UNSUPPORTED`, plus the existing `SAAS_OFFER_NOT_AVAILABLE`, `SAAS_FOUNDER_SOLD_OUT`, `SAAS_CHECKOUT_OPEN`, `SAAS_SUBSCRIPTION_EXISTS`, `SAAS_ENTITLEMENT_NOT_ACTIVE`, `SAAS_ENTITLEMENT_MISMATCH`, `SAAS_PAYMENTS_NOT_ACTIVE`.

## Not in this change (each needs separate authorization)

1. Any real Stripe sandbox run or webhook endpoint registration.
2. **Launch dependency (D7, accepted as a temporary test-mode boundary):** organizations awaiting first payment cannot buy HON OS yet, and the B6A awaiting path still offers the legacy catalog. Before public launch, a separately reviewed B6 onboarding and paid-activation milestone must let a new school buy HON OS without an active paid Complete entitlement. The ACTIVE COMPLETE check in this change stays as is.
3. Legacy Core/Complete → HON OS upgrades, cancellations and plan changes.
4. Repricing at renewal (`AUTO_RENEW_AT_CURRENT_PRICE`) and any change to an existing subscription's price.
5. **Launch dependency (D8, accepted temporarily):** legacy Core/Complete checkout and historical subscriptions are unchanged for compatibility. Before commercial launch, new customers must be offered only HON OS, with legacy continuation kept separate from new sales.
6. Public pricing endpoint, live mode, and any lifetime AI credit grant (needs the approved financial policy and actual provider costs).

## Evidence

- `packages/database/scripts/test-saas-hon-os-purchase-integrity.mjs` (disposable DB, simulated Stripe): every rule above, including both contention races; a new price version published while two checkouts are open (one activates at its accepted version-1 price, the other is explicitly stopped and goes to review); a sales window closing during an open checkout (activates); provider-expired and unswept-expired checkouts (`PAID_AFTER_CLOSE`); payment replay; unsigned, tampered and live-mode deliveries; the `AMOUNT_MISMATCH`, `RECURRING_MISMATCH` and `OFFER_SALES_STOPPED` review paths; `ENTITLEMENT_CHANGED`, `SALE_LIMIT_REACHED` and `FOUNDER_UNAVAILABLE` are defensive rechecks of conditions the opening locks already prevent and are not exercised, renewals before and after a price change, refunds and disputes, and no change to entitlements, legacy subscriptions, founder records, credits or paid access.
- Existing B1–B6A, Champions, 0181 offers and entitlement-coverage proofs pass with 0182 applied.
- `apps/api/test/saas-payments.test.cjs`, `saas-offers.test.cjs`, `saas-refunds-rewards.test.cjs`: adapter request shapes per interval, closed receipts and views, HTTP guards for the new route.
