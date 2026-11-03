# HON OS creative credit wallet (CW1, migration 0202)

**Status:** source change, draft PR. Not deployed. The creative program ships **INACTIVE**. No generation provider is called, no card is charged, no payment is activated.
**Provisional migration number:** 0202. Numbers after 0192 are provisional until the owner approves merge order: 0193–0199 are the open S4 chain, 0200 is #122, 0201 is the Issue #100 billing-period fix.
**Depends on the S4 chain** (0193–0200, stacked on #122): it uses the S4-c spend decision `ai_spend_allowed` and the S4-b `spend_class` column. The migration refuses to apply without them.

**Revision 2 (2026-11-03, after the independent review of a07f637).** Owner decision: *creative credits belong to each eligible paying school, not a shared organization pool.* Every wallet, lot, ledger entry, reservation, adjustment, purchase and cost event is keyed by `school_id` (with its organization), composite foreign keys make it structurally impossible for a row to point at another school's lot, reservation, adjustment or purchase, and HQ reads and grants are per school. Review findings P1-A, P1-B, P1-C, P2-A and P2-B are corrected; see "Review corrections" below.

## What the owner approved (and what this builds)

| Owner direction | Where it lives |
|---|---|
| 12,000 creative credits per eligible paid HON OS school per monthly window | `saas_creative_program.monthly_included_credits` (CHECK = 12000), one `INCLUDED_MONTHLY` lot per (school, subscription, window): unique index `(school_id, subscription_id, window_index)` |
| Separate from the internal AI-agent budget; AI team conversations never deduct | Own tables and lock; provider usage written to `ai_usage_ledger` with `spend_class = 'CREATIVE_MEDIA'` and `customer_credits = 0` (the S4-b agent budget counts `AGENT_INFERENCE` only); no B3 allowance/reservation/ledger row; every view returns `agentConversationsDeductCredits: false` |
| Top-ups $30 = 3,000; $60 = 6,000 + 1,200; $120 = 12,000 + 4,800 | Immutable `saas_creative_topup_packages` rows (STARTER / GROWTH / CREATOR), base and bonus kept separately on the purchased lot |
| HQ owner grants, adjusts and corrects with no preset limit, authenticated, authorized, idempotent, audited | `grant_saas_creative_credits_from_hq`, `debit_saas_creative_lot_from_hq` (HQ owner only, reason code + note, SaaS request/audit/outbox) |
| HQ sees grants, usage, adjustments, balances and actual provider expense per school | `read_saas_creative_wallet_from_hq`, `read_saas_creative_wallets_from_hq` (owner or billing operator) |
| Reuse B3, entitlement and S4 infrastructure; no competing ledger | Reuses SaaS actor resolvers, `saas_claim_request`/`saas_record`, B3 reservation vocabulary and HQ resolution, verified provider cost evidence, B5 payment truth, B6A paid access, `saas_allowance_period`, and the shared `ai_usage_ledger` for provider cost |
| School-owned, isolated balances; concurrency never overdraws | One wallet per school; every change takes that school's wallet row lock (sibling schools never wait on each other); every read filters to the exact school before ordering and limits |
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
| CW-D7 | Wallet scope | **Decided by the owner 2026-11-03:** one wallet per eligible paying school. No organization pool, no sibling spending. |
| CW-D8 | Which schools of a multi-school organization qualify | Proposal implemented: every ACTIVE school of an organization whose one HON OS subscription is paid and in service gets its own 12,000 per window. Needs owner confirmation (the subscription is per organization, the allowance per school). |
| CW-D9 | Does an HQ AI pause also stop top-up purchase intents? | Not stopped: an intent charges nothing. A pause stops new reservations only. |
| AI-D5 | Legacy (non-HON OS) subscriptions | No monthly creative window (`HON_OS_SUBSCRIPTION_REQUIRED`). |

## Eligibility (`saas_creative_eligibility`)

In order: program ACTIVE; the school and its organization ACTIVE (`SCHOOL_NOT_ACTIVE`); B6A access `PAYMENT_ACTIVE`; entitlement in effect; a HON OS subscription; `IN_SERVICE`; current period `PAID` and `PROVIDER_VERIFIED`; the moment falls in a known window; for monthly/annual the window starts before the paid-through date. Refusals surface as `SAAS_CREATIVE_<REASON>` (HTTP 422).

Before eligibility, a new reservation must pass the **S4 shared spend decision** `ai_spend_allowed(organization, now, 'CREATIVE_MEDIA')`: an HQ organization or platform pause (for `CREATIVE_MEDIA` or `ALL`), a live HQ access exception, and every lapsed, suspended, past-due or unknown access state refuse as `SAAS_CREATIVE_AI_<REASON>` (HTTP 422). The reservation holds shared advisory locks on the four pause keys (`ai.pause:<org|platform>:<CREATIVE_MEDIA|ALL>`) that the S4 pause command takes exclusively, so a pause and a reservation never interleave: every reservation that exists was decided before the pause committed.

## Flows

- **Window:** opened lazily by `open_saas_creative_window` or the first reservation in a window (wallet lock, ended included lots expire first, then at most one grant per subscription window).
- **Generation (runtime, no HTTP route):** `reserve_saas_creative_credits` before the provider call (wallet lock, eligibility, published rate, unit cap, balance check, lots split in consumption order). `settle_saas_creative_credits` by the same requester: SUCCEEDED finalizes actual units (never above the reservation) and releases the rest; FAILED releases everything and records the provider cost when known, or marks the cost `UNKNOWN` (never a guessed zero); UNKNOWN keeps credits held. Settlement checks only that the caller is the same active human who reserved: no entitlement, role, pause or school check, so a result already in flight is always recorded even if access changed mid-flight.
- **Cost status:** every reservation carries `cost_status` PENDING (outcome open) → RECORDED or UNKNOWN. A released generation whose cost is UNKNOWN moves to RECORDED **exactly once**, either from HQ evidence (`record_saas_creative_cost_from_hq`) or from the internal provider reconciliation contract `saas_record_creative_provider_cost` (deduplicated per provider event reference; a different event after the cost is recorded is kept as `DUPLICATE_COST_REVIEW` evidence and never added; a cost for a still-open outcome is refused as a retryable 409). Each applied or duplicate cost is an immutable row in `saas_creative_cost_events`. Credits are never re-charged by a late cost.
- **HQ resolution:** the HQ owner resolves an UNKNOWN, or a reservation still RESERVED (for example a requester who lost access mid-flight), with an evidence reference. NOT_CHARGED may leave the cost unknown (`providerCostMicrounits: null`) for later reconciliation. The version check means only one of the settle and the resolution can ever apply.
- **Top-up:** a purchaser (`billing.hon.purchase`) of an eligible school records a purchase intent. Fulfillment (internal) needs the B5 payment program in TEST_MODE with the same provider, refuses live mode, grants base + bonus once on an exact amount/currency match, holds a mismatch for review, and records a second payment for an already-settled purchase as `DUPLICATE_PAYMENT_REVIEW` without credits.

## API

HQ (`hq/saas/creative-credits`, human same-origin commands with `x-hon-human-command`):

| Method | Path | Command header |
|---|---|---|
| GET | `/` | – |
| GET | `/schools/:schoolId` | – |
| POST | `/program` | `saas-creative-program` |
| POST | `/rates` | `saas-creative-rates-publish` |
| POST | `/schools/:schoolId/grants` | `saas-creative-grant` |
| POST | `/lots/:lotId/debits` | `saas-creative-debit` |
| POST | `/reservations/:reservationId/resolve` | `saas-creative-resolve` |
| POST | `/reservations/:reservationId/provider-cost` | `saas-creative-cost-record` |

The HQ list (`GET /`) returns one row per school (school and organization names, balance, consumed credits, actual provider cost, open unknown outcomes and unknown-cost generations).

School (`schools/:schoolId/creative-credits`):

| Method | Path | Command header |
|---|---|---|
| GET | `/` | – |
| POST | `/window` | `saas-creative-window-open` |
| POST | `/top-up-purchases` | `saas-creative-topup-purchase` |

Reserve and settle are service methods for the generation runtime only (as in B3). Contracts: `packages/contracts/src/saas-creative-wallet.ts` (closed inputs, closed responses; school views never contain provider identity, provider cost or HQ notes).

## Security boundary

All eleven tables (including `saas_creative_cost_events`) are forced-RLS, deny-all, owned by the migration owner, and reachable only through the listed SECURITY DEFINER functions (also granted in `infra/postgres/010_supabase_hon_runtime.sql`). Evidence tables are append-only (`saas_immutable`); the program, rate versions, wallets, reservations and purchases allow only their listed transitions (`guard_saas_creative`). The runtime cannot execute fulfillment or any internal helper. `saas-billing-security.mjs` tracks every new table, trigger and function.

## S4 relationship

CW1 is stacked on the S4 chain (#97 → #106 → #108 → #109 → #110 → #118 → #119 → #120 → #122). It writes `spend_class = 'CREATIVE_MEDIA'`, calls the S4-c spend decision before every new reservation and serializes with the S4 pause command. S4-b's organization budget lock is deliberately not taken (creative credits are not the agent budget). HQ per-school usage (S4-e, 0197) reports creative expense in its own class; the review regression found that 0197 failed outright when any non-agent row existed, fixed on #118 (`479a0fb`) and carried up the stack.

## Evidence

`packages/database/scripts/test-saas-creative-wallet-integrity.mjs` (in `run-db-proofs.sh`; `pnpm --filter @hon/database db:test-saas-creative-wallet`) runs the real API services against the disposable Champions fixture with two brand-new HON OS schools paid through simulated Stripe. It now uses school-owned wallets throughout. It covers the program and package posture, owner-only rates and activation, eligibility refusals, one grant under 8 concurrent opens, 8 concurrent 3,000-credit reservations against 12,000 (exactly 4 succeed), settlement and HQ resolution, provider expense separation, HQ grants and corrections, top-up intent and exactly-once fulfillment under 5 concurrent deliveries, consumption order, renewal and expiry, cross-school isolation, ledger-equals-balance, exact audit/outbox counts, immutability and the security verifier.

## Review corrections (revision 2)

| Finding | Correction | Regression (`test-saas-creative-wallet-review-regressions.mjs`, 0/5 before, 5/5 after) |
|---|---|---|
| P1-A sibling-school leakage | All reads filter by exact school before aggregation, sort and limit; rows carry `school_id` with composite FKs | Two ACTIVE schools in one organization with different balances, purchases, reservations and usage; the A2 staff view contains no A1 identifier |
| P1-B owner decision: per-school wallets | Wallet keyed by school; included lot unique per school and window; purchases, promotions and locks per school | Each school gets its own 12,000; A2 cannot spend A1's purchased credits; a held A1 wallet lock does not block A2 |
| P1-C S4 pause not enforced | `ai_spend_allowed(…, 'CREATIVE_MEDIA')` under the pause gate; settlement never blocked | Organization and platform pause refuse, resume allows; revoked staff grant and expired entitlement refuse new reservations while their in-flight results still settle; an agent-only pause does not stop creative; concurrent pause vs reserve serialize |
| P2-A spend class | `CREATIVE_MEDIA` on every creative usage row; HQ expense says so | Usage rows are CREATIVE_MEDIA with 0 customer credits; agent budget unchanged by creative spend; HQ per-school usage separates the classes across three schools |
| P2-B unknown cost erased | `cost_status`, immutable cost events, one late transition | FAILED with unknown cost stays UNKNOWN (lost response replays safely); 5 concurrent duplicate provider deliveries apply once; a different later event is review-only; HQ NOT_CHARGED without a guessed zero, then one evidenced cost record (a second is refused, a school owner is refused) |

## Not in CW1

Generation runtime and provider adapters, checkout creation and webhook wiring for top-ups, refunds/chargebacks of top-ups, UI (Codex), an HQ monitor for long-held reservations.
