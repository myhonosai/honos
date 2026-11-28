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
- **A plan = the offers that share a display name** (in the database). The builder tracks a local `planKey` per offer, so a plan stays separate while its name is being typed, even through another plan's name. Each plan has its own name, prices, lifetime spots, planned
  credits and feature checklist. Refund days, who can buy, sales window, terms link and the founder pool are shared.
  Up to 6 plans and 12 prices in all.
- **Contracts.** `HON_OS_PLAN_CAPABILITIES`, `saasHonOsPlanCapabilities()`; offer input `capabilities` optional, offer
  responses (HQ and school reads) always carry it. Accepted-offer snapshots from before 0697 validate with the full list.
- **Builder.** Plan tabs with "Add a plan" / "Remove"; "What's included" is a checklist (School system, AI team and AI
  marketing) with "Include everything" and "School system only"; the preview and Review list each plan's features.

Not in this change (each a separate reviewed change):
- **Enforcement.** Piece 3 (below) shows left-out features locked with an Upgrade button.
- **Per-plan checkout.** Purchase code is unchanged. Its price acceptance (0188/0279/0306) needs exactly one regular
  monthly price per set, so while two plans are published, recurring price acceptance would be refused
  (`SAAS_PRICE_TERMS_UNSUPPORTED`). Paid access is INACTIVE; HQ can assign any published offer (0676). Changing that touches
  founder billing and needs David's approval.

## Piece 3: locked features in the school app (0699)
Owner decision 2026-11-26: a feature the school's plan leaves out is shown **locked, with an Upgrade button** (not hidden).
- **Which plan.** The school's plan is its current HQ plan assignment (0676). With a published offer assigned, the plan's
  features are that offer's capability list (0697) and the rest are locked. No assignment, a removed one, or a custom
  plan locks nothing, so no school loses a page it uses today. The entitlement tier is not consulted.
- **Database.** Private `hon.school_plan_features(org, school)` and one runtime read `hon.read_school_plan_features(subject,
  school)` for any eligible staff member of the exact school (`staff_member_eligible`, so HQ during a logged 0696 visit too;
  family logins refused). Returns `source` (OFFER/CUSTOM/NONE), `planName`, `included`, `locked` in policy order.
- **API.** `GET /api/v1/schools/:schoolId/plan-features`, validated by `validateSaasSchoolPlanFeatures`.
- **School app.** The shell reads it once the school is verified. Menu pages mapped to a locked feature
  (`PLAN_FEATURE_FOR_PAGE` in `school-shell/plan-features.tsx`) show a lock; opening one shows "X is not in your plan" with an
  **Upgrade** button to `/staff/subscription`, and the page itself never loads. Dashboard, Staff, Texts, Email, Parent app,
  Calls, Shopify, Reports and Settings never lock. If the read fails, nothing is locked.
- **Mapping.** AI Team and Conversation AI = `ai.workforce`; Ask HON = `assistant.ordinary`; contacts, leads, automations =
  CRM; calendar, attendance = classes; membership, checkout, POS, invoices = memberships and payments; ranks, tests,
  promotions = testing and curriculum; marketing, website, social = manual marketing; ads = marketing connections; Creative
  Studio = `ai.premium_metered`; Community = Champions Club.

Server refusal came in piece 4 (below). Reconciling the accepted-offer `planCode` is still separate.

## Piece 4: the server refuses locked features (no migration)
Owner decision 2026-11-28 ("Those should be both true"): a locked feature is refused by the server too, and later the
Upgrade button subscribes the school to the regular plan, which lifts the locks (piece 5).
- **Where.** `SchoolPlanFeatureInterceptor` (`apps/api/src/saas-billing/school-plan-feature.interceptor.ts`) is registered
  app-wide and runs after each route's own guards. It finds the route's template (controller path + handler path), looks up
  its feature with `schoolPlanFeatureForRoute` (`SCHOOL_PLAN_FEATURE_API_AREAS` in `@hon/contracts`), reads the 0699 plan
  features for the signed-in person and the route's `:schoolId`, and answers **403 `PLAN_FEATURE_LOCKED`** (with the
  capability) before the handler runs when the plan leaves that feature out.
- **Only ever refuses.** Anyone the plan read does not recognise as staff of that school (parent, other school, unknown
  school, no session) passes to the route's own authorization unchanged. Any other failure of the plan read answers 503,
  so a locked feature never slips through on an outage.
- **Areas.** `ai.workforce`: AI team, agent voice settings and agent speech clips (HON's own clips count as HON), Alex, Chad (including the Action Center
  Chad send preview, `GET chad-send`), Claire, Jordan, Marcus, Maya, Conversation AI, Kai journal. `assistant.ordinary`: HON. Manual marketing: website, blasts, social posts. Marketing connections: social ads.
  `ai.premium_metered`: Creative Studio, except a person's own likeness photos (always viewable and deletable). Champions
  Club. Testing and curriculum: tests and curricula.
- **Never refused.** People, CRM, schedule, billing, payments, reports, settings, staff, texts and email are shared by the
  Dashboard, Calendar and Reports, so their locks stay display only. The HON OS purchase, subscription, plan-features and
  promotion routes are never locked, so the Upgrade path always works. A route test inventories every controller in
  `AppModule` to hold this.
- **Not covered yet.** Staff routes that take the school from the body or query (`staff/leads/assistant` Chad lead
  assistant, `staff/teaching-assistant` Kai, `staff/testing/certificates|scorecards|registrations`) and `staff/voice`, which
  serves HON and the agents alike. The route test pins this list and every `:schoolId` route outside
  `schools/:schoolId/`, so a new one fails until it is reviewed. Background work that is not an HTTP request, for example an
  AI message staff approved before the lock, is not stopped either. Approving an existing Chad draft in the Action Center
  (`POST .../decision`) still sends it. Pages outside the menu
  that call a locked area show their usual error.

## Piece 5a: subscribing lifts the locks (0707, test mode only)

David, 2026-11-28: "It should be limited but opens up when they opt in to regular subscription." The purchase path is the
0230 schedule binding (HQ records a price schedule, the school previews and accepts it, then starts the binding). In
production the schedule provider is unconfigured, so starting a binding answers 503 until a payment adapter is approved.
- **Paid plan first.** `hon.school_plan_features` now checks the organization's access first: when it is
  `PAYMENT_ACTIVATED` (0235: a verified first payment on an ACTIVE schedule binding, or an IN_SERVICE 0182 checkout
  subscription) the paid offer's capability list decides, with source `SUBSCRIPTION`. Otherwise the 0699 rule is unchanged
  (HQ assignment; none, custom or removed locks nothing). Awaiting payment or a lapsed window falls back to it.
- **Per-plan checkout terms.** `hon.saas_price_content` (0306 body) takes the regular monthly price, and a founder offer's
  standard price, from the offer's own plan (offers sharing a display name, 0697) when that plan has one, else from the
  whole set as before. Every set that worked before gives the same terms and digests, so recorded schedules and acceptances
  are unchanged; a set with several plans now works per plan (a capability only; the offer stays one HON OS plan at $249/mo or $2,097/yr).
- **School reads its terms.** `GET schools/:schoolId/hon-os-price-schedules` (`hon.read_saas_school_price_schedules`,
  billing.hon.purchase of the exact school, open to a suspended school as billing recovery) lists the latest schedule of
  each offer of the published set: offer id, schedule id and version only. The page then previews and accepts through the
  existing 0230 endpoints.
- Nothing here charges, starts a provider call, or turns on paid access; the paid-access program stays INACTIVE.

## Piece 5b: the Subscribe and checkout-terms screens (no migration)

- **HQ, Pricing & Offers overview, "Checkout terms".** For each published HON OS price (regular and founder, monthly and
  annual, not stopped) the HQ owner presses "Prepare checkout terms", which runs the existing `hq/saas/price-schedules`
  record command (expected version 0, one idempotency key, retried with the same key after an unknown outcome). A 409 means
  terms already exist for that price. It records terms only.
- **School, `/staff/subscription#subscribe`.** The plan lock's Upgrade button lands here. The owner picks a price that has
  terms, reviews the exact disclosure (preview), ticks agreement, and presses Subscribe. HON then sends accept, subscription
  intent and schedule start, each with its own key kept for retries. When the payment program is not in test mode the
  section says subscribing is not available and sends nothing, so no agreement is recorded that a later real subscription
  would trip over (one acceptance per school per schedule). A 503 from the schedule provider shows the same message. Locks
  lift only after a verified first payment (5a).

## Creative credit program switch (`/hq/revenue/creative-credits`)
`ProgramControls` adds HQ-owner buttons using the existing 0202 commands: "Publish credit prices" (the rates David
approved on 2026-11-14: image 10, video 20/s, avatar 10, avatar video 15/s, photo video 8/s) and "Turn on" / "Turn off"
(`saas-creative-program`, with the read version). Each asks for confirmation first, sends one idempotency key, and an
unknown outcome offers Try again with the same key. Top-up purchases stay unconnected (live payments need separate approval).
