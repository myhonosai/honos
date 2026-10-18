# Language & Region — shared localization implementation plan

**Status:** proposed architecture for backend/design-system review, not an implemented contract. The [owner-approved product requirement](../hon/LANGUAGE_AND_REGION.md) is authoritative. This plan authorizes no schema, runtime, provider, permission, merge or deployment change.

## Verified starting point

- `apps/web/src/app/layout.tsx` currently renders `html lang="en"`; it has no resolved language provider.
- `packages/design-system/src/index.ts` and `interface-themes.ts` provide shared tokens and the three presentation modes. They are the shared presentation integration point; modes must not fork translation catalogs or domain services.
- `apps/api/src/preferences/interface-theme.controller.ts` / `interface-theme.service.ts` implement an authenticated **per-principal, per-school interface-theme** preference. `apps/web/src/components/interface-theme-preference.ts` uses the matching closed transport. This is not a universal language contract and must not be stretched into HQ/family authority.
- HQ has its own signed-session route gate and independent API authorization. Parent/family identity is separate. None of these boundaries may be inferred from a locale, cookie, selected school or UI mode.

Recheck these paths, latest main, active PRs and ownership before implementation. The following file locations and contract fields are proposals, not existing APIs.

## Shared presentation architecture

Extend the existing HON design system with a framework-independent localization core (proposed `packages/design-system/src/localization/`) and a thin web adapter. Use a single semantic key registry, English source catalog, and Korean/Spanish catalogs. React Native/Expo can consume the same pure lookup/formatting core later without importing Next.js or DOM code.

Use complete messages with named parameters and locale-aware plurals rather than concatenated translated fragments. Choose the smallest suitable ICU-compatible formatter during implementation review; do not add dependencies or alter a lockfile during planning. Catalogs contain reviewed UI text, never customer records, secrets or authority rules. Escape interpolation and prohibit executable/HTML translations. Keep accessibility labels, headings, validation instructions and navigation in the same key system. Map known stable backend error codes to reviewed UI messages; do not translate or echo arbitrary server error bodies.

Resolution: requested supported language → matching catalog entry → English entry. Reject unsupported persisted values at the contract boundary and use English safely; missing translations must not render raw keys or blank controls. Development/CI reports missing keys without sending customer content to telemetry or a translation provider. English coverage is mandatory; Korean/Spanish coverage is tracked and reviewed before product-wide support is claimed.

Server-render the initial authorized language and pass the same catalog/resolution to client components; set the document `lang` consistently. Never cache authenticated rendered UI/catalog resolution across users. Public unauthenticated surfaces default to English; any optional public locale hint is bounded presentation input only. On logout/account change clear user-specific caches and re-resolve. No hydration flash from unverified local storage should establish a persisted preference.

## Backend coordination proposal — unresolved until backend owner review

| Concern | Proposed contract behavior | Required owner of implementation |
| --- | --- | --- |
| Personal preference | Read/update only the signed-in user's supported display language; return language, provenance, revision and confirmed timestamp. Actor/account is derived server-side, never a submitted principal ID. Closed request/response validation; no-store reads; authenticated same-origin mutation with concurrency, idempotency and appropriate audit conventions. | Backend owner, with Codex consuming the reviewed contract |
| Identity across devices/experiences | Persist to a canonical user preference through explicitly verified identity/account linkage. Maintain HQ/staff/family authorization separation. Do not join users by email, browser storage, school selector or shared role name. If no safe cross-plane identity mapping exists, resolve it before promising one preference across those experiences. | Backend/security owner |
| New-user school default | Authorized school setting plus an atomic create-if-uninitialized onboarding operation. Preserve existing personal rows and seed provenance. Multi-school/new-account context must come from verified onboarding; changing current school never reinitializes language. Concurrent saves and onboarding must preserve an explicit choice. Existing users without a recorded choice remain English until they choose. | Backend/onboarding owner; coordinate Manus |
| Region/timezone/currency | Separate validated contracts and permissions; do not add or repurpose these fields in the language request. | Existing domain/backend owners |

Exact route names, persistence location, identity mapping, grants/RLS, migration slot and school-default permissions must be agreed in the implementation PR before code is written. Reuse canonical domain/security services; no generic preference endpoint accepting arbitrary keys, direct browser table access, or HQ request relayed through a school identity. The current school-theme endpoint remains unchanged. Runtime failures produce truthful unavailable states, never a fictional save receipt.

## Formatting and AI boundaries

Use `Intl.NumberFormat`, `Intl.DateTimeFormat` and locale-aware plural rules through shared helpers. Format canonical money using its **recorded currency and minor units**; no foreign-exchange conversion. Display times in an explicitly resolved permitted timezone; date-only values must not shift through UTC conversion. Language alone never changes timezone, tax treatment, money, eligibility windows or official leaderboard order/ranks. API state codes, IDs, data models and business calculations remain canonical; only their approved labels and presentation change.

Pass the verified response-language preference as non-authoritative presentation context through existing AI request contracts **only after those owners approve the contract**. It cannot change model access, tools, approvals, tenant scope, paid-call gates or credit accounting. Do not start an AI/voice/translation provider to switch UI language. Preserve original customer text, legal text and approved messages. Future user-requested content translation is a separate reviewed workflow; translated drafts cannot send themselves.

## Ordered implementation slices (not started)

1. **Contract and catalog foundation:** backend owner agrees personal/school-default contracts and identity linkage; inventory UI strings and stable error codes; add shared pure catalog/resolver/format helpers, fallback and language metadata. No shared component promotion without visual-owner coordination.
2. **Persistent settings vertical slice:** implement Settings → Language & Region using the approved backend; validate save/retry/conflict/denied behavior and a second browser/device session. Introduce server/client resolution without changing existing theme storage. School-default initialization is separately backend-reviewed.
3. **Shared shell adoption:** translate navigation, common forms/errors and accessibility text in HQ, staff and parent shells through the same catalog; keep three modes and portrait styles independent. Coordinate Claude's Classic work and Manus's enrollment work before touching their files; no parallel translated pages.
4. **Feature adoption and release:** migrate bounded modules, including dates/numbers and unavailable states; review Korean/Spanish copy with fluent reviewers, verify coverage and fallback, and record exactly which surfaces are translated. Add supported AI language context only where its real contract exists.

## Verification required for implementation

- Unit checks: supported language allowlist, complete English keys, parameter/plural parity, English fallback for missing/invalid translations, safe interpolation, dates/numbers/canonical currency and date-only behavior.
- API/database proofs: self-only reads/writes, cross-user and HQ/staff/family denial, school-setting permission checks, concurrent initialization versus explicit choice, idempotency/version conflict, no overwriting existing users after a default change, unchanged RLS and domain records. Use isolated disposable fixtures.
- Integration: sign out/in and second device reflect a confirmed choice; unavailability never claims a save; switching schools/modes/accounts clears stale facts without changing another user's preference; SSR/client language and `lang` agree.
- Browser: all three languages × all three views on desktop/tablet/mobile, keyboard/focus/save announcements, 200% zoom, long labels/wrapping, Korean font fallback, screen-reader pronunciation, English error fallback; no horizontal overflow.
- Regression: existing test/typecheck/build and affected security proofs; no provider calls, credit charges, external delivery, financial mutation or translated customer/legal content. Record actual coverage and manual review limits.

## Delivery ownership and review gates

Prepare a backend contract discussion before any persistence work; track implementation slices through issue #4 and narrow PRs. Existing Claude billing/contest and Manus CRM/enrollment PRs retain ownership. This documentation introduces no endpoint, database table, migration, permission, language switcher or installed package. Product policy is approved; technical details require backend coordination and implementation authorization.
