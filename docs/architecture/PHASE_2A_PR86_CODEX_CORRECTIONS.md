# PR #86 — Codex Architecture Review Reconciliation

> **Result: all six documentation corrections are incorporated; final design approval remains NO-GO pending the owner decisions and dependency sequence below.**
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
| **R2 — connection ownership and credential custody** | Defines distinct platform installation, private credential binding, school connection, school asset/capability grant, HQ configuration, and future organization administration. Preserves #79 capability granularity and #80 server-only status boundary. | Versioned custody policy; approved secret facility and resolver ACL; rotation/revocation/sharing/exclusivity proof. |
| **R3 — minimal protected candidate contract** | Defines `IntegrationNormalizedCandidateV1`, metadata-only queue, no-store protected detail, field statuses, HMAC evidence digest, raw-body prohibition, and proposed envelope-encryption/retention gate. | Owner PII field, encryption/KMS, region/processor, retention/deletion/backup/rotation and reviewer policy approval. |
| **R4 — deduplication and canonical CRM transaction** | Splits delivery attempt, stable event, source occurrence, mapping resolution, review decision, disposition request, CRM effect, replay, and conflict. Defines ingress and human-disposition transaction boundaries; preserves normal `crm.lead.created` v1. | Joint contract checkpoint, one migration reservation, transaction-aware canonical create extraction, enforced inert-event non-dispatch proof. |
| **R5 — UI privacy cleanup and exact retry** | Replaces blanket retry clearing with immediate concealment plus one mounted-memory immutable request capsule; separates read epoch from command ownership; documents 401/403, reauthorization, unknown result, disabled discard, abandonment, full-document loss, accessibility, localization, and three-mode equivalence. | Backend case/disposition contract and UI controller/transport tests after approval. |
| **R6 — duplicate records, vocabulary, and evidence** | Declares #85→rebased #86 dependency, introduces plane-owned state vocabulary, removes cross-plane terms, separates historical and fresh test evidence, and retains disabled Verified Auto-Create. | #85 review/merge, #86 rebase/reconciliation, #79/#80 main reconciliation, and one joint ownership checkpoint. |

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
