# HON OS founder 50-spot count (schedule billing piece 4, migration 0279)

Status: source only. Not deployed. Paid access stays INACTIVE, the payment program stays DISABLED as shipped, and no
checkout, live payment, provider call, refund execution or AI credit is enabled by this piece.

## Owner policy this implements

| Rule | Source |
| --- | --- |
| Founder price is $199.20/month or $1,494/year, locked for as long as the school stays subscribed | Owner checklist 2026-11-09 |
| After a cancellation, or a lapse past the 7-day grace, a new subscription is at the standard price ($249/month, $2,097/year) | Owner checklist 2026-11-09 |
| Implemented as new founder terms; 0188 history is never rewritten | Owner checklist 2026-11-09 |
| The 50 cap counts only new schedule-plan founder sales; v1 checkouts and legacy founder reservations stay outside it | Owner checklist 2026-11-09 |
| An unpaid sign-up holds no spot | OD-4 |
| A payment is never auto-refunded | Owner answer 3 |
| A 30-day refund does not return the spot, and the school cannot buy founder again | Owner checklist 2026-11-09 |
| After a verified refund, the plan carries on as before | Owner decision 2026-11-09 |
| Counting at the first verified payment; a late payer's money is held for an HQ refund | Recommended option on the 2026-11-12 decision card (built while the owner decides) |

## Model

- `saas_founder_pool` is a single immutable row with `capacity = 50`. Nobody, not even the migration owner through SQL, can
  change, add or remove it.
- `saas_founder_allocations` holds one immutable row per counted spot. Each row records the organization, school,
  binding, the paid period that counted it, the provider event, the offer, the set, the kind and the locked price. The
  table has UNIQUE `organization_id`, so an organization gets at most one spot, ever. It also has UNIQUE `spot_number`
  in 1..50, plus UNIQUE `binding_id`, `paid_period_id` and `provider_event_id`.
- A spot row can only be inserted by the insert guard, and only when all of these hold:
  - the guard holds the pool row lock;
  - the binding is a founder binding still waiting for its first payment (`BOUND_TEST_ONLY`, never activated);
  - the paid period is that binding's only period, at the locked price;
  - no limit is reached: the pool (50), the set's `founder_total_limit`, or the offer's `sale_limit`;
  - the spot number is exactly the next one.

  A deferred check at commit then requires the stored, counted `invoice.paid` event for that period, and only the ingest
  path writes that event.

### Founder terms (schemaVersion 2)

A founder offer gets a schedule only if all of these hold:

- it is published with `price_lock = WHILE_CONTINUOUSLY_SUBSCRIBED`;
- if annual, it renews at the locked price;
- it renews at its own offer (renewal offer = the founder offer);
- its price is below the standard price for the same interval.

Its terms are:

- `initialPriceMinor` and `renewalPriceMinor` are both the founder price, with no introductory phase.
- `standardPriceMinor` is the return price.
- `founderPriceRule` is `LOCKED_WHILE_SUBSCRIBED`.
- `returnPriceRule` is `STANDARD_PRICE_AFTER_CANCEL_OR_LAPSE`.
- `founderSpotRule` is `ONE_PER_ORGANIZATION_COUNTED_AT_FIRST_VERIFIED_PAYMENT`.

The disclosure names the 7-day grace, so the terms are refused if the access grace is ever changed. Standard
(`REGULAR_*`) schedule content is byte-for-byte unchanged, so every existing standard schedule digest still matches.
Version 1 (step-up) founder schedules remain history and can never be accepted (`FOUNDER_TERMS_NOT_LOCKED`).

## Lifecycle

1. **Before a charge.** Acceptance preview, generation and binding start each check whether a spot could be counted now.
   The reasons, in order, are:
   - `FOUNDER_ALREADY_USED`
   - `FOUNDER_SOLD_OUT`
   - `FOUNDER_SET_LIMIT_REACHED`
   - `FOUNDER_OFFER_LIMIT_REACHED`

   If any applies, the step is refused before the provider is ever contacted. These checks never reserve anything.
2. **First verified payment** (ingest, inside the canonical lock order: event → organization → binding row → founder
   pool → paid periods):
   - If a spot is available, the paid period and the spot are written in the same transaction, and the binding becomes
     `ACTIVE`.
   - If not, the payment is stored and held with reason `FOUNDER_SPOT_UNAVAILABLE` and a reconciliation row. The binding
     becomes `NEEDS_REVIEW`. No period and no spot are written.
3. **Access.** A founder plan activates only when its binding has a counted spot (`FOUNDER_UNAVAILABLE` otherwise; this is
   defence in depth, since the held path never writes a period).
4. **Renewals** are charged at the locked founder price and never count another spot. Any other amount is held for review
   (`AMOUNT_MISMATCH`).
5. **Held payment.**
   - HQ sees it in the paid review queue (`reason FOUNDER_SPOT_UNAVAILABLE`, `allowedDecisions ['REFUND_OWED']`).
   - The HQ owner records the refund obligation, and the provider's refund event is stored.
   - Verification then returns the sign-up to waiting for its first payment (piece 3 rule).
   - Only then may the school cancel that sign-up. 0279 widens `cancel_saas_schedule_binding` for exactly one case: the
     binding has no counted period, and every review item is covered by the HQ-verified refund. After cancelling, the
     school can sign up at the standard price.
6. **Refunds and spots.** A refund never returns a spot, and spots are never deleted.

The race for the last spot is serialized by the pool row lock. The proof shows two concurrent first payments both waiting
on that lock: exactly one counts spot 50 and the other is held.

## Reads

- `GET /v1/hq/saas/founder-pool` (HQ owner or billing operator): capacity, allocated, remaining, every spot, and the count
  of payments held without a spot. It reports `legacyFounderSalesCounted: false`. The HQ offers screen's older
  `honOsSales.founderPool` remains the v1 checkout count.
- `GET /v1/schools/:schoolId/hon-os-founder-availability` (exact-school purchaser): pool counts, whether the organization
  already used its spot, and for each founder offer on sale its price, the standard price, and whether a spot could be
  counted now with the reason. It always says `spotReserved: false` and `spotCountedAt: FIRST_VERIFIED_PAYMENT`.

## Not decided here

- Whether a counted founder plan that is refunded within 30 days (OD-11/12) ends immediately. The spot is not returned
  either way.
- Whether founder `NEW_ORGANIZATIONS_ONLY` eligibility should exclude organizations with an earlier v1 or legacy purchase.
  This piece enforces only one schedule founder spot per organization.
- Expiring a refunded, held-only founder sign-up automatically. Today the school cancels it (the 0230 worker expiry still
  refuses any binding with stored money events).

## Proof

`packages/database/scripts/test-saas-founder-allocation-integrity.mjs` has 8 groups, run by `.github/scripts/run-db-proofs.sh`.
