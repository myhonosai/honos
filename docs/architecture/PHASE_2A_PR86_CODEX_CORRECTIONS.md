# PR #86 — Codex Architecture Review Reconciliation

> **Result: R1–R6 and the narrow N1–N4 documentation corrections are incorporated; final design approval remains NO-GO pending Codex re-review, owner decisions, and the dependency sequence below.**
>
> This is a design reconciliation record. It does not implement a connector, call a provider, process customer data, create a schema/API, or authorize a merge, deployment, or pilot.

## Reviewed report

The correction responds to Codex’s [independent review comment](https://github.com/myhonosai/honos/pull/86#issuecomment-6410397384), based on:

- canonical main `145d4cf00aa64d4b986ffd2b7a9de5462c7c6469`;
- PR #79 draft head `ef62eed52040eac583468e9965592fa07144355f`;
- PR #80 draft head `449902dfa9dc244386155cfc13f8059e0720bab4`;
- PR #85 draft head `09481d516bb4dbe7122f97e039d5118ac0089517`; and
- initial PR #86 head `41bcd0843084e2a909541d15c8c13140a95c7953`.

PR #79 and #80 are useful unmerged foundations, not installed runtime facts. PR #85 and #86 were sibling documentation branches; #85 must remain independent and preserve its unique documentation corrections.

## Corrected findings

| Finding | Corrected design response | Still required before implementation |
| --- | --- | --- |
| **R1 — tenant routing and delayed events** | Separates provider installation, private credential binding, school connection, verified asset grant, historical binding/mapping, and operator-plane quarantine. Adds exact six fail-closed outcomes, pinning, A→B delayed-event denial, bounded acknowledgement/retry, and no current-mapping fallback. | Owner decision on operator plane, remap/cutover rule, asset evidence, capacity/retention; provider-free negative/security proofs. |
| **R2 — connection ownership and credential custody** | Defines distinct platform installation, private credential binding, school connection, school asset/capability grant, HQ configuration, and future organization administration. It now distinguishes pre-tenant fixed endpoint/installation-context signing-key verification from post-routing provider/data credential resolution; signing keys and API/data keys cannot substitute for one another. Preserves #79 capability granularity and #80 server-only status boundary. | Versioned custody policy; approved secret facility and narrow resolver ACL; provider-free rotation/revocation/cutover proofs for both purposes; no #80 status substitution. |
| **R3 — minimal protected candidate contract** | Defines `IntegrationNormalizedCandidateV1`, metadata-only queue, no-store protected detail, field statuses, HMAC evidence digest, raw-body prohibition, and proposed envelope-encryption/retention gate. | Owner PII field, encryption/KMS, region/processor, retention/deletion/backup/rotation and reviewer policy approval. |
| **R4 — deduplication and canonical CRM transaction** | Splits delivery attempt, stable event, source occurrence, mapping resolution, review decision, disposition request, CRM effect, replay, and conflict. Defines ingress and human-disposition transaction boundaries; preserves normal `crm.lead.created` v1. | Joint contract checkpoint, one migration reservation, transaction-aware canonical create extraction, enforced inert-event non-dispatch proof. |
| **R5 — UI privacy cleanup and exact retry** | Replaces blanket retry clearing with immediate concealment plus one mounted-memory immutable request capsule; separates read epoch from command ownership; documents 401/403, reauthorization, unknown result, disabled discard, abandonment, full-document loss, accessibility, localization, and three-mode equivalence. It now requires an authorized mutation-free reconciliation of original command K before any fresh execution gate, so K-caused version advance cannot erase its own recovery. | Backend case/disposition contract and UI controller/transport tests after approval. |
| **R6 — duplicate records, vocabulary, and evidence** | Declares #85→rebased #86 dependency, introduces plane-owned state vocabulary, removes cross-plane terms, retains disabled Verified Auto-Create, and records GitHub Actions run `40265190111` as the verified source-equivalent canonical-main baseline. The 1,227 result remains an unverified limited-scope observation without a reproducible sanitized evidence record. | #85 review/merge, #86 rebase/reconciliation, #79/#80 main reconciliation, and one joint ownership checkpoint. |

## Final targeted Codex corrections

| Finding | Corrected design response | Still required before implementation |
| --- | --- | --- |
| **N1 — post-commit recovery** | Separates historical result reconciliation of committed original command K from fresh execution after no result is proven. Reconciliation requires the same signed human, frozen school, and current result-read authority; it returns only K’s original scoped result and is mutation-free despite K-caused case version advance. | Provider-free commit/drop-response/V+1/exact-K regression, authorization/revocation negatives, and reviewed backend contract. |
| **N2 — pre-tenant signing resolution** | Defines bounded signing-key resolution only for a fixed server-registered endpoint and installation context before parsing/trusting body context. It grants no tenant/provider-data authority and cannot enumerate tenant keys. Post-routing data/API resolution remains a separate live school/grant/capability/authorization/purpose/lifecycle check. | Owner custody policy, narrow resolver ACL, and provider-free negative/rotation/revocation/cutover proofs. |
| **N3 — evidence accounting** | Records 1,818 workspace tests including 509 API tests, 41 PostgreSQL proofs, and 181 migrations through 0189 as Codex-verified historical CI facts for a source-equivalent main tree. Does not claim this docs-only PR reran them. The 1,227 report is explicitly unverified/limited-scope, with no invented cause. | Sanitized reproducible record if the 1,227 observation is to be promoted or explained; future exact-head implementation runs must supply full scope evidence. |
| **N4 — Boundary A/B diagram precision** | Diagrams now show Boundary A reservation → deduplication → historical routing → durable outcome → adapter response, and show Boundary B’s create path as one atomic decision/case/effect/canonical-CRM/provenance/audit result commit. Boundary annotations remain outside the receipt, review, CRM, and browser state planes. | Provider-free fault/concurrency tests and visual re-review of rendered diagrams; no implementation is authorized by an annotation. |

## Implementation is still prohibited

The following remain explicit NO-GO conditions:

- No provider key, OAuth, secret resolver, provider SDK/client, webhook route, provider call, raw payload retention, or customer-data processing.
- No table/migration/API/UI implementation, review queue, CRM create, attach/merge, Action Engine operation, AI invocation, message, payment, enrollment, or deployment.
- No use of a signature, `externalId`, form/account/campaign label, current mapping, credential status, default account, or browser selector as school authority.
- No provider or protected-candidate PII in routine receipts, audit/outbox, logs, URLs, browser storage, telemetry, status projections, or an unapproved operator plane.
- No automatic CRM effect, policy seed, execution principal, or consumer for Verified Auto-Create.

## Documentation dependency cleanup

The current corrected PR must not supersede PR #85. Once #85 is accepted, rebase/reconcile this PR against the accepted baseline, remove duplicate assessment/source records, preserve #85’s CI/RLS, marketing migration, intake-ledger, and source-bound corrections, and rerun link/scope review. Until then, cross-PR references are explicit external links rather than a claim that duplicate records are canonical here.

## Required owner approvals

1. Credential custody and secret-facility policy.
2. School asset/capability grant, organization administration, historical remap/cutover, and optional operator-plane policy.
3. Candidate data field/custody/encryption/retention/backup/region/reviewer policy.
4. Human disposition, normal CRM create, duplicate/reconciliation, and inert-event policy.
5. Provider sandbox/live/cost/operating/capacity/incident/kill-switch policy.
6. Any future Verified Auto-Create policy, separately.

See the [corrected ingress design](PHASE_2A_INTEGRATION_INGRESS_DESIGN.md), [state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md), [UI specification](INTEGRATION_REVIEW_UI_SPEC.md), and [verification plan](PHASE_2A_INTEGRATION_VERIFICATION_AND_ROLLOUT.md).
