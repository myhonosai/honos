# Family-safe Parent Student Journey

## Routes and authentication

`/parent` redirects to the dynamic, authenticated, no-index `/parent/journey`. The web page validates the existing HON-owned session (including malformed/duplicate/expired cookie rejection) and redirects an unauthenticated visitor to `/auth/login`. Family permission is **not** a session claim; the API verifies it live. No scope is taken from URL query parameters, client IDs, local storage, email, relationship labels or staff/HQ roles.

The browser makes one fixed same-origin `GET /api/v1/parent/journey` with same-origin credentials/mode, `no-store`, no referrer and redirect rejection. It accepts only JSON with the closed shared ID-free display DTO. Query strings, bodies carrying selectors, cross-site requests and `x-hon-*` authority/source headers are rejected before reads. The server response is private/no-store and no-index.

## Scope discovery, not a new authority model

Migration **0087** adds `hon.resolve_parent_journey_scopes(subject)` as an internal read-only discovery wrapper. Candidate schools come only from the verified subject’s explicit live human family grants; every returned scope is produced by the **existing** `hon.resolve_parent_family_scope` resolver, retaining its single-active-human, active topology and live grant expiry rules. No table or directory grants, domain mutations, provider or action execution are added.

Discovery returns at most two scopes. Zero scopes fail closed; more than one produces an explicit current-family-selector-unavailable state. There is no existing verified current-family API to disambiguate several schools/families, so this UI neither chooses the first family nor accepts an ID to work around it. The exact family resolver is called again before aggregation and after reads.

`ParentJourneyViewService` reuses the existing `ParentStudentJourneyService.get`, `ParentFamilyScheduleService.get`, `AchievementsService.parent` and `DocumentService.read(LIST)` only. It rereads the guarded Journey before return and rejects changed child identity/status/name bindings. A permission failure in any read rejects the whole result; optional unavailable reads remain unavailable, never synthetic empty results. The existing SQL child and achievement boundaries continue to own membership/primary-family and visibility checks.

## Minimal display projection

- Authorized child names are from the existing Journey read model. Child selection is an **in-memory array choice**, never an outgoing identifier or authority claim.
- Only active-profile/current active curriculum enrollments, current rank names and explicit current-rank requirement observations are projected. Null observation means **Not recorded**, not NOT_STARTED/MET, a percentage, readiness or promotion. Historical enrollments, testing candidates/decisions, instructor rationale, private notes and revision history are omitted.
- Schedule is the existing exact-family booking projection for the server-generated next 30 days. Its legacy DTO has no child ID. Only exact **unique** authorized child display-name matches are shown; duplicate names are unavailable rather than guessed, and other child bookings never render in the selected child’s schedule.
- Achievements are the existing live exact-child, visible, nonwithdrawn human awards, reduced to pinned name/description/award date. The first 30-item page is marked limited if the API has a continuation; no IDs/cursors are exposed or accepted here.
- Current parent documents LIST is reduced to title/publication time, with an explicit first-page limitation. No document body, signer, attestation, contact, family details or co-parent evidence enters the browser DTO.
- **Document receipt listing is unavailable.** Existing receipt evidence GET requires a known receipt ID; there is no parent receipt-list API. A publication is not an acknowledgement. This page does not infer a signed/unsigned receipt status, fetch arbitrary evidence or generate receipts.
- **Planned absences/status are unavailable.** Existing parent planned-absence controller only offers POST; no guarded parent GET exists. No request, approval history, cancellation or makeup is inferred.

The existing explicit `/parent/documents` review/acknowledgement desk is linked without automatic prefetch. That desk performs its own scope verification and explicit human mutation handling; no mutation function is imported into Journey. No parent booking or absence write flow exists in the current web route set, so no fake link, mutation or disabled-success control is constructed.

## Presentation and lifecycle

One component uses the existing `HON_INTERFACE_THEMES` IDs/default and shared CSS variables for modern, big-button and classic presentation. All modes read the same authorized data; mobile controls have at least 48px targets (60px in big-button), stacked cards, keyboard focus and live status/error messages. No decorative or sample progress/schedules/recognition/documents exist.

Loading/refresh clears prior data, local generation tokens reject stale responses, and aborts discard previous requests. Blur, pagehide and document hiding clear family content; returning/focusing reauthorizes. A visible focused page rereads every minute to detect session/grant loss. Any failed refresh leaves no stale family content. This is UI-session freshness, not an unattended automation or worker.

## Validation and deployment

New API/UI tests cover no ID/query/source smuggling, strict redaction, exact parent scope/no staff fallback, sibling matching, revocation/child change, unavailable reads, effect isolation, authentication, mobile themes and navigation. Disposable-local PostgreSQL tests exercise resolver delegation/ACLs, parent topology/grant changes and effect-free aggregation. Full workspace check/test/build and migration validation are required before delivery.

Apply migration 0087 and the canonical restricted runtime ACL/verifier update through the normal reviewed deployment process. No deployed/remote PostgreSQL dataset is migrated during UI development. A runtime lacking the new read function safely returns unavailable; credentials/persistence must remain configured through the existing protected server deployment.

## Out of scope

Native Expo Parent App, verified multi-family/current-school selector, receipt-list and parent-absence GET, identifier-bound schedule projection, additional achievement pagination, self-service booking/absence UI, Eian/AI/provider/voice/actions, communications and all billing/payment operations remain separate work. Nothing here consumes AI credits or writes domain, audit, outbox, idempotency, action or provider records.
