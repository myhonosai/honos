# Owner-approved commercial policy and financial planning

**This is the business intent, not live billing authorization.** For implemented current limits see `docs/architecture/PUBLIC_PLAN_CATALOG.md`, `docs/architecture/CORE_COMPLETE_ENTITLEMENT_ENFORCEMENT_AUDIT_2026-10-17.md` and current domain contracts.

## Subscription and founder prices

| | Core | Complete |
|---|---:|---:|
| Regular monthly | $149 | $249 |
| Founder monthly | $79 | $149 |
| Original **paid founding lifetime** (one-time) | $1,896 | $3,576 |
| Included premium AI credits, **every month** | 5,000 | 12,000 |
| Ordinary contextual HON assistant | Included | Included |

- First **50 founder schools**, including an intended maximum of **20 original paid founding lifetime** offers and 30 monthly founder subscriptions. Those 20 original paid lifetime offers are distinct from **referral-earned lifetime** awards.
- Paid founding lifetime receives the **full applicable 5,000/12,000 monthly premium allowance throughout the purchased tier's lifetime service**, not just two years. Do NOT downgrade promised allowances in a later cost exercise. Paid lifetime selling price is 24 × founder monthly price, not a cap on term or credits.
- Founder annual pricing, taxes, one-time/onboarding charges and annual discount are **not finalized**. The formerly considered extra 20% off already reduced founder pricing may be uneconomical; do not activate.
- Regular school base plan pricing never depends on student count. Core and Complete functionality entitlements matter as much as price.
- Included premium allowance resets monthly, with no rollover. Ordinary HON conversation is included subject to reasonable fair use and cost-effective model routing; not literally unlimited provider spend.
- Premium jobs include creative assets, video, costly research/delegation and governed recurring optimization. Meter only approved eligible operations to an auditable account and school ledger; preview estimated charge, reserve, finalize actual, refund unused credits on provider failure, avoid repeat charge on idempotent retry.
- **Premium top-up price = 2× HON's verified fully loaded underlying provider cost**, the same principle for all regular, founder and lifetime plans. Illustrative only if provider cost is $0.01/credit: top-up price $0.02/credit; 1k=$20; 3k=$60; 5k=$100; 10k=$200. Provider costs may vary by model/video modality; do not hard-code a fictional actual cost or bill extra credits automatically.
- No automatic card charge, provider spending, credit grant or overage without an explicit appropriate approval. Credit accounting and HQ margin views must reflect actual usage and all provider invoices.

## Refund guarantee

**30-day 100% no-questions-asked refund** on the first eligible HON plan purchase, including founder/lifetime if covered by published final terms. Distinguish HON-plan fees from externally authorized Meta/Google advertising, third-party costs or separately purchased items with up-front truthful terms. Reserve refund liquidity from paid lifetime receipts for at least the refund window. Executing refunds requires exact record, authorization, payment provider receipt, idempotency and audit.

## HON Payments

Optional for Core and Complete. Initial proposed integration: **Stripe Connect**, school-owned connected merchant accounts, direct charges where supported/appropriate, signed webhooks and reconciliation. Preserve payment-provider abstraction, evaluate Square and low-cost ACH providers, only claim processing revenue share or promotional processing rates after real agreement and compliance review. No live payment/payout or processor setup by documentation changes.

## Planning assumptions — not verified actual expenses

70% average use of allowance; assumed fully loaded premium AI provider cost $0.01 per HON credit; 60% Core/40% Complete mix; other per-customer monthly cost $20 Core, $35 Complete; extra per-school overhead $10; card + Billing collection approximation 3.6% + $0.30 per monthly charged invoice. Shared fixed assumptions: $1,000 marketing/month, $200 tools/month; Manus runtime cost excluded from model.

| Subscription | Monthly revenue | Assumed premium AI cost | Other + $10 overhead | Billing fee | Contribution, before shared fixed costs |
|---|---:|---:|---:|---:|---:|
| Regular Core | $149 | $35 | $30 | $5.66 | **$78.34 (52.6%)** |
| Regular Complete | $249 | $84 | $45 | $9.26 | **$110.74 (44.5%)** |
| Founder Core | $79 | $35 | $30 | $3.14 | **$10.86 (13.7%)** |
| Founder Complete | $149 | $84 | $45 | $5.66 | **$14.34 (9.6%)** |

With modeled mix and 20 original paid lifetime (12 Core, 8 Complete), one-time gross paid lifetime funds **$51,360**. This is financing, not perpetual free profit; 20 ongoing lifetime members continue to incur credit/provider/support costs. At a modeled 1,000 schools with 20 original paid lifetime, 30 founder monthly, and 950 regular customers, earlier scenario **$182,760 modeled MRR** and **about $84,087 monthly modeled remainder** after these lean assumed expenses, excluding real expansion of engineering/support/sales/customer acquisition, contest prizes/referral rewards, refunds, taxes and churn. Never present as an assured margin, audited forecast or take-home amount. At 100% premium allowance utilization founder monthly tiers may be underwater.

Do not deploy the commercial policy until actual provider rates, reward accounting, refund rules, customer terms, tax posture, future-life liability and legal approval are verified.

## Legacy compatibility

Only Core/Complete offered publicly to new signups. Existing Essential is a valid **legacy/foundation** entitlement in code and existing contracts; preserve customer records and current service until an explicitly approved migration and affected-party review. No destructive silent deletion.