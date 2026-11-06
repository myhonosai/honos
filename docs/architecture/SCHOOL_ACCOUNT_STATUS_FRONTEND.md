# School Account & Usage — read-only frontend

This incremental Sprint 3 slice is reconciled against accepted main `685e23ef43cd9a1f16333d144d5bf05f6a90822d`, containing merged #143 and #147. Its application code and original wallet assertions are unchanged from reviewed #146 `88c581557a90142bc2a02f1046b29709d12767ec`; the final #143 family retry receipt barrier is preserved. There is no API, contract, database, infrastructure or commercial-policy delta against main. The superseded `/staff/subscription` surface is neither changed nor linked.

## Current integration checkpoint

#147's additive 0209 correction is accepted on main. Both original wallet-positive assertions passed unchanged on the earlier explicit dependency composition in [42128265348](https://github.com/myhonosai/honos/actions/runs/42128265348): actual signed-session wallet GET200 with canonical validation and native mounted wallet GET200/display. That run passed both jobs, 2,992 workspace tests, typecheck/build/201 hashes and 27 mounted language/mode/viewport cases with no HON business writes. [Manus closed the prior validation blocker](https://github.com/myhonosai/honos/pull/146#issuecomment-6677019780).

Those are historical exact-composition results, not fresh execution on this reconciliation. The final candidate must complete its own integrated four-job verification and Account & Usage API/browser job, followed by focused independent review and owner merge approval. All 201 accepted migration files/checksums are preserved, including 0202. No dummy subscription, grant, relaxed validator or replacement positive assertion is used. The failures below remain historical evidence, not current backend blockers.

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

## Historical verification evidence

Executed locally on the application source at `c5c267d0ffd2dcb193d0fb131b599cf239bc92a5`: all six workspace package TypeScript builds, web TypeScript and Next production build pass. The final frontend test additions pass 85 focused cases in nine files (including 54 new account cases), and the complete web suite passes 1,844 tests in 180 files. All 200 migration checksums and API/packages/infra source equivalence to the base pass. The full suite caught the older access-notice navigation inventory missing the new fixed recovery link; the exact expected route list was updated. A noncanonical synthetic wallet timestamp was corrected in the test fixture; the canonical parser remains unchanged.

Validation reused cached dependencies under Node `24.19.0`, TypeScript `5.9.3`, Vitest `3.2.7` and Next `15.5.28`; no installation or local listener was attempted. Independent source/contract/privacy review found no remaining frontend blocker; that is distinct from executed integration evidence.

Hosted application/proof head `dac9b15c1703851218fab76988941e241e3effba`, [run 42087632292](https://github.com/myhonosai/honos/actions/runs/42087632292), uses pinned Node `22.23.4`. Repository verification passed **2,984 workspace tests** (1,844 web, 101 auth, 421 domain, 618 API), three additional fixture/diagnostic guards, typecheck, production builds and 200 locked migration hashes. The actual signed-session Next/Nest/restricted disposable PostgreSQL proof completed 27 native EN/KO/ES × three modes × three viewports, keyboard/axe/privacy/reload checks and all-table no-write comparisons. This uses normally signed synthetic identities, not external OIDC or an owner device.

The original integration job **FAILED**, with two mandatory positive wallet assertions receiving 503 instead of 200. An identical restricted read confirms PostgreSQL `55000 / UNASSIGNED_PERIOD_RECORD` in `saas_creative_eligibility`, before canonical validation. With no subscription, migration 0202's `per record` is not assigned before expression planning dereferences it. Claude subsequently supplied the additive correction and deterministic no-subscription proof accepted as #147; see the current checkpoint above. No historical SQL edit, dummy subscription, grant, validator relaxation or successful-response fixture is permitted. The UI correctly preserves independently authorized billing while displaying wallet unavailable; this does not satisfy the required positive checks.

[Private report and 27-case screenshots](https://github.com/myhonosai/honos/actions/runs/42087632292/artifacts/13443113187) are retained for three days. The report remains `passed:false`, with 12 groups, 27 mounted cases and two failures. Neither a local database/browser pass nor owner-environment acceptance is claimed. Later documentation-only commits reuse this explicit application/proof pin and do not imply a fresh exact-head runtime run.

Keep #146 independently reviewable against actual accepted main, with final exact-head CI and focused review separate from the historical results. Preserve #143's original native 403 failure and #145's separate four-flow success; do not merge the verification-only #145. No deployment, persistent database operation, communication, provider invocation, policy approval, payment or credit activation occurs in this slice.
