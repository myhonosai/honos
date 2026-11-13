# HQ business numbers (B-HQ-3, migration 0326)

One read-only HQ read of HON's own business: contracted recurring revenue at list price, paying schools, schools that
started or stopped paying, new schools, public sign-ups and trials, per UTC calendar month.

`GET /v1/hq/saas/business-numbers?months=1..12` (default 6) → `hon.read_hq_business_numbers(subject, months)`.

## Who may read

An HQ owner, or an HQ operator with `hq.billing.manage` (`hon.require_saas_hq_actor(subject, false)`), checked before
and again after the reads (0206 rule). Support staff, school staff, lapsed grants and unknown subjects get 403. The
runtime can execute only the read; the price helper `hon.hq_business_monthly_minor(jsonb)` is internal.

## What the numbers mean (the screen must say this)

- **Charges are not enabled.** Every amount is a recorded list price, never collected money. `chargesEnabled` is always
  `false` in the answer.
- **MRR** counts each school once. A school with an ACTIVE HON OS schedule binding is counted from the binding's locked
  price; otherwise from its newest IN_SERVICE v1 subscription, monthly or annual (catalog or HON OS purchase). An annual
  price counts as price / 12, rounded to the cent. **ARR** is MRR × 12.
- **Lifetime** v1 purchases and active records without a readable price (including legacy entitlement records with
  interval NONE) are counted (`lifetimeSchools`, `unpricedActiveRecords`) and never added to MRR.
- **New paying schools** in a month: schools whose first paid start (binding activation, v1 service start, or a v1
  IN_SERVICE history step; monthly, annual or lifetime) falls in that month. **Trial conversions**: those that also had a trial that started on or
  before that paid start.
- **Stopped paying** is evidence only: a v1 subscription history step from IN_SERVICE to SUSPENDED or VOIDED (a void
  recorded in error is a correction and is not counted). HON OS
  bindings have no recorded cancellation after payment yet, so **no churn rate is computed** (`churnRateAvailable:
  false`). Bindings held for review and suspended subscriptions are shown as current counts.
- **New schools** are organizations created in the month; **public sign-ups** are HON OS self-serve registrations;
  **trials started** are HON OS trial enrollments.

## Shape

`current` (MRR/ARR minor units, paying schools by interval and by source, the side counts) and `months` (oldest first,
the last one month to date). Counts and sums only: no school, person, email or provider reference.
`validateHqBusinessNumbers` rejects any answer whose totals disagree (ARR ≠ MRR × 12, interval or source splits that do
not add up, MRR with no paying school, months out of order, conversions above new paying schools) or that carries an
extra key.

## Proof

`packages/database/scripts/test-hq-business-numbers.mjs` (champions-club fixture): posture, authority, input bounds,
and exact deltas for synthetic records covering every rule above, inside a rolled-back transaction.
