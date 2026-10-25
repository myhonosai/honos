# A2P-1 — Registration assistant frontend contract (proposed)

Status: **frontend presentation contract. No merged API implements it.** Production is wired only to `A2P_NOT_CONNECTED_ADAPTER` and makes no A2P, provider, AI or messaging request. Codex's backend is draft PR #82 (`codex/a2p-1-backend`, head `c1ce12c`, unmerged); it was read for the comparison below and is **not imported**. The real HTTP adapter is a separate step after #82 merges.

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

- Inspection mode: a website check carries `inspection` (`LIVE`, `LIVE_INSPECTION_DISABLED`, `SYNTHETIC_FIXTURE`, `UNKNOWN`). Unless it is `LIVE` (or `SYNTHETIC_FIXTURE` from the synthetic preview adapter only), every finding is forced to `UNABLE_TO_VERIFY` with no observation time and no "current wording", and Step 1 says live inspection is off. Fixture evidence is labeled "Synthetic sample evidence · not a live scan".
- Answer labels: `VERIFIED` needs evidence ids that match observed findings of the current completed check, and shows as "Verified from website" only for a `LIVE` check (fixtures show "Matches sample evidence (synthetic)"). `OWNER_CONFIRMED` needs a server `confirmedAt`. Otherwise the label is "Unverified draft".
- "Your edits were saved" appears only when the save response carries a recorded revision newer than the edited one; anything else is `UNKNOWN` and the edits stay on the page.

## Differences from Codex PR #82 (head `c1ce12c`)

PR #82 is a **stateless, read-only preparation engine**: five POST routes under `/v1/organizations/:organizationId/schools/:schoolId/a2p/`, no persistence, no history, live inspection always `UNAVAILABLE`. The frontend's proposed contract assumed a stateful service. The differences, and what the adapter must do with each:

| Area | This frontend (proposed) | PR #82 (actual) | Consequence for the adapter |
|---|---|---|---|
| Availability | `GET …/a2p/readiness` with capability flags | No readiness route; 403 `A2P_PREPARATION_FORBIDDEN` / 503 `A2P_PREPARATION_UNAVAILABLE`; `scope.canConfirmOwnerFacts` on every response | Derive capabilities: websiteCheck/answerDrafts on, findingReview/saveAnswers/ownerConfirmations/registrationStatus/assistant **off** |
| Transport | GET/PUT, `Idempotency-Key` on commands | All POST, read-only; `X-HON-Human-Command: a2p-prepare`, same-origin Origin + Fetch Metadata, JSON body; no idempotency key | New HTTP adapter with these headers; no business facts in URLs |
| Website check | Async: start → poll `QUEUED/CHECKING` → `COMPLETED`; latest-check resume | Synchronous `website-review`; no check id, polling or latest/history | Map one response straight to `COMPLETED`; no resume after reload |
| Inspection | `inspection` mode on the check | `review.inspection: LIVE_INSPECTION_DISABLED \| SYNTHETIC_FIXTURE`; production always disabled | Already handled: production findings will all show "Unable to verify" |
| Review input | Website URL only | `websiteUrl, businessName, privacyUrl, termsUrl, optInUrl, messageFlow` (explicit nulls); `.example`/`.test`/`.local` hosts and query/fragment rejected | Step 1 needs five more optional fields |
| Outcomes | `PASSED / NEEDS_FIXING / REVIEW_REQUIRED / UNABLE_TO_VERIFY` | `PASS / NEEDS_FIX / REVIEW_REQUIRED / UNAVAILABLE` | 1:1 mapping |
| Finding shape | `id, area, title, explanation, whyItMatters, location{pageUrl, sectionLabel}, originalText, suggestedText, observedAt` | `code` (13 codes), `status, reason, remediation, sourceIds, evidence[]{url, provenance: SYNTHETIC_FIXTURE, observedAt, excerpt}` plus `sources[]` (Twilio docs, reviewed 2026-10-25); `finding-details` route | id = code; title/area from frontend copy per code (13 × EN/KO/ES needed); reason → explanation; remediation → suggestion; evidence url/excerpt → location/original; sources → "why it matters" links. No section label |
| Finding review marks | `markFinding` persisted | None | Mark-for-review stays disabled |
| Draft input | No input (server knows school) | `facts{businessName, websiteUrl, privacyUrl, termsUrl, optInUrl, supportContact, messageFlow, messageFrequency}`, `purpose` (SERVICE_NOTIFICATIONS/MARKETING/MIXED), `templates` (1–5 of 7), `marketingConsent`, `ownerConfirmation` token | Step 3 needs a facts + purpose + template form before drafting |
| Draft output | 10 fixed keys incl. 3 samples | `state NEEDS_INPUT \| DRAFT_FOR_OWNER_REVIEW`, `missingFields`, `warnings`, `answers{campaignUseCase, campaignDescription, messageFlow, websiteUrl, privacyPolicyUrl, termsAndConditionsUrl, optInUrl}`, 2–5 `sampleMessages{template, content}`, help/stop samples; English only | Add `CAMPAIGN_USE_CASE`, `OPT_IN_URL`, variable sample count; show `missingFields`/`warnings`; label samples English |
| Provenance | Per-answer `VERIFIED / OWNER_CONFIRMED / UNVERIFIED_DRAFT` | `factsProvenance: OWNER_STATEMENTS_NOT_INDEPENDENTLY_VERIFIED`; no per-answer evidence | Every #82 answer shows "Unverified draft"; nothing will show "Verified" |
| Owner confirmations | Five statements, saved one by one with `confirmedAt` | One request-scoped token `OWNER_CONFIRMED_FACTS_FOR_DRAFT_ONLY`, only if `canConfirmOwnerFacts`; plus separate `marketingConsent`; nothing saved | Replace the five saved confirmations with one per-request owner attestation; never show "confirmed at" |
| Save | Explicit save with revision | None (`saved:false`, `persistence: NONE`) | Save stays hidden; the "not saved, lost on reload" notice remains |
| Contradictions | `contradictions[]` | `FLOW_CONSISTENCY` finding + draft `warnings` | Show warnings in Final review |
| Readiness | Local counts | `draft-validation`: `readyForCopyPreparation`, `missingFields`, `warnings`, `providerEligibility: NOT_VERIFIED`, `approval: NOT_REQUESTED` | Use server validation for the readiness block |
| Export | Local `.txt` builder | `copy-preparation` with `expectedDigest` + `COPY_DRAFT_FOR_EXTERNAL_OWNER_REVIEW`, only when `copyPreparationAvailable` | Use the server text; disable export for incomplete drafts |
| Registration status | `GET …/registration-status` | None | Step 5 stays "Status unavailable" |
| Permission | Unspecified | `communication.a2p.prepare` + active entitlement + exact-school direct human | Map 403 codes to the denied banner |

Until an adapter implementing the right-hand column is merged, production stays on `A2P_NOT_CONNECTED_ADAPTER`.

## Original proposed endpoints (superseded by the table above)

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

## A2P-2 integration rehearsal (dependent on #81 and #82, not merge-ready)

Branch `claude/a2p-2-integration-rehearsal` = `32d40ad` (#81) + `c1ce12c` (#82), merged without edits to either. On this branch the production route uses the HTTP adapter instead of `A2P_NOT_CONNECTED_ADAPTER`; the synthetic reference route is unchanged.

| Piece | Path |
|---|---|
| Strict response readers | `apps/web/src/components/a2p-registration/preparation-contract.ts` |
| HTTP adapter (five POST routes) | `apps/web/src/components/a2p-registration/preparation-http.ts` |
| Controller | `apps/web/src/components/a2p-registration/preparation-controller.ts` |
| View | `apps/web/src/components/a2p-registration/preparation-view.tsx` |
| Copy (EN/KO/ES) | `packages/design-system/src/localization/a2p-preparation.ts` |
| Browser + API + PostgreSQL rehearsal | `apps/web/scripts/a2p-preparation-integration-browser.mjs` |

Behaviour:
- Scope comes only from `/api/v1/staff/current-reporting-school`, re-verified before every command; facts travel only in JSON bodies; `X-HON-Human-Command: a2p-prepare`, `mode: same-origin`, no idempotency key.
- Responses are rejected unless they match the exact closed shape, the expected school, `readOnly`/`persistence: NONE`, all 13 checks in engine order, and the honesty invariants (no outcome or evidence while inspection is disabled, no overall PASS, no saved/submitted/sent/consent flags, English drafts, copy-ready exactly when nothing is missing, copy digest equal to the request).
- The owner attestation is sent only when the last response granted `canConfirmOwnerFacts`; it is cleared whenever a fact changes, when authority is lost, or on `A2P_OWNER_FACT_CONFIRMATION_REQUIRED`.
- Copy preparation uses the digest of the latest successful `draft-validation` of the current input plus `COPY_DRAFT_FOR_EXTERNAL_OWNER_REVIEW`; any input change drops it.
- Results are dropped when the page is hidden (typed facts stay), and everything including facts is dropped on school change, 401, 403 or a lost current school.
- Disabled: saved drafts, review marks, provider status, submission, live HON chat.

### Contract changes requested from Codex
1. A read-only authority route (e.g. `POST …/a2p/readiness` returning `scope`). Today the UI learns `canConfirmOwnerFacts` from a fact-free `draft-validation` probe.
2. Export closed enums for `missingFields`, `warnings` and finding `reason` from `@hon/contracts`; the UI localizes the current values and labels unknown ones generically.
3. Return remediation as a code (or localized text); it is English-only server text today, shown with an "English" label.
4. `website-review` returns a `computationDigest` no route consumes; document its purpose or drop it.
5. Consider per-principal rate limits on the five routes (each call performs two scope reads).
