# HQ Plan builder and creative program switch (frontend only)

**Status:** source change. No migration, no API change, nothing deployed.

## Plan builder (`/hq/pricing-offers`, tab "Plan builder")
A GoHighLevel SaaS Configurator style step editor over the existing HON OS offer set (0181):
Offer type (Regular plan, or Free trial which opens `/hq/revenue/trials`) -> Pricing (monthly, yearly with savings hint,
lifetime, founder monthly/yearly/lifetime, founder and lifetime spots) -> What's included (the HON OS capability list)
-> AI & credits (planned monthly creative credits, quick picks 5,000 / 12,000 / 20,000) -> Terms (refund days, who can
buy, sales window, terms link) -> Review (Save, then the existing server review and digest-confirmed publish).
A live "What schools will see" card follows every step.

- `pricing-plan-builder-model.ts` maps a `PlanDraft` to and from the same local `OfferSetForm`; the form stays the only
  source of truth. `PricingController.applyPlan` only rewrites the local form. Save, review, publish and stop-sales are
  unchanged server-checked commands. Existing options keep key and offer code, so a revision edits them in place.
- Defaults are applied only when HQ presses "Regular plan": $249 / $2,097, 12,000 credits, 30-day refund,
  `https://myhonos.com/terms/`. Founder options use price lock "while continuously subscribed"; annual renews at the
  locked price; recurring options cancel at the end of the paid period; lifetime has no recurring terms and uses the
  terms link as its fair-use reference.
- The old per-option editor stays under a collapsed "Advanced" section.
- The pricing page no longer hides itself on window blur or a hidden tab (David, 2026-11-26). A 401/403 still conceals.

Not in this change: per-plan feature selection (David chose it on 2026-11-26; needs migration 0697 so a set can hold
several plans with their own capability lists, then enforcement at school access).

## Creative credit program switch (`/hq/revenue/creative-credits`)
`ProgramControls` adds HQ-owner buttons using the existing 0202 commands: "Publish credit prices" (the rates David
approved on 2026-11-14: image 10, video 20/s, avatar 10, avatar video 15/s, photo video 8/s) and "Turn on" / "Turn off"
(`saas-creative-program`, with the read version). Each asks for confirmation first, sends one idempotency key, and an
unknown outcome offers Try again with the same key. Top-up purchases stay unconnected (live payments need separate approval).
