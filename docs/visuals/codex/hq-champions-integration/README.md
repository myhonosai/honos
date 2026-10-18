# HON HQ — real Champions Club leaderboard

Branch: `codex/hq-champions-integration`. [PR #11](https://github.com/myhonosai/honos/pull/11), stacked on [visual PR #8](https://github.com/myhonosai/honos/pull/8). Tracking: [#4](https://github.com/myhonosai/honos/issues/4). Owner review pending; no merge or deployment.

## Real implementation captures

Application source: `9a53fba89fa44fca50753a563ca07d49fd6c989b`. These are actual production-build screenshots using ephemeral signed sessions and synthetic authorized localhost API fixtures, not generated concepts or production/customer data. The page carries **LOCAL TEST FIXTURE · NO LIVE DATA**.

- [Desktop all-time standings](desktop.jpg)
- [Desktop selected-month standings](desktop-monthly.jpg)
- [Mobile initial viewport](mobile.jpg)
- [Full mobile all-time standings](mobile-full.jpg)
- [Full mobile selected-month standings](mobile-monthly.jpg)
- [Desktop appearance groups / preserved HQ dashboard](appearance-desktop.jpg)
- [Mobile appearance groups / preserved HQ dashboard](appearance-mobile.jpg)
- [Sanitized report](browser-report.json)

The full-page images show fixed phone navigation at the original viewport boundary. Use the separate viewport capture to assess initial screen composition. No screenshot pixels were edited; UI fixes were made in application code and recaptured.

## Implemented behavior

The page uses the real merged M3 HQ endpoint and shared typed validators. All-time/month filters, UTC month selection and refresh issue fixed authenticated no-store reads. The backend supplies the ranks, positions, qualified/pending counts, school identities and held-school list. The frontend neither calculates rankings nor sorts official results.

Names are HQ-authorized identities; anonymous-by-default school-view display policy is clearly identified separately. Confidential holds are collapsed and kept out of standings; their qualified totals are explicitly all-time. This screen offers no hold, reward, payment or contest commands.

Filters/refresh clear old results immediately. Unavailable, denied, malformed or mismatched responses reveal no stale rows or hold details. A canceled/obsolete request cannot restore a previous period. Empty verified data remains distinct from unavailable data.

Each View / AI Style group has its own rounded boundary and label. Mobile stacks them. Screenshot inspection drove tighter mobile spacing and removal of an obstructing wide assistant overlay: the compact desktop/tablet orb and persistent mobile HON navigation open the same assistant. Approved background, portraits, central HON and three presentation modes remain intact.

## Evidence

[Verification run 39111391462](https://github.com/myhonosai/honos/actions/runs/39111391462) passed **all three jobs** on the exact captured application source: repository tests/typecheck/full build/migration contract/clean tracked files; existing disposable-local PostgreSQL security proofs; and browser verification. **45 browser checks passed, zero failed; 12 axe scans reported zero violations; 25 PNG captures.** Web: **581 tests / 108 files**, including **9 new integration tests**; API: **390**; domain: **188**; auth: **91**. All **8 disposable-database proofs** passed, including real M1–M3 API-service/database output and privacy boundaries.

[All original PNGs/report](https://github.com/myhonosai/honos/actions/runs/39111391462/artifacts/12130199166) remain a private artifact with three-day retention. This gallery preserves seven unchanged JPEG captures and the sanitized report in the repository. Coverage includes nine focused frontend tests; all-time/tie/month/refresh/loading/empty/error/access states; closed request/response/period validation; confidential hold handling; late responses; independent school/family/support/unsigned denials; authorized operator access; 1440, 834, 390 and 320px layouts; all three view modes; appearance boundaries; assistant controls and automated accessibility scans.

The browser server is an explicitly synthetic transport double with independent signed-session and fixture-identity checks. Canonical database authorization, official rank calculation, qualification/exclusion/privacy/holds and liability non-activation are verified separately by the existing M1–M3 disposable-local proofs in CI. No production authorization was bypassed.

## Remaining work

Phase 3 program/attribution/statistics/milestone/liability page integration is not included in this tested leaderboard slice. Contest M4 remains Claude-owned. Existing liability records are not paid or issued rewards; financial activation and fulfillment remain disabled.

Physical-device software keyboard, screen-reader and owner review remain pending. Axe reports supplement manual testing and include incomplete checks; they do not establish full WCAG compliance. External browser traffic is blocked, so fonts may use system fallbacks.

Protected originals, school CRM/enrollment/membership, shared CI and backend/contracts/database/security code are unchanged. Latest merged main `ba1866a` is preserved in the visual base. Remove the temporary verification workflow after owner sign-off.
