# School Account & Usage — read-only frontend

This incremental Sprint 3 slice starts from owner-experience `5cc4133d2d9c0119011e46f4c471d8eadd43cc88` (tree `6f44776dbcfb4f6009bc01a57e9831d7b9c01815`) and is intended to stack on PR #143. It does not author API, contract, database, infrastructure or commercial-policy changes. The superseded `/staff/subscription` surface is neither changed nor linked.

## Accepted read boundary

`/staff/account-status` is session-protected and no-index. Known school UUID entry is sufficient. An optional organization UUID adds an equality constraint; it never grants authority. Closed URL prefills permit only one school and optional organization, with no duplicates, extra record/token fields or automatic read. No billing-recovery school discovery contract exists, so the page says that a named school picker is unavailable rather than borrowing reporting authority.

| Explicit read | Accepted API | Canonical validator |
| --- | --- | --- |
| Organization billing account | `GET /api/v1/schools/:schoolId/hon-billing` | `validateSaasSchoolBillingAccount` |
| Access standing | `GET /api/v1/schools/:schoolId/hon-billing/access-standing` | `validateSaasSchoolAccessStanding` |
| Separate school creative wallet | `GET /api/v1/schools/:schoolId/creative-credits` | `validateSaasCreativeSchoolWallet` |

Billing reads require the exact school's `billing.hon.view` and independently authorize the caller through the existing domain boundary. They deliberately permit an entitlement that is suspended or lapsed. The wallet read requires its own `ai.premium.request` and effective active access, and may therefore return 403 while billing remains readable. Each card settles independently; a wallet or standing refusal cannot suppress a valid account card. An identity failure clears every card.

Every response is fully validated before a minimal display projection is retained. Account and standing must match the requested school, and the optional organization when supplied. Their authoritative returned organizations must also agree with each other; conflicting observations clear both billing cards. The wallet response contains only school scope and cannot verify an organization selector. Account labels use the organization returned by billing, never one inferred from the wallet or a form field.

## Truthful account and usage display

The account shows recorded entitlement effectiveness, account readiness/alignment, subscription source and service dates, and recorded payment standing/evidence strength. Provider verification mode remains explicit (`NOT_CONFIGURED` or `TEST_MODE`); a recorded payment never creates access readiness. Historical catalog/legacy sources are record labels, not new offers. Prices, offers, founder promotions, invoice/refund details, legacy allowance figures, rates and top-up packages are removed from retained frontend state.

Access standing shows server-returned dates and the literal proposed-policy provenance. This page does not calculate or enforce grace, suspension, owner read-only periods or recovery. `billingRecoveryOpen` means the read remains available, not that a checkout or collection integration is connected.

The creative wallet shows its returned program status, eligibility/reason/window, available and held credits and category-level recorded grants/consumption. It never treats the static 12,000 program figure as a grant. No window-opening, purchase, grant, reservation, generation, provider or other mutation is exposed. AI-team conversations do not deduct creative credits. The legacy mixed-spend `ai/usage` route is omitted; a current school-specific AI-team budget report is explicitly unavailable, with no invented zero or balance.

## Session, school and privacy lifecycle

Only fixed native same-origin GETs are sent, with credentials same-origin, request no-store, no-referrer, redirects rejected, bounded UTF-8 JSON and closed `{data}` envelopes. No actor, scope, permission, command or manually forged Origin header is sent. Original-subject checks bracket every domain read, including denied/error responses. A current 401 uses the existing shared invalidation signal; a retired late 401 is ignored before broadcasting. A domain 403 stays card-local only after the original subject is verified again.

Blur, hidden visibility, pagehide, shared session/school events and unmount synchronously hide/inert the private form and retire reads. Facts and selectors clear; a privacy epoch remounts the private form only on concealment, preserving ordinary input focus. Privacy restoration checks identity only and reopens blank selectors; domain reads remain explicit. SESSION and IDENTITY are terminal for the mount and require a fresh authenticated page. Scope edits and stale handlers cannot display another school's late response. Layout/language changes perform no domain reads.

Modern, Classic and Big Button presentation, EN/KO/ES copy, keyboard-native controls, persistent polite status, labeled fields and accessible ledger tables use isolated styling. Protected assets and shared visual sources remain unchanged. Verified operational navigation carries only inert org/school selectors. Fixed recovery links on School Entry and Access Not Verified use literal `/staff/account-status` without retained selectors and do not depend on reporting access.

## Verification status

Executed locally on the application source at `c5c267d0ffd2dcb193d0fb131b599cf239bc92a5`: all six workspace package TypeScript builds, web TypeScript and Next production build pass. The final frontend test additions pass 85 focused cases in nine files (including 54 new account cases), and the complete web suite passes 1,844 tests in 180 files. All 200 migration checksums and API/packages/infra source equivalence to the base pass. The full suite caught the older access-notice navigation inventory missing the new fixed recovery link; the exact expected route list was updated. A noncanonical synthetic wallet timestamp was corrected in the test fixture; the canonical parser remains unchanged.

Validation reused cached dependencies under Node `24.19.0`, TypeScript `5.9.3`, Vitest `3.2.7` and Next `15.5.28`; no installation or local listener was attempted. Pinned Node `22.23.4` repository and real signed-session API/disposable PostgreSQL/native-browser verification remain hosted gates. The separate proof workstream owns the new account-status harness; no local database/browser pass or owner-environment acceptance is claimed here. Independent source/contract/privacy review found no remaining blocker; that is source review, not executed integration evidence.

No push, CI dispatch, workflow change, PR metadata update, deployment, communication, provider invocation, payment or credit activation occurs in this slice.
