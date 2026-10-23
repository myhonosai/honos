# HON OS-only new-customer sales (D8)

**Status:** migration `0184`. It is not deployed and has not been applied to any persistent database.

- **Owner decision D8 (2026-10-23):** HON OS is the only product sold to new customers. Legacy Essential, Core and Complete stay supported for the customers who already have them.
- **Test mode only.** No real Stripe call, no live payment, no deployment.
- **Paid access and AI credits stay INACTIVE.** Nothing here changes a real organization's access or opens credits.
- **Reserved numbers:** `0179` (E1b-2) and `0180` (E1c) stay reserved.

## Who is a new customer and who is a legacy customer

The backend decides this from its own records, never from the browser, the selected school or a URL.

| | Authoritative evidence | What they can buy |
|---|---|---|
| **Legacy customer** | The organization has a legacy subscription record (`saas_subscriptions.source` = `CATALOG_OFFER` or `LEGACY_ENTITLEMENT`). It was recorded by HQ, or created by a provider-verified payment, before the closure. | Nothing new. Their existing subscription continues (see below). |
| **New customer** | Every other organization: an HQ-provisioned school with no subscription, or a school registered awaiting its first payment (D7). | Only an HQ-published HON OS offer. |

A legacy customer can never open a second legacy purchase anyway: every legacy checkout already required that the organization have no live subscription. A legacy checkout was therefore always a first sale, and closing it closes new legacy sales and nothing else.

## The closure

`hon.saas_new_sales_policy` is a single private row: `new_sale_product = 'HON_OS'`, `legacy_new_sales = 'CLOSED'`.
- **Pinned.** A CHECK constraint allows only `CLOSED`, and the row is immutable, like the paid-access program. Reopening legacy sales needs a reviewed migration after owner approval. It is never a runtime switch.
- **Private.** No runtime role can read the table or execute its helper `hon.saas_legacy_new_sales_open()`.

## Every legacy sale path is refused

All refusals use `SAAS_LEGACY_SALES_CLOSED`, which the API returns as `422`.

| Path | Behaviour after 0184 |
|---|---|
| School legacy checkout `POST /v1/schools/:schoolId/hon-plan/checkout` | Refused after the purchaser check and **before the request is claimed**. Replaying a key from before the closure therefore never reaches the provider. |
| HQ legacy checkout `POST /v1/hq/saas/payments/checkouts` | Refused the same way. |
| A pre-closure checkout still `CREATED` (provider outcome unknown) | Its provider session can no longer be attached. The school or HQ can still cancel it. |
| HQ `POST /v1/hq/saas/subscriptions` (`CATALOG_OFFER` or `LEGACY_ENTITLEMENT`) | Refused: no new legacy subscription record. |
| HQ legacy founder reservation `POST /v1/hq/saas/founder-reservations` | Refused. |
| Anything else that writes the tables directly | A `BEFORE INSERT` guard (`saas_legacy_new_sale`) on `saas_subscriptions`, `saas_checkout_sessions` and `saas_founder_reservations` refuses a new legacy row. On checkouts it also refuses `CREATED → OPEN` for a legacy checkout. |

The school legacy plan read (`GET /v1/schools/:schoolId/hon-plan`) lists **no offers**. Its subscription, payment verification and checkout fields are unchanged, so a legacy customer still sees their plan and a school still sees a held payment. The response shape is unchanged.

## Stale legacy links and held payments

A legacy checkout opened before the closure can still be paid at the provider. The signature-verified payment is held:
- the checkout becomes `PAID_NEEDS_REVIEW` with reason `LEGACY_SALES_CLOSED`;
- no subscription, invoice, entitlement change, founder allocation or AI credit is created;
- for a school awaiting its first payment, a `NEEDS_REVIEW` access transition is also recorded.

HQ reviews and refunds held payments. Replays of the same event change nothing.

**Retries.** The HQ-owner retry of a legacy payment held while paid access was inactive (`ACCESS_PROGRAM_INACTIVE`) now ends as `NEEDS_REVIEW` / `LEGACY_SALES_CLOSED`. That school then buys HON OS.

**Already-completed pre-closure payments are honoured.** A legacy payment that completed before the closure but whose access activation needs review keeps its existing retry: that customer is a legacy customer who already paid.

## New customers: HON OS only

- **A provisioned Complete school with no subscription** buys HON OS through the 0182 path. Its entitlement is unchanged.
- **A school awaiting its first payment** (registered through D7, or placed awaiting by the HQ owner) buys HON OS through the D7 path. The verified payment activates HON OS (Complete).
- **A provisioned Core or Essential school** cannot buy HON OS on its current entitlement (`SAAS_ENTITLEMENT_MISMATCH`), and it has no legacy option any more. While paid access is ACTIVE, the HQ owner places it awaiting its first payment (B6A T1) and it buys HON OS through the D7 path.

Every 0182/0183 rule still applies:
- HQ-published offers, prices, terms and eligibility, under a versioned offer identity and frozen accepted-offer snapshot;
- the sale limit and the single HON OS founder pool, counted under one lock;
- idempotency, audit and outbox;
- no AI credits at activation.

The legacy founder inventory (B1) and the HON OS founder pool (0182) are separate. Legacy holds and allocations never count toward HON OS.

## Legacy customers continue unchanged

Nothing in 0184 updates or deletes an existing legacy row. These continue exactly as before:
- legacy subscriptions, including paid lifetime and founder slots;
- renewals at the legacy price, failed renewals and `PAST_DUE`;
- invoices and payment evidence;
- provider refunds and disputes;
- refund requests under the 30-day guarantee;
- HQ lifecycle commands (suspend, resume, advance period, void);
- allowances.

Cancellation and plan changes stay refused by their undecided policies, exactly as before.

## Security boundary

- **Never authority:** the browser, the selected school, a stale URL, an old idempotency key or an offer ID a client kept.
- **Order of checks:** authorization is checked before the closure, so an outsider learns nothing new.
- **Grants:** the new table and both functions are private. `infra/postgres/010` and the security registry (`saas-billing-security.mjs`) are updated, including the three guard triggers.

## For Codex (frontend)

There is no new route and no new response shape.
- **`GET /hon-plan`** now returns `offers: []`. Point new schools to the HON OS offers (`GET /v1/schools/:schoolId/hon-os-offers`) instead of the legacy plan picker.
- **`SAAS_LEGACY_SALES_CLOSED`** (422) can appear on the legacy checkout routes.
- **Checkout reason:** `LEGACY_SALES_CLOSED` is a new checkout `statusReason`, added to the contracts. Show it as "held for HON review; HON will refund it".

## Evidence

- **New proof:** `packages/database/scripts/test-saas-hon-os-only-new-sales.mjs`. It runs on a disposable database with simulated Stripe; paid access ACTIVE is simulated only where needed, then restored. It covers:
  - the shipped posture: pinned, private and immutable;
  - all six legacy offer IDs refused for school and HQ checkout, with no provider call;
  - HQ legacy records and founder holds refused;
  - direct writes refused by the guard alone;
  - a replayed pre-closure key and a provider-session attach refused;
  - stale open, founder and inactive-held legacy payments held, including replays and the HQ retry;
  - new customers buying HON OS through both paths, with the founder pool and a lifetime sale limit exhausted;
  - legacy refund request, lifecycle commands, renewal (and its replay), provider refund, dispute and lifetime subscription.
- **Mutation checks**, each caught by the proof:
  - removing the activation hold;
  - removing the pre-claim refusal;
  - disabling the checkout guard;
  - listing legacy offers again.
- **Legacy proofs** (B1–B6A, 0181, 0182) reopen legacy sales in their disposable database only, through `saas-legacy-sales-simulation.mjs`, and restore the shipped posture before they end. The D7 proof now asserts that an awaiting school sees no legacy offer.

## Owner decisions and launch blockers

1. **Recording existing pilot schools as legacy (`LEGACY_ENTITLEMENT`)** is closed with everything else. If HQ needs to record a pre-D8 provisioned school as a legacy customer, that is a reviewed reopening for that path only.
2. **HQ provisioning** (`provision_school_from_hq`) still creates a school with an ACTIVE Essential/Core/Complete entitlement and no payment. It is a free HQ grant, not a sale, and it can no longer lead to a legacy purchase. Before paid access is switched on, decide whether provisioning is restricted to D12 exceptions or creates schools awaiting payment.
3. **Legacy catalog publishing** still works for HQ, but nothing it publishes can be sold.
4. **Before deploying 0184**, HQ cancels any open legacy checkout and expires its Stripe session. Any that is paid anyway is held as `LEGACY_SALES_CLOSED` for refund.
5. **Still open from D7:** the public sign-up caller (Manus), the paid-access activation migration, and the HON OS credit policy (including lifetime).
