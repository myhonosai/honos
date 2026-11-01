# HON OS commercial offers: HQ Pricing & Offers (migration 0181)

Status: **merged (PR #61, `501f396`), not deployed, not applied to any persistent database.** Nothing in 0181 charges, opens a checkout, grants AI credits, changes an entitlement, or reprices an existing subscription. Test-mode purchasing of these offers is added by 0182, see [HON_OS_PURCHASE_BINDING.md](HON_OS_PURCHASE_BINDING.md); where the two documents differ on the school view, management view or purchase status, 0182 is current.

## Why this exists

The owner moved HON to one customer-facing product, **HON OS**, sold through several payment offers whose prices must be changeable from HQ without new code. The legacy B1 catalog (0154) cannot express this: it requires exactly one Core and one Complete regular monthly offer, has no annual or non-founder lifetime offers, and its Core/Complete records are pinned by legacy allowances (0156), founder inventory, B6A and eight DB proofs. Rewriting it would break history, so 0181 adds a **separate, versioned HON OS offer control plane** beside it and leaves 0154 untouched.

Migration numbering: 0179 is reserved for E1b-2 and 0180 for E1c, so this uses **0181**. `main` held 0178 as the newest migration when the branch was cut.

## Model

| Concept | Where | Rule |
|---|---|---|
| Product | `hon.saas_hon_os_product_json()`, `HON_OS_PRODUCT` | One product, `HON_OS`, capability policy v1 = the COMPLETE entitlement capability list. `legacyTiersForNewSale: false`. A capability listed is a policy, not a readiness claim. |
| Offer set | `hon.saas_offer_sets` | Versioned (`set_version` 1, 2, …). `DRAFT → PUBLISHED → RETIRED`, or `DRAFT → DISCARDED`. At most one `PUBLISHED`. `charges_enabled` and `credit_grants_enabled` are pinned `false` by CHECK. |
| Offer | `hon.saas_offer_set_offers` | 1–12 per set, each with its own UUID and a stable `offerCode`. Rows can be inserted or deleted only while their set is a `DRAFT`, and are **never updated**. A published offer is therefore an immutable snapshot of its price and terms. |
| Sales stop | `hon.saas_offer_sales_stops` | Append-only. Stops future sales of one published offer. Never changes its price. |

### Offer kinds (all HQ-priced, none hard-coded)

`REGULAR_MONTHLY`, `REGULAR_ANNUAL`, `FOUNDER_MONTHLY`, `FOUNDER_ANNUAL`, `LIFETIME`, `FOUNDER_LIFETIME`. Billing interval (`MONTHLY` / `ANNUAL` / `ONE_TIME`) and `founder` are derived by the server from the kind, never accepted from a client.

### Per-offer terms the owner sets

- `priceMinor` (USD cents, 100 – 10,000,000), `displayName`
- `salesOpensAt` / `salesClosesAt` (promotional or founder window; `salesOpensAt: null` means published but not on sale)
- `eligibility`: `ANY_ACTIVE_ORGANIZATION` or `NEW_ORGANIZATIONS_ONLY`
- `saleLimit` (per-offer inventory) and, on the set, `founderTotalLimit` (founder pool across the set's founder offers)
- `priceLock`: `NONE`, `WHILE_CONTINUOUSLY_SUBSCRIBED`, or `FIXED_MONTHS` + `priceLockMonths`
- `annualRenewal` (annual offers only): `AUTO_RENEW_AT_LOCKED_PRICE`, `AUTO_RENEW_AT_CURRENT_PRICE`, `NO_AUTO_RENEWAL`
- `plannedMonthlyPremiumCredits` (**planning only**, reported as `PLANNING_ONLY_NOT_A_CREDIT_GRANT`) and `aiFairUseReference` (required for lifetime kinds)
- `refundWindowDays` (0–365) and `cancellationTiming` (`END_OF_PAID_PERIOD`, recurring kinds only)
- On the set: `termsReference` (the owner's terms document reference)

Consistency rules enforced identically by the contract and the database: lifetime offers have no price lock or cancellation timing; annual offers must state a renewal term and others must not; `FIXED_MONTHS` if and only if `priceLockMonths`; closing time after opening time; unique offer codes.

### Preview and publication

`hon.saas_offer_set_preview(set)` is computed by the server for every read and command receipt:

- **Quotes** per offer: monthly equivalent, annual savings against the first regular monthly offer, lifetime break-even months, founder discount against its regular counterpart.
- **Readiness issues** that block publishing: `TERMS_REFERENCE_REQUIRED`, `OFFER_REQUIRED`, `FOUNDER_LIMIT_REQUIRED`, `REFUND_WINDOW_REQUIRED`, `CANCELLATION_TIMING_REQUIRED`, `LIFETIME_FAIR_USE_REQUIRED`, `LIFETIME_SALE_LIMIT_REQUIRED`.
- `effect: NEW_PURCHASES_ONLY`, `existingSubscriptionsRepriced: false`.
- `previewDigest`: SHA-256 of the set id, revision, terms, founder limit and every commercial field of every offer.

Publishing requires `{expectedRevision, previewDigest, approval: "APPROVE_FOR_NEW_PURCHASES_ONLY"}`. The server recomputes the digest and refuses with `SAAS_OFFER_PREVIEW_CHANGED` if anything differs from what the owner previewed, and `SAAS_OFFER_SET_NOT_READY` if issues remain. Publishing retires the previous published set in the same transaction. The approved digest is stored on the set.

**Price changes affect new purchases only**: a new price is a new set version with new offer IDs. Retired sets keep their exact offers, prices, terms and stop history, readable from HQ history.

## Authority

| Action | Who | Function |
|---|---|---|
| Read management view, read one set + preview | HQ owner, or HQ operator with `hq.billing.manage` | `read_saas_offer_management_from_hq`, `read_saas_offer_set_from_hq` |
| Create / revise / discard draft, publish, stop sales | **HQ owner only** (identity locked and rechecked) | `create_saas_offer_set_draft`, `revise_…`, `discard_…`, `publish_saas_offer_set`, `stop_saas_offer_sales` |
| See on-sale offers for a school | Staff with `billing.hon.purchase` at that exact school | `read_saas_hon_os_offers_for_school` |

Every command is idempotent (`saas_claim_request`; same key + different body → `IDEMPOTENCY_KEY_REUSED`), serialized by an advisory lock, and writes one `saas_audit` row plus one `saas_outbox` event (`saas.offers.drafted|revised|discarded|published|sales_stopped`). Tables use forced RLS with no runtime grants; only the 8 entry points are executable by `hon_runtime` (`infra/postgres/010_supabase_hon_runtime.sql` reconciles them exactly).

The school read is on the B6A **open-by-design** list (billing recovery), like the existing plan-options read, so a suspended school can still see what it may buy.

## HTTP API (for the HQ Pricing & Offers screen, issue #60)

All responses are `{ data }`. Reads are GET with no query or body. Commands are POST with the same-origin human-command header and an `Idempotency-Key` UUID, exactly like the existing SaaS billing routes.

| Method / path | Human command header | Body | Response |
|---|---|---|---|
| `GET /v1/hq/saas/offers` | – | – | `SaasHonOsOfferManagementView` |
| `GET /v1/hq/saas/offers/sets/:setId` | – | – | `SaasHonOsOfferSetDetail` (`set`, `preview`) |
| `POST /v1/hq/saas/offers/sets` | `saas-offer-set-draft` | `{basedOnSetId, termsReference, founderTotalLimit, offers[]}` | `SaasHonOsOfferSetReceipt` |
| `POST /v1/hq/saas/offers/sets/:setId/revise` | `saas-offer-set-revise` | `{expectedRevision, termsReference, founderTotalLimit, offers[]}` (full replacement) | `SaasHonOsOfferSetReceipt` |
| `POST /v1/hq/saas/offers/sets/:setId/discard` | `saas-offer-set-discard` | `{expectedRevision}` | `SaasHonOsOfferSetDiscardReceipt` |
| `POST /v1/hq/saas/offers/sets/:setId/publish` | `saas-offer-set-publish` | `{expectedRevision, previewDigest, approval}` | `SaasHonOsOfferSetPublishReceipt` |
| `POST /v1/hq/saas/offers/:offerId/stop-sales` | `saas-offer-sales-stop` | `{reasonCode}` (`OWNER_DISABLED`, `PRICE_CHANGE_PENDING`, `TERMS_REVIEW`) | `SaasHonOsOfferStopSalesReceipt` |
| `GET /v1/schools/:schoolId/hon-os-offers` | – | – | `SaasHonOsSchoolOfferView` |

Error codes: `SAAS_FORBIDDEN` (403), `SAAS_UNAVAILABLE` (404), `SAAS_VERSION_CONFLICT` / `SAAS_OFFER_SET_NOT_DRAFT` / `IDEMPOTENCY_KEY_REUSED` (409), `SAAS_OFFER_PREVIEW_CHANGED` / `SAAS_OFFER_SET_NOT_READY` / `SAAS_OFFER_NOT_PUBLISHED` / `SAAS_OFFER_SALES_ALREADY_STOPPED` (422), `INVALID_SAAS_INPUT` (400). Contract types and validators are in `packages/contracts/src/saas-offers.ts`.

### Frontend notes for Codex (#60)

- To "edit" a published offer, create a draft with `basedOnSetId` = the published set, prefilled from it, then preview and publish. Do not present editing a published price in place; the server refuses it.
- Show the server preview (`quotes`, `issues`) and send back exactly `preview.previewDigest` and `set.revision`. Never compute or send a price for publication.
- `SAAS_OFFER_PREVIEW_CHANGED` means the draft changed after the owner looked at it: reload and re-preview.
- `honOsSales` (0182) lists test-mode HON OS sales per offer and the founder pool; see the purchase-binding document. `legacySales` are real legacy Core/Complete aggregates.
- `premiumCreditsStatus: PLANNING_ONLY_NOT_A_CREDIT_GRANT` must be shown as planning text, not as an allowance.
- The school view's `purchase` and `eligibility` values changed in 0182 (`TEST_MODE`/`UNAVAILABLE`, founder offers self-serve); see the purchase-binding document. Eligibility values are server decisions; display them, do not re-derive them.
- Operators with `hq.billing.manage` can read but every command is owner-only; hide or disable command controls for them and still handle 403.

## What is deliberately not in this change

1. **Purchase binding.** Added separately by 0182 ([HON_OS_PURCHASE_BINDING.md](HON_OS_PURCHASE_BINDING.md)). The legacy checkout and subscription record paths still refuse HON OS offer IDs with `SAAS_OFFER_NOT_AVAILABLE`; the B6A awaiting path is still unchanged.
2. **Legacy catalog changes.** 0154 publication rules, `SAAS_OWNER_APPROVED_DRAFT`, legacy allowances and founder inventory are unchanged. Legacy Core/Complete schools keep their records and prices.
3. **Public (unauthenticated) pricing read** for the marketing site.
4. **HON OS sales performance**, which needs purchase binding first.
5. **Stripe product labels** ("HON Core" / "HON Complete") in `saas-payments.service.ts` are unchanged.
6. **HQ provisioning default** (`initialTier`) is unchanged.

## Evidence

- `packages/database/scripts/test-saas-hon-os-offers-integrity.mjs` (disposable DB): six HQ-priced kinds; operator/support/school refused for commands; idempotency; revision conflicts; preview quotes and readiness; publish only with the exact digest; published offers immutable (UPDATE/DELETE/INSERT/TRUNCATE refused even for the migration owner); stop sales; new version gets new offer IDs and retires the old set intact; concurrent publishes leave one published set; exact-school discovery and eligibility; legacy path refuses HON OS offer IDs; legacy catalog, subscriptions, founder records, entitlements, payments, credits and paid access unchanged.
- `apps/api/test/saas-offers.test.cjs`: contract validators, closed response validation, HTTP guards and wiring, error mapping.
- Existing B1–B6A proofs and the entitlement coverage proof pass with 0181 applied.
