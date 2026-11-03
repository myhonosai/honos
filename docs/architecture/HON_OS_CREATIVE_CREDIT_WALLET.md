# HON OS creative credit wallet (CW1, migration 0202)

**Status:** source change, draft PR. Not deployed. The creative program ships **INACTIVE**. No generation provider is called, no card is charged, no payment is activated.
**Provisional migration number:** 0202. Numbers after 0192 are provisional until the owner approves merge order: 0193–0199 are the open S4 chain, 0200 is #122, 0201 is the Issue #100 billing-period fix.

## What the owner approved (and what this builds)

| Owner direction | Where it lives |
|---|---|
| 12,000 creative credits per eligible paid HON OS school per monthly window | `saas_creative_program.monthly_included_credits` (CHECK = 12000), one `INCLUDED_MONTHLY` lot per subscription window |
| Separate from the internal AI-agent budget; AI team conversations never deduct | Own tables and lock; provider usage written to `ai_usage_ledger` with `customer_credits = 0`; no B3 allowance/reservation/ledger row; every view returns `agentConversationsDeductCredits: false` |
| Top-ups $30 = 3,000; $60 = 6,000 + 1,200; $120 = 12,000 + 4,800 | Immutable `saas_creative_topup_packages` rows (STARTER / GROWTH / CREATOR), base and bonus kept separately on the purchased lot |
| HQ owner grants, adjusts and corrects with no preset limit, authenticated, authorized, idempotent, audited | `grant_saas_creative_credits_from_hq`, `debit_saas_creative_lot_from_hq` (HQ owner only, reason code + note, SaaS request/audit/outbox) |
| HQ sees grants, usage, adjustments, balances and actual provider expense per school | `read_saas_creative_wallet_from_hq`, `read_saas_creative_wallets_from_hq` (owner or billing operator) |
| Reuse B3, entitlement and S4 infrastructure; no competing ledger | Reuses SaaS actor resolvers, `saas_claim_request`/`saas_record`, B3 reservation vocabulary and HQ resolution, verified provider cost evidence, B5 payment truth, B6A paid access, `saas_allowance_period`, and the shared `ai_usage_ledger` for provider cost |
| School-isolated balances; concurrency never overdraws | One wallet per paying organization; every change takes the wallet row lock; school views filter to the exact school |
| No duplicate monthly grants, purchase fulfillment or provider deductions | Unique (subscription, window) lot; one GRANT per lot; idempotency keys; one usage row per settled reservation (`usage_id` unique); unique provider payment reference |
| Reservations, confirmed usage, failed and unresolved outcomes kept separate | Reservation states RESERVED / FINALIZED / RELEASED / OUTCOME_UNKNOWN, ledger RESERVE / FINALIZE / RELEASE |
| Provider expense tracked independently of credit deductions | `provider_cost_microunits` on the reservation and in `ai_usage_ledger`, even when nothing is charged to the school |
| Trial schools keep the 14-day AI-budget safeguards and get no paid allowance | Eligibility requires B6A `PAYMENT_ACTIVE`; trial, provisioned and exception-only schools are refused (`PAID_ACCESS_REQUIRED`) and nothing touches the trial/agent budget |
| Prepare checkout/fulfillment contracts, no card charge | `create_saas_creative_topup_purchase` records an intent (`payment: NOT_CONNECTED`, no checkout row); `saas_fulfill_creative_topup` is an internal, TEST_MODE-only contract not wired to any webhook |
| Generation costs configurable; provisional prices not final | Versioned rate cards published by the HQ owner; each rate is `PROVISIONAL` unless it cites verified provider cost evidence in the same unit |

## Not decided by the owner, so not invented

| Id | Question | Behaviour in CW1 |
|---|---|---|
| CW-D1 | Do purchased or promotional credits expire? | They never expire. Included credits expire at their window end (no rollover). |
| CW-D2 | Consumption order | Proposal implemented: included first, then promotional/adjustment, then purchased (earliest expiry, then oldest). |
| CW-D3 | Monthly window for annual and lifetime terms | Annual and lifetime get monthly UTC windows from service start (the 0156 rule); monthly terms follow the paid subscription period. |
| CW-D4 | Top-up refunds and chargebacks | No clawback. Purchased lots cannot be debited by HQ. Wiring refunds is a separate owner decision. |
| CW-D5 | Final generation prices | Every rate is provisional until linked to verified cost; the fixture rates in the proof are not prices. |
| CW-D6 | High-value HQ grant confirmation | No threshold (owner said no preset limit). |
| CW-D7 | Wallet scope | One wallet per paying HON OS organization (the customer). A multi-school organization shares it; each school sees only its own reservations. |
| AI-D5 | Legacy (non-HON OS) subscriptions | No monthly creative window (`HON_OS_SUBSCRIPTION_REQUIRED`). |

## Eligibility (`saas_creative_eligibility`)

In order: program ACTIVE; B6A access `PAYMENT_ACTIVE`; entitlement in effect; a HON OS subscription; `IN_SERVICE`; current period `PAID` and `PROVIDER_VERIFIED`; the moment falls in a known window; for monthly/annual the window starts before the paid-through date. Refusals surface as `SAAS_CREATIVE_<REASON>` (HTTP 422).

## Flows

- **Window:** opened lazily by `open_saas_creative_window` or the first reservation in a window (wallet lock, ended included lots expire first, then at most one grant per subscription window).
- **Generation (runtime, no HTTP route):** `reserve_saas_creative_credits` before the provider call (wallet lock, eligibility, published rate, unit cap, balance check, lots split in consumption order). `settle_saas_creative_credits` by the same requester: SUCCEEDED finalizes actual units (never above the reservation) and releases the rest; FAILED releases everything and still records any provider cost; UNKNOWN keeps credits held.
- **HQ resolution:** the HQ owner resolves an UNKNOWN, or a reservation still RESERVED (for example a requester who lost access mid-flight), with an evidence reference. The version check means only one of the settle and the resolution can ever apply.
- **Top-up:** a purchaser (`billing.hon.purchase`) of an eligible school records a purchase intent. Fulfillment (internal) needs the B5 payment program in TEST_MODE with the same provider, refuses live mode, grants base + bonus once on an exact amount/currency match, holds a mismatch for review, and records a second payment for an already-settled purchase as `DUPLICATE_PAYMENT_REVIEW` without credits.

## API

HQ (`hq/saas/creative-credits`, human same-origin commands with `x-hon-human-command`):

| Method | Path | Command header |
|---|---|---|
| GET | `/` | – |
| GET | `/organizations/:organizationId` | – |
| POST | `/program` | `saas-creative-program` |
| POST | `/rates` | `saas-creative-rates-publish` |
| POST | `/organizations/:organizationId/grants` | `saas-creative-grant` |
| POST | `/lots/:lotId/debits` | `saas-creative-debit` |
| POST | `/reservations/:reservationId/resolve` | `saas-creative-resolve` |

School (`schools/:schoolId/creative-credits`):

| Method | Path | Command header |
|---|---|---|
| GET | `/` | – |
| POST | `/window` | `saas-creative-window-open` |
| POST | `/top-up-purchases` | `saas-creative-topup-purchase` |

Reserve and settle are service methods for the generation runtime only (as in B3). Contracts: `packages/contracts/src/saas-creative-wallet.ts` (closed inputs, closed responses; school views never contain provider identity, provider cost or HQ notes).

## Security boundary

All ten tables are forced-RLS, deny-all, owned by the migration owner, and reachable only through the listed SECURITY DEFINER functions (also granted in `infra/postgres/010_supabase_hon_runtime.sql`). Evidence tables are append-only (`saas_immutable`); the program, rate versions, wallets, reservations and purchases allow only their listed transitions (`guard_saas_creative`). The runtime cannot execute fulfillment or any internal helper. `saas-billing-security.mjs` tracks every new table, trigger and function.

## S4 relationship

CW1 needs no S4 table and is based on main. When S4-a (#106) lands, `ai_usage_ledger` rows written by CW1 should be tagged with the creative spend class; S4-b's organization budget lock is deliberately not taken by the creative path (creative credits are not the agent budget). Both branches add to the migration manifest and checksum files, so whichever merges second needs a trivial evidence refresh.

## Evidence

`packages/database/scripts/test-saas-creative-wallet-integrity.mjs` (in `run-db-proofs.sh`; `pnpm --filter @hon/database db:test-saas-creative-wallet`) runs the real API services against the disposable Champions fixture with two brand-new HON OS schools paid through simulated Stripe. It covers the program and package posture, owner-only rates and activation, eligibility refusals, one grant under 8 concurrent opens, 8 concurrent 3,000-credit reservations against 12,000 (exactly 4 succeed), settlement and HQ resolution, provider expense separation, HQ grants and corrections, top-up intent and exactly-once fulfillment under 5 concurrent deliveries, consumption order, renewal and expiry, cross-school isolation, ledger-equals-balance, exact audit/outbox counts, immutability and the security verifier.

## Not in CW1

Generation runtime and provider adapters, checkout creation and webhook wiring for top-ups, refunds/chargebacks of top-ups, UI (Codex), an HQ monitor for long-held reservations.
