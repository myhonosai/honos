# HQ Plan builder, plans with their own features, and creative program switch

**Status:** source change, nothing deployed. Piece 1 (PR #672) was frontend only; piece 2 adds migration 0697.

## Plan builder (`/hq/pricing-offers`, tab "Plan builder")
A GoHighLevel SaaS Configurator style step editor over the existing HON OS offer set (0181):
Offer type (Regular plan, or Free trial which opens `/hq/revenue/trials`) -> Pricing (monthly, yearly with savings hint,
lifetime, founder monthly/yearly/lifetime, founder and lifetime spots) -> What's included (the HON OS capability list)
-> AI & credits (planned monthly creative credits, quick picks 5,000 / 12,000 / 20,000) -> Terms (refund days, who can
buy, sales window, terms link) -> Review (Save, then the existing server review and digest-confirmed publish).
A live "What schools will see" card follows every step.

- `pricing-plan-builder-model.ts` maps a `PlansDraft` (plans plus shared terms) to and from the same local `OfferSetForm`; the form stays the only
  source of truth. `PricingController.applyPlans` only rewrites the local form. Save, review, publish and stop-sales are
  unchanged server-checked commands. Existing options keep key and offer code, so a revision edits them in place.
- Defaults are applied only when HQ presses "Regular plan": $249 / $2,097, 12,000 credits, 30-day refund,
  `https://myhonos.com/terms/`. Founder options use price lock "while continuously subscribed"; annual renews at the
  locked price; recurring options cancel at the end of the paid period; lifetime has no recurring terms and uses the
  terms link as its fair-use reference.
- The old per-option editor stays under a collapsed "Advanced" section.
- The pricing page no longer hides itself on window blur or a hidden tab (David, 2026-11-26). A 401/403 still conceals.

## Plans with their own features (migration 0697, piece 2)
David chose "Let me pick features per plan" (2026-11-26). An offer set can now hold several plans:
- **Database (0697).** `hon.saas_offer_set_offers.capabilities text[]`: a non-empty subset of the HON OS (COMPLETE)
  capability policy, stored in canonical policy order. Existing offers (published and retired too) get the full list from
  the column default; no row is updated, so the 0181 immutability guard and every published price are untouched.
  `saas_offer_json` reports `capabilities`, so the preview digest HQ approves covers the feature lists.
  `saas_offer_set_content_valid` accepts an optional `capabilities` per offer (absent = full list) and requires the same
  list for offers that share a display name; `saas_offer_set_write_content` stores it through the private helper
  `saas_offer_input_capabilities(jsonb)`.
- **A plan = the offers that share a display name.** Each plan has its own name, prices, lifetime spots, planned
  credits and feature checklist. Refund days, who can buy, sales window, terms link and the founder pool are shared.
  Up to 6 plans and 12 prices in all.
- **Contracts.** `HON_OS_PLAN_CAPABILITIES`, `saasHonOsPlanCapabilities()`; offer input `capabilities` optional, offer
  responses (HQ and school reads) always carry it. Accepted-offer snapshots from before 0697 validate with the full list.
- **Builder.** Plan tabs with "Add a plan" / "Remove"; "What's included" is a checklist (School system, AI team and AI
  marketing) with "Include everything" and "School system only"; the preview and Review list each plan's features.

Not in this change (each a separate reviewed change):
- **Enforcement.** Nothing locks a feature yet; every school can still use everything. Piece 3 stores the purchased or
  assigned plan's capability snapshot on the school and checks it (owner question: locked + Upgrade, or hidden).
- **Per-plan checkout.** Purchase code is unchanged. Its price acceptance (0188/0279/0306) needs exactly one regular
  monthly price per set, so while two plans are published, recurring price acceptance would be refused
  (`SAAS_PRICE_TERMS_UNSUPPORTED`). Paid access is INACTIVE; HQ can assign any published offer (0676). Changing that touches
  founder billing and needs David's approval.

## Creative credit program switch (`/hq/revenue/creative-credits`)
`ProgramControls` adds HQ-owner buttons using the existing 0202 commands: "Publish credit prices" (the rates David
approved on 2026-11-14: image 10, video 20/s, avatar 10, avatar video 15/s, photo video 8/s) and "Turn on" / "Turn off"
(`saas-creative-program`, with the read version). Each asks for confirmation first, sends one idempotency key, and an
unknown outcome offers Try again with the same key. Top-up purchases stay unconnected (live payments need separate approval).
