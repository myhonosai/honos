# A2P-1 — Registration assistant frontend contract (proposed)

Status: **proposed presentation contract for Codex's A2P backend. No API implements it.** Production is wired only to `A2P_NOT_CONNECTED_ADAPTER` and makes no A2P, provider, AI or messaging request.

## Where it lives

| Piece | Path |
|---|---|
| Production route (verified session) | `/settings/communications/business-texting/a2p-registration` |
| Synthetic reference route (404 unless `HON_REFERENCE_PREVIEW=1`) | `/reference/a2p-registration?scenario=ready\|checking\|check-failed\|error\|unavailable&theme=modern\|classic\|big-button&step=…` |
| Types and parsers | `apps/web/src/components/a2p-registration/contract.ts` |
| Adapter interface + NOT_CONNECTED adapter | `apps/web/src/components/a2p-registration/adapter.ts` |
| Controller (framework-free) | `apps/web/src/components/a2p-registration/controller.ts` |
| Synthetic fixtures (preview only, `.example` domain) | `apps/web/src/components/a2p-registration/synthetic-fixtures.ts` |
| Copy (EN/KO/ES) | `packages/design-system/src/localization/a2p-registration.ts` |
| Browser proof | `apps/web/scripts/a2p-registration-browser.mjs` |

## Safety rules the UI already enforces

- Every adapter result is narrowed by `contract.ts`. Unknown check state → `UNKNOWN`; unknown finding outcome → `UNABLE_TO_VERIFY`; a `PASSED` finding without `observedAt` → `UNABLE_TO_VERIFY`; unknown provenance → `UNVERIFIED_DRAFT`; unknown registration status → `UNKNOWN`; a confirmation counts only with a server `confirmedAt`.
- Findings are shown only for a `COMPLETED` check. Links render only for plain http(s) URLs without credentials.
- A non-synthetic adapter that reports `source: SYNTHETIC_FIXTURE` is treated as `ERROR`.
- Answer edits stay in page memory until an explicit Save, and only when the server grants `saveAnswers`. No autosave. A failed save is `UNKNOWN` and the edits are kept.
- No submission control is enabled. The HON composer is always disabled in A2P-1; suggested prompts only navigate to the matching step.
- The readiness label counts open items on screen; it is never a compliance verdict or approval prediction.

## Endpoints the frontend needs (suggested shapes)

Scope is `organizationId` / `schoolId` from the verified current-school resolver, never URL/form input. Every command carries `Idempotency-Key`. Responses are `{ data, meta }` with `Cache-Control: no-store`.

| Adapter method | Suggested endpoint | Returns (`data`) |
|---|---|---|
| `availability()` | `GET …/schools/:schoolId/a2p/readiness` | `{ state: READY\|DENIED\|NOT_CONNECTED, capabilities: { websiteCheck, findingReview, answerDrafts, saveAnswers, ownerConfirmations, registrationStatus, assistant } }` |
| `latestWebsiteCheck()` | `GET …/a2p/website-checks/latest` | check or `null` |
| `startWebsiteCheck(url)` | `POST …/a2p/website-checks` `{ websiteUrl }` | `{ checkId, state, websiteUrl, pagesChecked, pagesPlanned }` |
| `readWebsiteCheck(id)` | `GET …/a2p/website-checks/:checkId` | as above plus `completedAt`, `findings[]` when `COMPLETED` |
| `markFinding(id, review)` | `PUT …/a2p/findings/:findingId/review` `{ review: NONE\|MARKED_FOR_REVIEW }` | finding |
| `draftAnswers()` | `POST …/a2p/answer-drafts` | answer set |
| `saveAnswers(answers, expectedRevision)` | `PUT …/a2p/answers` `{ answers[], expectedRevision }` (409 on stale revision) | answer set |
| `setConfirmation(key, confirmed)` | `PUT …/a2p/confirmations/:key` `{ confirmed }` | answer set |
| `registrationStatus()` | `GET …/a2p/registration-status` | `{ status, reportedAt, providerReference, reasons[] }` |

Finding: `{ id, area, outcome, title, explanation, whyItMatters, location: { pageUrl, sectionLabel }, originalText, suggestedText, observedAt, review }`.
Answer set: `{ answers: [{ key, value, provenance, notes[] }], confirmations: [{ key, confirmed, confirmedAt }], contradictions: [{ id, summary, answerKeys[], findingIds[] }], revision }`.
Closed enums are the `A2P_*` constants in `contract.ts`.

## Open questions for Codex / owner

1. Language of server text (finding titles, explanations, suggestions, contradictions): return in the requester's language, or return codes the UI translates?
2. Who may use this page (owner only, or a delegated permission), and the 403 shape for `DENIED`.
3. Website-check network safety (SSRF, robots, rate limits) is backend-owned; the client check is usability only.
4. Whether `VERIFIED` provenance must reference a finding/evidence id.
5. Registration status must come from the provider integration only; HON-local `DRAFT` should be distinguishable from a provider-reported state (`reportedAt` null today).
