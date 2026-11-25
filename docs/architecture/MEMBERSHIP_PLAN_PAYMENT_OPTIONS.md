# Membership plan payment options (0642)

Owner request (2026-11-22): build a membership type the way the Manus CRM does. One plan (for example "Little Tigers") holds several payment options (monthly, 6 payments, 1 year paid in full). Each plan also records classes per week and a features list. The separate Memberships list, Activation and Dates tabs leave the Billing menu. A person's memberships show on their contact card, and activation happens when the agreement is signed.

## Data

`0642_membership_plan_payment_options.sql` adds two immutable, append-only tables. Both are keyed by `(plan_id, version)` against the 0175 `membership_plan_versions` row.

| Table | Holds |
|---|---|
| `hon.membership_plan_version_setups` | classes per week (1..14), features (≤12 strings) |
| `hon.membership_plan_payment_options` | up to 6 options: label, price, frequency (WEEKLY, MONTHLY, QUARTERLY, ANNUAL, PAID_IN_FULL), number of payments, length in months, optional down payment, and whether the option shows on checkout pages |

Both tables use forced RLS and have no direct grants. The guard trigger `hon.guard_membership_plan_setup()` refuses any update or delete, and refuses an insert unless the version exists.

### Compatibility with 0175

Option 1 is mirrored into the 0175 version columns (`price_minor`, `billing_frequency`, term). Every existing reader therefore keeps working unchanged: catalog, DRAFT creation, activation, renewals, checkout and imports. Option 1 cannot be QUARTERLY, because 0175 has no such frequency.

A version published before 0642 has no setup rows. `membership_plan_setup_summary` returns `derived: true` and a single option built from the version columns.

## Entry points (runtime, SECURITY DEFINER, pinned search_path)

| Function | Notes |
|---|---|
| `read_school_membership_plan_setups(text)` | Read-only. Uses the same permission as the catalog read. |
| `create_school_membership_plan_with_options(text,jsonb,uuid,uuid,uuid)` | Same permission, idempotency, audit action (`billing.membership_plan.create`) and lock order as 0175. The fingerprint command is `billing.membership_plan.create_with_options`. |
| `revise_school_membership_plan_with_options(text,uuid,jsonb,uuid,uuid,uuid)` | Uses an expected-version check. Unchanged input raises `MEMBERSHIP_PLAN_UNCHANGED`. The audit action is `billing.membership_plan.revise`. |

These functions create catalog records only. There are no charges, provider calls, entitlements or outbox effects. Checkout and the contact card's New membership dialog still use option 1 until a follow-up PR, after #399, lets staff pick an option.

## API

| Method and route | Purpose |
|---|---|
| `POST /membership-plans/setups` | Read setups |
| `POST /membership-plans/with-options` | Create a plan with options |
| `POST /membership-plans/:planId/option-revisions` | Revise a plan's options |

Each route uses its own human-command guard. Contracts live in `@hon/contracts` (`school-membership-plan-setup.ts`). The contract mirrors the database's option rules: option 1 not quarterly, paid in full needs a length and no payment count, annual needs whole years, quarterly needs whole quarters.

## Web

`Membership > Plans` has a "New plan" form in the Manus layout:

- Plan name, then program.
- A Payment options box with "Add option".
- Classes per week, availability, description and features.
- Plan code and currency, folded into a details section.

The form shows a "Check and publish" review and needs a confirmation box ticked before publishing. Plan cards list each payment option.

The Billing menu keeps Plans, Renewals and Import. Memberships, Activation, Dates and Changes are hidden from the menu but still reachable by link, so no existing work is lost.

## Dates tab decision

The Dates page fixes one membership's dates: corrections, extensions, early end, and the legacy confirm queue. That is a per-person action, so it belongs on the contact card as a "Change dates" button once #399 (contact card membership) merges. Until then it stays reachable by link only.

## Proofs

- `pnpm --filter @hon/database db:test-membership-plan-payment-options` runs 91 assertions on the flexible-billing-accounts fixture.
- `apps/api/test/membership-plan-payment-options.test.cjs` covers the API.
- `apps/web/test/membership-plan-ui.test.tsx` covers the web form.
