# School subscription — Codex frontend foundation

Branch: `codex/school-subscription-foundation`. Base: merged main `ce93685`. Owner-authorized frontend only; no merge or deployment.

## Delivered boundary

`/staff/subscription` uses the unchanged signed-session staff layout. It offers real interactive Core/Complete comparison, three offer selections, review summary, reset-on-change acknowledgement, presentation density controls and an expandable keyboard-accessible local HON product guide. The guide is deterministic product guidance, not connected AI or voice. Selection and view are ephemeral component state, not persisted preferences or billing authority. No form/query/storage identity selectors, billing API calls or checkout commands exist in this foundation.

Prices and planned allowances come from the merged public catalog and `SAAS_OWNER_APPROVED_DRAFT`; capability inclusion comes from `SAAS_PLAN_CAPABILITIES`. These are display terms, not a published offer, verified inventory, live balance or activated functionality. Per-capability notes distinguish integration/AI availability. The founder limits 50/30/20 are program limits, never remaining inventory. Only Core and Complete and monthly/founder lifetime are selectable. Legacy Essential records are untouched.

Current subscription, verified school-purchaser permission, entitlement/access, remaining founder inventory/eligibility, live credit usage, school invoices and checkout are explicitly unavailable. All checkout controls remain disabled, including after acknowledgement or a forged `?success=true` URL. No card form, Stripe SDK, external provider call, payment or access activation. A verified sign-in is not verified purchase permission; no private account facts are displayed to any signed-in identity.

## B5 integration gate and coordination

Claude's #26 is unmerged at foundation start. No B5 types, endpoints or implementations are imported/copied. Coordination on #26 asks for verified purchaser/school context and school invoice history; #27/#3 record isolated ownership and append-only route/TODO changes. Backend, CRM/family billing, Classic, shared visual files, HQ and artwork remain unchanged. #21/#24 dependencies remain preserved. Language & Region remains a future shared requirement (#17), not implemented here.

After owner-approved B5 merges:

1. Rebase/synchronize safely with current main and inspect exact merged school contracts/validators and permission checks. Never integrate from an unmerged PR.
2. Establish exact current school via an authorized identity resolver; reporting-school context alone does not establish purchase permission. Never take school/organization scope from form/query/local storage. B5 independently requires `billing.hon.purchase` at the school and refuses HQ/family/support identities.
3. Load current school plan/subscription/offer/checkout with fixed no-store reads and closed validation, abort/scope-race protection and loading/empty/denied/error/stale states. Compare both plans, but B5 currently allows purchase only for the provisioned entitlement tier; no frontend upgrades or tier mutation.
4. Show backend-published offer IDs, exact price/currency/terms and inventory/eligibility; invalidate selection/acknowledgement on refreshed terms. No client billing/credit/ranking calculations.
5. Require explicit human confirmation; idempotent test checkout using merged command transport. Validate the authorized hosted test URL; never accept arbitrary return URL redirects. Handle pending/failed/canceled/expired and uncertain outcomes without unsafe retries. No card data in HON.
6. Refresh authoritative checkout/payment evidence after return, independent of success/cancel URL. Show provider-verification strength and test mode. Access is confirmed independently by entitlements; payment alone does not activate software.
7. Integrate actual allowance/usage/invoice reads only when independently school-authorized contracts exist; never use HQ endpoints or filter global history. Coordinate missing contracts with Claude.

## Launch blockers

- #26 approved and merged, then contracts/identity/invoice coverage verified against latest main.
- Stripe provider approval, securely configured test credentials/webhook and egress; #26 currently proves a simulator, not a real Stripe test account. No credentials/provider activation in this PR.
- Published terms/offer eligibility, final tax and cancellation/renewal/lifetime policies; draft display prices are not a final checkout quote.
- Self-service registration and backend paid-access/grace/suspension policy remain separate backend/owner work; no frontend can assert activation.
- Real test-account checkout/webhook verification, school-authorized invoices/payment and allowance evidence, full integrated error/permission/tenant tests required before calling purchasing operational.
- Live payments, refunds/reward fulfillment, production deployment and provider spending remain unauthorized.

## Verification

Results and actual application screenshot links will be recorded after checks complete. Local dependency installation uses unchanged lockfile and bounded attempts; CI is the supported fallback when cloud downloads are blocked. Browser fixtures use ephemeral correctly signed sessions against the real application, no auth bypass or customer data. This foundation has no school billing fixtures/API doubles because no billing service is called. Manual physical-device and screen-reader QA remains distinct from automated checks.
