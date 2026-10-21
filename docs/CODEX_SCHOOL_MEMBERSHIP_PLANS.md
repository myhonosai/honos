# Codex handoff: school membership plans

Backend: merged PR #45, main `c450e6de8406f45ab16208b57d6ac607f91f7512` (migration 0175). The original development branch was `claude/project-thread-vf7rij`, based on PR #44. Contracts live in `packages/contracts/src/school-membership-plans.ts` and are exported from `@hon/contracts`. Use the shared validators and verifiers; do not re-implement them. Backend design and owner decisions: [School membership plan catalog](architecture/SCHOOL_MEMBERSHIP_PLAN_CATALOG.md).

These are a school's own student membership plans, not HON's Core/Complete subscription. Never show HON SaaS prices or credits in these screens.

## Transport rules (all five routes)

Prefix: `/v1/organizations/:organizationId/schools/:schoolId/billing`. Always `POST` with a JSON body, same-origin `fetch`, and `X-HON-Human-Command` set to the route's exact marker. Send no query string and no other `X-HON-*` header. Commands require a fresh UUID `Idempotency-Key` per new command; reads must not send one. Bodies are closed: any extra field returns 400. Organization and school in the URL are selectors only; the server re-derives authority.

| Route | Marker | Key | Body | `data` |
| --- | --- | --- | --- | --- |
| `membership-plans/catalog` | `membership-plan-catalog-read` | none | `{}` | `MembershipPlanCatalog` — `{ plans: MembershipPlanListing[], programs: { programId, name }[] }` |
| `membership-plans` | `membership-plan-create` | required | `CreateMembershipPlanInput` | `MembershipPlanVersionSummary` (version 1) |
| `membership-plans/:planId/revisions` | `membership-plan-revise` | required | `ReviseMembershipPlanInput` (complete terms + `expectedVersion`) | `MembershipPlanVersionSummary` (next version) |
| `crm-adult-membership-drafts/plan-options` | `crm-adult-membership-plan-options` | none | `{}` | `CrmAdultMembershipPlanOptions` — AVAILABLE plans only |
| `crm-adult-membership-drafts/from-plan` | `crm-adult-membership-draft-from-plan` | required | `CrmAdultMembershipDraftFromPlanInput` | `CrmAdultMembershipDraftFromPlan` — `{ receipt, plan }` |

`meta` is `{ requestId, correlationId, replayed }`. `replayed: true` means the same key and input already succeeded, and the returned data is that historical result. Treat it as success, and say it was already recorded.

Verify every response with `verifyMembershipPlanCatalog`, `verifyMembershipPlanVersionSummary`, `verifyCrmAdultMembershipPlanOptions` or `verifyCrmAdultMembershipDraftFromPlan(data, input)`. A verifier failure means "unknown result": show no assumed state and offer only an explicit retry with the **same** key and input.

## 1. Catalog management (staff with `billing.membership_plan.manage`; initially school owners)

- Load the catalog only on an explicit staff action or page entry for an authorized school. No polling.
- List: display name, plan code, price (`priceMinor` in minor units, formatted with `currency` through the existing locale formatter), billing frequency, term, program name, availability, version and published time.
- Create form fields: `planCode` (upper-case letters, digits, `-` or `_`, up to 40, permanent: say it cannot be changed later), `displayName`, optional `description`, optional program (from `catalog.programs` only), `availability`, `currency`, price, `billingFrequency`, `termKind` and `termMonths`. Show the rules the validator enforces: `PAID_IN_FULL` needs a fixed term; an annual fixed term must be whole years. Use `MEMBERSHIP_PLAN_BILLING_FREQUENCIES` and `MEMBERSHIP_PLAN_TERM_KINDS`.
- Edit = revise. Pre-fill from the listing, always send the **complete** terms plus `expectedVersion: listing.version`, and the confirmation `MEMBERSHIP_PLAN_CHANGE_CONFIRMATION` after an explicit confirm step. That step states that a new version is published, and that existing memberships keep the terms they were created with.
- Hiding a plan from enrollment is a revision with `availability: 'UNAVAILABLE'`. There is no delete.
- Do not offer discount, fee, agreement, payment-start, renewal or tax fields. They are not supported, and the backend rejects them.

## 2. Plan picker in the adult DRAFT step

Replace the free-text plan code in the adult membership DRAFT step with a plan picker, on an explicit action after the existing preparation read succeeds:

1. Call `plan-options`. Show only returned plans. Disable, with a short reason, any plan whose `currency` differs from the preparation's `currency`.
2. Show the selected plan's full terms. If the plan is fixed term and staff enter a start date, preview the end date with `membershipPlanFixedTermEnd(termStartedAt, termMonths)`. Label it as a preview: the server derives the real one. There is no end-date input.
3. Send `{ studentProfileId, membershipPlanId, membershipPlanVersion: plan.version, termStartedAt?, confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION }` after explicit confirmation. Keep the immutable input and key for an exact retry.
4. On success, show the receipt and the plan version terms in `data.plan` as "created from", separately from any later current-DRAFT confirmation. The existing current-DRAFT confirmation and Resume setup (0163/0174) work unchanged and show the plan code only.

The existing free-text route stays available until the owner decides to retire it. Do not remove it from the UI before that decision. The plan picker should be the default when the school has any AVAILABLE plan.

## Errors

| Status / `code` | Show |
| --- | --- |
| 403 `MEMBERSHIP_PLAN_FORBIDDEN` / `CRM_ADULT_MEMBERSHIP_FORBIDDEN` | Access lost: clear the catalog or options and the panel |
| 409 `MEMBERSHIP_PLAN_VERSION_STALE` | "This plan changed since you loaded it." Reload the catalog or options and require a fresh review. Never auto-resend with the new version |
| 409 `MEMBERSHIP_PLAN_CODE_TAKEN` | The code is in use at this school; ask for another |
| 409 `MEMBERSHIP_PLAN_CURRENCY_MISMATCH` | The plan currency differs from the payer account; choose another plan |
| 409 `IDEMPOTENCY_KEY_REUSED` | A client bug: the key was reused with different input. Start a new command with a new key |
| 409 `MEMBERSHIP_PLAN_LIMIT` | The school has the maximum of 200 plans, or a plan has 1,000 versions |
| 409 `*_CONFLICT` | No change assumed; allow an explicit retry |
| 400 `MEMBERSHIP_PLAN_UNCHANGED` | Nothing changed; no new version |
| 400 `INVALID_*_INPUT` | Field validation (should be prevented client-side) |
| 404 `MEMBERSHIP_PLAN_UNAVAILABLE` / `MEMBERSHIP_PLAN_PROGRAM_UNAVAILABLE` | The plan or program is no longer offered; reload |
| 404 `CRM_ADULT_MEMBERSHIP_UNAVAILABLE` | The existing DRAFT unavailable handling (already drafted, account changed, …) |
| 503 / malformed | Unknown result; exact retry only |

## Boundaries

No frontend file, appearance, localization infrastructure or shared visual component was changed by this backend PR. Nothing here creates a schedule, invoice, payment method, charge, agreement, discount, communication or activation, and the UI must not imply that it does: label prices as "published price", not as a charge or a balance. No plan, receipt or key enters URLs, storage or telemetry. Guardian/child DRAFTs (PR #27) are out of scope.

## Frontend integration handoff (review branch)

`codex/school-membership-plans` adds `/staff/billing/membership-plans`, linked from CRM leads. Catalog management resolves the signed-in staff school through the existing reporting-school selectors, then independently authorized plan APIs. Multiple returned schools require explicit selection; an unresolved selector is unavailable, never an invitation to guess IDs. A role limited to plan management without an existing reporting-school selection path may require backend coordination; no new resolver or permissions are added here.

Creation and revision require a full terms review and explicit confirmation. Prices convert exactly from entered major units using the currency's minor-unit exponent, without rounding or FX. A publication receipt is historical evidence; a separate reload verifies the current catalog. Unknown outcomes retain the exact immutable request in memory for explicit retry. Stale versions require a fresh load and review. No background commands or persistence of private plan/receipt/key data are introduced.

The connected adult CRM flow now offers the published-plan picker after the existing preparation read. It uses the canonical account currency, the exact selected ID/version, an optional UTC term start and shared end-date preview. The separately disclosed legacy free-text option remains available. All six Resume Setup states and creator-only current-DRAFT confirmation are preserved. A fresh plan-bound creation displays its returned immutable terms; recovery and ordinary confirmation do **not** contain a historical plan binding, so the UI explicitly says original terms are unavailable there. A future authorized historical membership-plan read is needed for that display; matching the current catalog by code is unsafe.

Verification uses two distinct layers: actual production-build browser interaction with deterministic signed-session localhost API fixtures, and the actual frontend HTTP transport against real Nest guards/controllers/services and a marked disposable PostgreSQL database. The latter checks plan publication/revision, stale rollback, bound DRAFT creation, exact replay after later publication, immutable original price/version, permissions, school isolation, session denial, recovery compatibility and absence of schedule/invoice/payment effects. The existing full CI database security proofs remain unchanged. Screenshots stay in the private short-retention browser artifact; no public deployment or individual screenshot uploads.

New catalog/picker copy currently uses English fallback; shared locale-aware date and currency formatting and existing appearance/language preferences remain intact. This does not claim complete Korean or Spanish coverage. Historical policy decisions in the architecture document remain open. There is no guardian/child enrollment, agreement signing, activation, billing schedule, discount, tax, refund or payment action in this interface.
