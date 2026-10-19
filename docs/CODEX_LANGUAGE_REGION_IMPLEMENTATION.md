# Language & Region — shared frontend implementation

PR #34, branch `codex/language-region-implementation`. Approved #32 merged as `67bc6a8da6184164ae57e6d092aba6cb6dd8dbf1`. This PR remains unmerged and undeployed.

## Actual coverage

| Surface | English / Korean / Spanish | Boundary |
| --- | --- | --- |
| Settings → Language & Region | Language selection, authenticated synchronization, status/error/retry controls, independent formatting preferences and previews, school-default management, accessibility labels | Language uses merged #36; formatting remains browser-only. School editor requires independently verified current-school scope and management permission |
| School subscription / signed checkout return | Core/Complete features/prices, founder/monthly/lifetime offers, review/confirmation, local HON guide, payment/service/activation/suspension, AI allowances, loading/errors and invoice availability | Existing B5/B3 transport and financial behavior unchanged. New B5.1 invoice reads are not connected in this slice; UI says not connected here |
| Shared navigation | Authenticated global settings/language utility and adopted common controls | Other staff/family business forms and their local menus remain English |
| HON HQ | Main/mobile navigation, appearance groups, access/unavailable notices, assistant controls and common main-dashboard components | Dedicated financial/Champions modules and executive workspace bodies remain English or partial |
| Classic school reference | Shared root language utility | Claude-owned reference content and original art unchanged |
| HON / customer content | Deterministic local plan guide follows language | Conversation/voice remain unavailable where disconnected. No locale field is sent to an unapproved AI contract; no provider/credit charge. Customer input, legal documents and external communications are neither automatically translated nor sent |

This is not complete HON OS translation coverage. Settings is available to verified users independently of tier; no AI-credit or paid-upgrade gate. The same application, routes and components serve all languages and presentation modes.

## Catalogs and formatting

`packages/design-system/src/localization/` contains 534-key English, Korean and Spanish catalogs, typed lookup keys, English fallback, named interpolation, plural selection, and Intl number/currency/timestamp/calendar-date helpers. Only known controlled UI copy is translated. Unknown/customer text, canonical IDs/status codes, evidence, names and business calculations remain original. React renders translations as text, never HTML.

Interface language, formatting region (`auto`, United States, South Korea, Spain), currency symbol/code style and display timezone (UTC, Los Angeles, Seoul, Madrid) are independent. Actual record currencies/minor units never change; no FX conversion. Date-only records never shift through a display timezone. Official UTC qualification/billing windows are unchanged. Formatting examples are labeled previews, not account facts. No dependency or lockfile change.

## Real persistence — merged Claude contract

Main advanced during verification: B5.1 #33 is preserved, then language backend #36 and docs-only B6 plan #37 merged into `d168224c993953787389fe83d31bc0f7fbf2bcf7`. The earlier browser-only language prototype is superseded by the exact merged `@hon/contracts` language validators and APIs:

- `GET/POST /v1/me/language-preference`: authenticated self only, no caller user/principal/organization ID. Browser requests use the existing same-origin `/api/v1` rewrite and signed session. Commands send only `{language, expectedVersion}`, the exact `LANGUAGE_COMMANDS` header and a fresh UUID idempotency key for each explicit action.
- `GET/POST /v1/schools/:schoolId/language-default`: settings explicitly resolves the existing current-reporting-school endpoint, requires a single server-resolved school, binds school and organization in the returned record, and only displays an editor when `canManage` is true. Every save is independently authorized by the backend. No arbitrary school input, URL scope or HQ/family privilege is accepted.
- Canonical `effective.language` and source determine precedence. A personal preference wins; a school default applies only to users without a personal preference when a verified school context is named; otherwise English. The subscription registers only its verified backend school context. Other surfaces do not guess a multi-school user's school. Settings can explicitly load the current authorized school; an ambiguous scope remains unavailable.

The backend applies school defaults to users without personal preferences, rather than freezing an onboarding snapshot. Changing a school default never changes personal preference records. The frontend does not invent an initialization database or independently calculate precedence.

Selectors apply text immediately, then show saving/confirmed/conflict/denied/unavailable/unknown states. Duplicate commands are blocked. An unknown outcome retains the original input/key for an explicit same-request retry; no automatic mutation/retry occurs. A stale-version conflict refreshes canonical state before another user choice. After a successful receipt, a fresh read verifies current language; a newer concurrent preference wins. Mismatched or malformed receipts never become a success. School management handles read-only and revoked permission, conflicts and unknown outcomes without claiming a saved default.

## Browser hints and boundaries

The root optionally verifies the existing signed session and derives an opaque HMAC namespace from its verified mode/audience/subject. It reads a closed versioned presentation cookie for initial rendering; invalid/duplicate hints fall back safely. It never returns raw identity/key material. Settings independently requires the existing signed-session gate. Root headers are dynamic, avoiding shared authenticated-locale caching.

The cookie is a first-paint hint only. Once loaded, the canonical server language wins, including on a second device without cookies. Clearing cookies does not erase a confirmed server preference. A failed preference read/save is disclosed and never represented as synchronization. Old browser hints are not silently promoted to server preferences without an explicit user action. During an outage or first load, a browser hint may be shown until the canonical read completes.

**Region, currency-display style and display timezone remain account-separated browser-only preferences.** Their write/readback failure has a separate notice. They are not stored in the language-only backend or the existing theme API. They are not billing/school policy. Language switching does not reset appearance, portrait or purchase state. Theme/portrait APIs, identity/tenant authorization, effective entitlements, billing commands, RLS and database schema are unchanged.

The owner/backend request is tracked in [#35](https://github.com/myhonosai/honos/issues/35); the persistence contract is now merged in #36. [Claude's contract](architecture/HON_LANGUAGE_PREFERENCES.md) controls permissions and concurrency. #17's approved requirements remain intact. No backend or migration is authored by Codex; synchronized backend files are byte-preserved from main. B6 decisions remain proposals; payment does not grant access.

## Verification

Fresh verification for the #36 integration is in progress. Earlier locale foundation tests/CI, 16 disposable-database proofs and translated Settings/HQ captures passed; these do not establish the new persistence behavior. Final results and screenshots will replace this paragraph only after the current tests pass.

Tests cover catalog/placeholder parity, English fallback, safe interpolation, formatting/currency/date-only invariants; self-only closed HTTP, privacy/error classification, scope-bound defaults and idempotent receipt handling. Actual production Next browser checks use signed synthetic school/HQ/family identities and a deterministic localhost backend double. Canonical backend authorization, cross-device identity, school defaults and concurrency are independently tested in the repository's disposable PostgreSQL proof. No production data, real Stripe verification, provider calls or financial activation.

Manual native-language copy review, physical iOS/Android keyboards/rotation, VoiceOver/NVDA and image-backed contrast remain. Zero automated axe violations does not establish full WCAG conformance. The temporary same-repository browser workflow is read-only, secretless, pinned and restricted to this exact branch/base; remove only after review in a separate change.
