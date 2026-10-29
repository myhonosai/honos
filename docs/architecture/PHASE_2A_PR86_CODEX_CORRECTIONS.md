# PR #86 — Codex Architecture Review Reconciliation

> **Result:** R1–R6 and the narrow N1–N4 documentation corrections are incorporated. PR #85’s accepted documentation baseline is reconciled into this branch. Final design approval remains **NO-GO** pending Codex’s final reconciliation review, owner decisions, #79/#80 reconciliation, and later provider-free proof gates.
>
> This is a design-reconciliation record. It does not implement a connector, call a provider, process customer data, create a schema/API, or authorize a merge, deployment, or pilot.

## Baseline and dependency state

The review originally considered canonical main `145d4cf00aa64d4b986ffd2b7a9de5462c7c6469`, PR #79 draft head `ef62eed52040eac583468e9965592fa07144355f`, PR #80 draft head `449902dfa9dc244386155cfc13f8059e0720bab4`, PR #85 draft head `09481d516bb4dbe7122f97e039d5118ac0089517`, and initial PR #86 head `41bcd0843084e2a909541d15c8c13140a95c7953`.

PR #85 subsequently merged into canonical main as squash merge `6bb8d1788bb302beaec4d59f723c438f955764ab`. That baseline contains its forced-RLS table, marketing-migration, intake-ledger, effective 80-character source-bound, C1 historical-CI, and C2 historical-assessment corrections. This branch incorporated that main commit through a normal non-destructive merge, preserved the canonical files verbatim, and no longer carries duplicate assessment/source additions in its effective diff.

PR #79 and #80 remain useful **unmerged** foundations, not installed runtime facts. They retain independent reviews and must reconcile with current main before any joint contract checkpoint.

## Corrected findings

| Finding | Corrected design response | Still required before implementation |
| --- | --- | --- |
| **R1 — tenant routing and delayed events** | Separates provider installation, private credential binding, school connection, verified asset grant, historical binding/mapping, and operator-plane quarantine. Adds six fail-closed outcomes, pinning, A→B delayed-event denial, bounded acknowledgement/retry, and no current-mapping fallback. | Owner decision on operator plane, remap/cutover rule, asset evidence, capacity/retention, and provider-free negative/security proofs. |
| **R2 — connection ownership and credential custody** | Defines distinct platform installation, private credential binding, school connection, school asset/capability grant, HQ configuration, and future organization administration. It distinguishes pre-tenant fixed-endpoint/installation-context signing-key verification from post-routing provider/data credential resolution; signing keys and API/data keys cannot substitute for one another. Preserves #79 capability granularity and #80 server-only status boundary. | Versioned custody policy, approved secret facility, narrow resolver ACL, provider-free rotation/revocation/cutover proofs for both purposes, and no #80-status substitution. |
| **R3 — minimal protected candidate contract** | Defines `IntegrationNormalizedCandidateV1`, metadata-only queue, no-store protected detail, field statuses, HMAC evidence digest, raw-body prohibition, and proposed envelope-encryption/retention gate. | Owner PII field, encryption/KMS, region/processor, retention/deletion/backup/rotation, and reviewer-policy approval. |
| **R4 — deduplication and canonical CRM transaction** | Splits delivery attempt, stable event, source occurrence, mapping resolution, review decision, disposition request, CRM effect, replay, and conflict. Defines ingress and human-disposition transaction boundaries while preserving normal `crm.lead.created` v1. | Joint contract checkpoint, one migration reservation, transaction-aware canonical create extraction, and enforced inert-event non-dispatch proof. |
| **R5 — UI privacy cleanup and exact retry** | Replaces blanket retry clearing with immediate concealment plus one mounted-memory immutable request capsule; separates read epoch from command ownership; documents 401/403, reauthorization, unknown result, disabled discard, abandonment, full-document loss, accessibility, localization, and three-mode equivalence. It requires authorized mutation-free reconciliation of original command K before any fresh execution gate. | Backend case/disposition contract and UI controller/transport tests after approval. |
| **R6 — duplicate records, vocabulary, and evidence** | The #85→#86 dependency is now complete. This branch uses one plane-owned vocabulary, retains disabled Verified Auto-Create, preserves the accepted canonical source/assessment baseline, and records GitHub Actions run `40265190111` as a verified historical source-equivalent baseline. The 1,227 result remains an unverified limited-scope observation. | #79/#80 main reconciliation, one joint ownership checkpoint, then future provider-free proofs. |

## Final targeted Codex corrections

| Finding | Corrected design response | Still required before implementation |
| --- | --- | --- |
| **N1 — post-commit recovery** | Separates historical result reconciliation of committed original command K from fresh execution after no result is proven. Reconciliation requires the same signed human, frozen school, and current result-read authority; it returns only K’s original scoped result and is mutation-free despite K-caused case version advance. | Provider-free commit/drop-response/V+1/exact-K regression, authorization/revocation negatives, and reviewed backend contract. |
| **N2 — pre-tenant signing resolution** | Defines bounded signing-key resolution only for a fixed server-registered endpoint and installation context before parsing/trusting body context. It grants no tenant/provider-data authority and cannot enumerate tenant keys. Post-routing data/API resolution remains a separate live school/grant/capability/authorization/purpose/lifecycle check. | Owner custody policy, narrow resolver ACL, and provider-free negative/rotation/revocation/cutover proofs. |
| **N3 — evidence accounting** | Records 1,818 workspace tests including 509 API tests, 41 PostgreSQL proofs, and 181 migrations through 0189 as verified historical CI facts for a source-equivalent main tree. It does not claim this docs-only PR reran them. The 1,227 report is explicitly unverified/limited-scope, with no invented cause. | Sanitized reproducible record if the 1,227 observation is to be promoted or explained; future exact-head implementation runs must supply full-scope evidence. |
| **N4 — Boundary A/B diagram precision** | Diagrams show Boundary A reservation → deduplication → historical routing → durable outcome → adapter response, and Boundary B’s create path as one atomic decision/case/effect/canonical-CRM/provenance/audit-result commit. Boundary annotations remain outside the receipt, review, CRM, and browser state planes. | Provider-free fault/concurrency tests and visual re-review of rendered diagrams; no implementation is authorized by an annotation. |

## Security design remains unchanged

The normal reconciliation does not change the substance of historical evidence-based routing; purpose-separated signing and provider/data credentials; encrypted minimal candidate-data requirements; stable event/effect identities; atomic human-authorized CRM creation; exact retry/historical-result recovery; privacy shielding/session authorization; English/Korean/Spanish and three presentation modes; or disabled Verified Auto-Create.

The following remain explicit **NO-GO** conditions:

- No provider key, OAuth, secret resolver, provider SDK/client, webhook route, provider call, raw payload retention, or customer-data processing.
- No table/migration/API/UI implementation, review queue, CRM create, attach/merge, Action Engine operation, AI invocation, message, payment, enrollment, or deployment.
- No use of a signature, `externalId`, form/account/campaign label, current mapping, credential status, default account, or browser selector as school authority.
- No provider or protected-candidate PII in routine receipts, audit/outbox, logs, URLs, browser storage, telemetry, status projections, or an unapproved operator plane.
- No automatic CRM effect, policy seed, execution principal, or consumer for Verified Auto-Create.

## Required owner approvals

1. Credential custody and secret-facility policy.
2. School asset/capability grant, organization administration, historical remap/cutover, and optional operator-plane policy.
3. Candidate data field/custody/encryption/retention/backup/region/reviewer policy.
4. Human disposition, normal CRM create, duplicate/reconciliation, and inert-event/consumer policy.
5. Provider sandbox/live/cost/operating/capacity/incident/kill-switch policy.
6. Any future Verified Auto-Create policy, separately.

See the [corrected ingress design](PHASE_2A_INTEGRATION_INGRESS_DESIGN.md), [state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md), [UI specification](INTEGRATION_REVIEW_UI_SPEC.md), [verification plan](PHASE_2A_INTEGRATION_VERIFICATION_AND_ROLLOUT.md), and the [canonical readiness assessment](../assessments/PHASE_2_CRM_INTEGRATION_READINESS.md).
