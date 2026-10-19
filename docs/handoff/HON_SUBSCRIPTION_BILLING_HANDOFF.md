# Recommended Technical Handoff: HON Subscription Billing, Plans, Founder Pricing and AI Credit Allowance

**Status:** B1 merged (`7afa0b5`): [HON_SUBSCRIPTION_CATALOG_B1.md](../architecture/HON_SUBSCRIPTION_CATALOG_B1.md). B2 merged (`3d6e818`): [HON_SUBSCRIPTION_INVOICING_B2.md](../architecture/HON_SUBSCRIPTION_INVOICING_B2.md). B3 merged (`512eddb`): [HON_PREMIUM_CREDITS_B3.md](../architecture/HON_PREMIUM_CREDITS_B3.md). B4 is implemented in its own PR (not merged): [HON_REFUNDS_CHAMPIONS_REWARDS_B4.md](../architecture/HON_REFUNDS_CHAMPIONS_REWARDS_B4.md). B5 is not started. Nothing here activates billing, charges, credits or a payment provider.

**Why this is next.** Champions Club fulfillment, the `HON_BILLING` payment-verification source, the 30-day refund guarantee, founder offers and premium AI credit allowances all depend on HON knowing, authoritatively, what each school bought, when it paid, and what allowance it holds.

## What exists today (verified in the repository)

| Foundation | Where | Gap |
| --- | --- | --- |
| Organization plan tier (`ESSENTIAL` legacy, `CORE`, `COMPLETE`) with status and version | `0009_organization_entitlements.sql`; HQ transition in `0146` | No price, billing interval, plan offer, founder flag or paid-through date |
| AI usage ledger | `hon.ai_usage_ledger` (`0005_ai_usage_economics.sql`) | No allowance, balance, reservation, top-up or warning thresholds |
| School-to-family billing (memberships, invoices, payment schedules) | Billing migrations, `apps/api/src/billing` | That is **schools billing families**. It must stay separate from **HON billing schools** |
| Commercial policy | `docs/hon/OWNER_COMMERCIAL_POLICY.md` | Owner-approved future policy only |
| Champions liabilities | M2 and M4 | Waiting for a HON invoice to apply credits and free months to |

## Recommended milestones (same discipline as Champions Club)

1. **B1: plan catalog and subscription records (no provider).**
   - Versioned offers: Core $149 / 5,000 credits and Complete $249 / 12,000 credits; founder $79 / $149; original paid lifetime $1,896 / $3,576 with a 20-unit inventory; Essential as legacy only.
   - Per-organization subscription records: offer, interval, status, current period and paid-through date. They are linked to, and never replace, `organization_entitlements`.
   - HQ owner publishes offers; `charges_enabled` is pinned false.
2. **B2: HON invoices and payment evidence (recordkeeping).**
   - HON-to-school invoice and payment-evidence ledger, kept separate from school-to-family billing. Idempotent, audited, inert outbox.
   - This becomes Champions' `HON_BILLING` source: first paid date, paid invoice count, refunds and chargebacks.
3. **B3: AI credit allowance accounting.**
   - Monthly allowance per subscription (full allowance for founder, lifetime and Champions-earned free months, per policy).
   - Reservation, then finalize, then release on provider failure, with no double charge on idempotent retry.
   - 75% / 90% / 100% thresholds and premium top-up accounting at 2× the verified provider cost.
   - No automatic overage.
4. **B4: refund guarantee and Champions fulfillment** (implemented, PR pending).
   - 30-day refund workflow (records and approvals).
   - Apply approved Champions liabilities as invoice credits or free periods. Still no provider until the owner approves activation.
5. **B5: provider integration (separately approved).**
   - Stripe or a similar provider in test mode only.
   - Webhooks to the evidence ledger, then reconciliation. Live charges only with explicit owner approval.

## Owner decisions needed before B1

1. Billing intervals: monthly only, or annual too. Founder annual pricing and discount are not finalized.
2. Taxes, onboarding fees, proration and plan-change rules.
3. Founder inventory rules (50 total: 20 paid lifetime and 30 monthly) and how they are reserved.
4. Payment provider choice, and whether HON Payments for schools shares it.
5. Exact refund-guarantee terms, including founder and lifetime coverage, and the refund liquidity reserve.
6. AI credit rollover (none assumed), the top-up price source of truth, and how premium operations are classified.

## Coordination

- **Manus** owns school CRM and school-to-family billing; HON billing must not modify those files.
- **Codex** owns HQ screens; publish contracts first, as for Champions Club.
- Use new migrations only, the same SECURITY DEFINER, forced-RLS, idempotency, audit and inert-outbox pattern, and disposable-database proofs in CI.
