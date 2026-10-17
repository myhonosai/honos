# Public Plan Catalog — Limited Non-Live Pricing Policy

## Delivered scope

`@hon/config` now owns the canonical **public plan catalog** in `packages/config/src/public-plan-catalog.ts`.

| Public plan | Non-binding display price | Premium AI credit planning allowance | Public status |
|---|---:|---:|---|
| Core (`CORE`) | $149/month | 5,000 | Displayable and selectable for a new public plan choice |
| Complete (`COMPLETE`) | $249/month | 12,000 | Displayable and selectable for a new public plan choice |

The catalog marks both values as:

- `NON_BINDING_DISPLAY_METADATA` for price;
- `PLANNING_ONLY_NOT_A_CREDIT_GRANT` for premium AI credits.

> The catalog is inert data. It has no transport, persistence, subscription, invoice, payment, entitlement, offer-activation, or credit-grant behavior.

`DEFAULT_PUBLIC_PLAN_TIER` is **Core**. The catalog deliberately omits **Essential**.

## Essential legacy compatibility

`HON_TIERS` remains unchanged: `ESSENTIAL`, `CORE`, and `COMPLETE` are all valid `HonTier` values. Existing tier feature maps, server-side entitlement checks, historical subscriptions, database records, invoices, and customer data are not migrated or repriced by this change.

`LEGACY_ESSENTIAL_PLAN` states the public-catalog boundary explicitly:

- Essential is **historical/subscription-compatible** for existing records.
- Essential is **not displayable**, selectable, or the default for a new public plan choice.
- No normal server-side Essential entitlement check was narrowed or removed.

## Updated existing surfaces

- The existing public **Complete** (`/`) and **Core** (`/core`) design-reference pages display the canonical Core/Complete catalog and explicitly state that the values do not activate billing or an offer, create a subscription, charge a payment, issue an invoice, or grant credits.
- The existing authorized **HQ onboarding** tier selector consumes the same catalog, defaults to Core, and exposes only Core and Complete. The adjacent notice distinguishes its pre-existing governed tenant-provisioning request from commercial activation: selecting an initial tier still creates the normal organization entitlement for that request, but does not activate live billing or an offer, create a subscription, issue an invoice, charge a payment, or grant credits.
- The existing **Big-Button / Phone**, **Modern HON**, and **Classic CRM** presentation modes remain independent of plan/tier. They change presentation density only; no mode receives a tier mapping, entitlement gate, or plan-specific behavior.

## Explicitly not delivered / remaining gaps

This vertical intentionally does **not** add or change:

1. A live public pricing, signup, checkout, terms, or self-service onboarding page.
2. Offer/product lifecycle, price enforcement, currency/tax handling, discounts, grandfathering, plan changes, cancellation, migration, or customer repricing.
3. Subscription, invoice, payment method, charge, provider, deployment, or external API behavior.
4. AI credit issuance, irreversible grants, balance tracking, reservation, metering, provider-cost accounting, warning thresholds, or reconciliation.
5. Any migration, remediation, or public display for legacy Essential customers; existing compatibility remains in place.
6. New HQ billing controls beyond the already-existing governed tenant-provisioning selector.

## Verification

Focused local validation passed after implementation:

```text
pnpm --filter @hon/contracts check
pnpm --filter @hon/config check
pnpm --filter @hon/web check
pnpm --filter @hon/web exec vitest run test/public-plan-catalog.test.ts
# 5 tests passed

git diff --check
```

The focused test covers the exact Core/Complete values; Essential omission and legacy compatibility; default selection; non-activation language on public reference/HQ surfaces; absence of catalog transport/persistence calls; and all three tier-neutral interface modes.
