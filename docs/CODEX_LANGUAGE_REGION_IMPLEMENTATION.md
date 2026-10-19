# Language & Region — implemented frontend slice

Branch `codex/language-region-implementation`, PR #34; based on approved #32 merge `67bc6a8da6184164ae57e6d092aba6cb6dd8dbf1`. No deployment or merge of this PR is authorized.

## Actual functionality and coverage

| Surface | English / Korean / Spanish coverage | Limit |
| --- | --- | --- |
| Settings → Language & Region | Language selector, preferences, save/failure/session notices, formatting controls/previews, navigation, accessibility labels and coverage notices | Browser persistence only; server synchronization and school defaults unavailable |
| School subscription and signed checkout return | Core/Complete comparison, founder offer labels/prices/availability, feature descriptions, purchase review/confirmation, safe errors/loading, checkout/payment/service/activation/suspension, AI allowance, invoice availability and local HON guide | Uses unchanged merged B5/B3 contracts; pending access remains pending. Canonical IDs, currency codes, product/person names and diagnostic reason codes are not translated |
| Shared navigation | Authenticated root settings/language utility, common settings navigation and three-mode controls; works across staff/HQ/family contexts | Other staff/family business pages and their local menus remain English |
| HON HQ | Main/mobile navigation, appearance controls, access/unavailable notices, assistant controls and common main-dashboard components | Revenue/invoice/Champions operational modules, executive workspace bodies and other dedicated HQ screens are not fully translated |
| Classic school dashboard reference | Shared root language settings utility only | Claude-owned Classic reference content remains unchanged and English |
| AI / customer/legal content | Local deterministic HON plan guide follows the selected language | Conversation/voice services stay unavailable; no new locale field is sent to unapproved AI contracts. Customer content, legal documents and external communications are neither translated nor sent |

This is not complete HON OS language coverage. All presentation modes share catalogs and behavior; separate applications/pages are not created. Core, Complete and legacy users can access personal settings with a verified session; no AI-credit or paid-tier gate.

## Shared architecture

`packages/design-system/src/localization/` contains 501-key English/Korean/Spanish catalogs, a type-safe key union, English fallback, named parameter interpolation, plural selection and locale-aware number/canonical-money/timestamp/date-only helpers. Keys use stable English source messages, with semantic keys for protocol status labels. Adopted settings/subscription/HQ page titles follow the locale. A thin React adapter is shared by all web surfaces. No added package dependency or lockfile change.

Translations are plain text rendered by React, never HTML, executable templates or an external translation provider. Only controlled UI copy, metadata and safe local error messages use the catalog. Unknown/customer-authored content remains original; IDs, evidence and business calculations remain canonical. Missing translations fall back to English; catalog key and placeholder parity is tested. Future languages extend the central registry/catalogs instead of duplicating routes.

Display language, formatting region, currency symbol-versus-code style and display timezone are independent validated preferences. Region may explicitly follow the interface language or be fixed. Formatting always uses the record's currency/minor units, never converts money or changes school financial settings. Timestamp presentation can use a chosen display timezone; canonical instants, billing periods and UTC qualification windows are unchanged. Date-only values never shift through the selected timezone. Currency/number/date examples are explicitly previews, not account records.

## Persistence truth and security

The only merged preference API is the principal-and-school-scoped interface-theme API. It is not a universal language or family/HQ identity contract. It is unchanged and is not called or repurposed by localization.

The root server layout optionally verifies the existing signed HON session using the existing verifier and duplicate-cookie rules. It derives an opaque HMAC namespace from the verified issuer/audience/subject and existing session key. Raw identities and keys never reach the client. Anonymous/invalid sessions stay English without changing existing page/API authentication gates. The protected settings page independently requires the existing verified-session gate.

A closed versioned browser presentation cookie stores only language, formatting region, currency display style and display timezone under that account's namespace. Initial HTML `lang` and client preferences resolve from the same verified-account cookie. Cookie tampering cannot select a tenant, grant permissions, change entitlement/billing or authorize an API. Invalid/unsupported presentation hints fall back to English. The root request reads headers dynamically; authenticated locale results are not shared-cached. Language switching updates text and document `lang` immediately without resetting component appearance/portrait or purchase state.

A successful cookie write/readback is labeled **saved for this account in this browser**, never a backend save. Blocked writes are labeled applied-now/save-failed; an unscoped session can only apply an in-memory choice. Cookies persist for up to a year across sign-ins/navigation in the same browser. Clearing/evicting cookies, a different browser/device, or rotating the session signing key can reset the choice. Real auth login/return uses full navigation and re-resolves the current verified account; client preferences never select identity. No cross-device synchronization or school default is claimed.

Existing domain API authorization, tenant isolation, session gates, financial safeguards, verified-payment versus activation distinctions and frontend checkout transport remain intact. Shared-layout additions were coordinated on #33/#27/#17; no active backend, migration, CRM, family-record, Classic or original asset files are modified.

## Required backend preference contract — coordinated, not implemented

The owner permits a working local frontend while persistent contracts are absent. Claude/Manus must design and approve the backend before consumption; these are semantic requirements, not invented executable endpoints:

1. Self-only authenticated user preference read/update; derive the canonical identity server-side, with closed supported-language validation, no-store responses, provenance, revision/time and truthful failure/conflict receipts. No arbitrary actor/principal/school IDs or generic preference keys.
2. Verify safe canonical identity linkage across HQ/staff/family and devices. Do not join by email or selected school. Locale never grants cross-plane authority.
3. Independently authorize school defaults and initialize only truly new, uninitialized users atomically. Explicit personal choices win, including concurrent onboarding/save races. Existing users, changed schools and later default edits must not overwrite prior choices.
4. Keep personal formatting versus school currency/timezone policies separate, and preserve appearance endpoints. Coordinate schema/migration ownership and ordering rather than editing Claude's #33 or Manus's CRM migrations.
5. Approve any future assistant-language request field as non-authoritative response context through existing governed contracts. No provider, tool, message, credit or entitlement authority derives from language.

The owner-approved requirements in docs-only #17 remain intact. That PR is not merged or overwritten here. B5.1 #33 merged during verification as `387c8002d16bfad8166879cb788c1cfc1775ac5c` and is preserved unchanged. This localization slice does not yet connect the new billing reads; invoice UI says not connected on this screen. Billing, paid-access B6 and Stripe remain Claude-owned.

Persistent preference dependency: [issue #35](https://github.com/myhonosai/honos/issues/35).

## Verification

In progress. Unit coverage checks catalog/placeholder parity, fallback, safe interpolation/plurals, closed preferences, distinct scope keys, formatting/currency/date-only invariants, translated settings/subscription/service states and untouched authority paths. Browser verification uses actual production Next with signed synthetic localhost principals, deterministic B5/B3 and independently separated HQ fixture authorization, and an intercepted hosted stand-in. No real Stripe sandbox/provider/customer data.

Expanded browser cases cover all three languages on desktop/mobile, all presentation modes, keyboard, independent appearance and formatting, navigation/reload/new session, distinct users and an unsynchronized second browser, malformed hints, denied school access, family settings and session gates. Korean fallback fonts are installed only if missing on the disposable runner. Actual results/screenshots will be recorded after passing. Native-language copy review, physical-device and screen-reader/zoom/contrast checks remain manual; automated scans do not certify full accessibility.
