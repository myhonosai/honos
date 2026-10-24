# HQ subscription account review — actual application evidence

Actual production-build application screenshots with visibly labeled **synthetic authorized localhost fixtures**, not concepts or customer data. No deployment, payment, financial activation, provider call or production database access.

Capture source: `14f000f95c16179d840a52237008c7bc507d01dd`, branch `codex/hq-subscription-review`, [PR #22](https://github.com/myhonosai/honos/pull/22). Based on main's owner-approved PR #20 merge `40a896806dce778dd301ab68abd348bb3c586f74`.

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Subscription status/search, founder inventory and returned verified provider-cost evidence | [Full desktop](overview-desktop.jpg) | [Full mobile](overview-mobile.jpg) |
| Selected organization: entitlements, payment standing, allowance periods, reservations and usage | [Full desktop](account-desktop.jpg) | [Full mobile](account-mobile.jpg), [selected-account viewport](account-mobile-viewport.jpg) |

Download originals for full resolution. Full-page mobile captures are long because they retain all synthetic records and accounting explanations. The viewport image shows actual account entry, keyboard focus and fixed navigation clearance. No UI was hidden or reconstructed. View and AI Style remain separate rounded groups; HON and the approved HQ shell remain intact.

[Browser 39180875046](https://github.com/myhonosai/honos/actions/runs/39180875046): **81 checks passed**, zero failures or JavaScript errors, **51 PNG captures**, **32 axe scans with zero reported violations**, across 1440×1000, 834×1112, 390×844 and 320×800. [Actual sanitized report](browser-report.json). The [complete PNG artifact](https://github.com/myhonosai/honos/actions/runs/39180875046/artifacts/12156232100) expires October 22, 2026; these JPEGs remain in Git.

Checks cover all six fixed GETs, status filtering, bounded organization search, explicit keyboard selection and visible account focus, focus restoration, refresh with changed authoritative balances, empty/denied/unavailable/invalid states, wrong organization and subscription races, stale-response rejection, attestation versus verification, unknown reservation holds, and existing HQ/Champions/appearance/assistant regressions. Signed localhost sessions are actually verified; unauthorized staff/family/support/non-billing HQ and unsigned sessions cannot use fixture reads. URL selectors do not confer authority. External network requests are blocked and only fixed local GET traffic is allowed. Canonical authorization/calculations are separately tested by full CI against disposable PostgreSQL.

[Full CI 39180875031](https://github.com/myhonosai/honos/actions/runs/39180875031) passed both jobs: **613 web tests (11 new), 408 API, 188 domain and 91 auth tests**, typecheck, production application build, **155 migration-file checks**, and **all 13 database security proofs** including B1–B3 and **227 forced-RLS tables**. Final evidence-head CI is recorded in PR #22 and issue #4; this evidence commit changes only documentation/images, with application, test, fixture and harness blobs unchanged from the capture source.

Manual review remains: physical iOS/Android keyboards and rotation, VoiceOver/NVDA focus/live announcements, zoom and image-backed contrast. Axe retained 1–2 incomplete rules per scan; this is not full WCAG certification. External Google font requests were blocked, so captures use fallback fonts.

Scope: subscription-account review is functional against merged B1–B3 GETs. Invoice list/detail and individual payment-evidence history are the next slice using existing B2 services. `/hq/ai-costs` remains planned; returned verified evidence is shown here, without claiming complete company spend or revenue totals. All financial commands remain unavailable. Complete school reward history remains tracked in unchanged [issue #21](https://github.com/myhonosai/honos/issues/21). Language support in #17 remains documentation only.

[Implementation/security handoff](../../../CODEX_HQ_SUBSCRIPTION_REVIEW.md). PR #22 requires separate owner approval to merge; no deployment authorization. Remove temporary verification through a separately reviewed cleanup after sign-off.
