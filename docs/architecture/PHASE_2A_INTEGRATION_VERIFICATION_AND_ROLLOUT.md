# Phase 2A — Integration Verification and Rollout Plan

> **Status: design-only verification plan.** Nothing in this document authorizes provider configuration, credentials, webhook delivery, customer-data persistence, CRM mutation, automation, sandbox use, spend, or deployment.

## 1. Dependency and ownership sequence

| Order | Gate | Owner / outcome | Not authorized yet |
| --- | --- | --- | --- |
| 1 | Review PR #85 | Canonical readiness/source documentation, including its unique corrections | No integration design approval or implementation |
| 2 | Rebase/reconcile PR #86 on accepted #85 | Remove duplicate records and retain links to canonical baseline | No provider foundation or code |
| 3 | Reconcile #79 and #80 independently with current main | Codex-owned capability/asset and server-only configuration foundations | No school connector, webhook, PII, or CRM authority |
| 4 | Joint contract checkpoint | Manus/Codex agree versioned receipt/candidate/review/disposition/effect contract, one migration reservation, lock order, and code ownership | No competing backend/UI implementation |
| 5 | Provider-free simulation | Prove fail-closed ingress, custody, PII, identity, and transaction invariants | No real vendor call or credential |
| 6 | Human disposition proof | Prove atomic canonical CRM effect and inert-event exclusion | No pilot or auto-create |
| 7 | UI proof | Prove privacy shield, exact recovery, scope/session safety, accessibility, localization, and three-mode equivalence | No live provider data |
| 8 | Owner-approved sandbox/pilot | Explicit vendor, cost, PII, operational, and go/no-go approval | No automatic live expansion |

Manus owns this corrected design, future CRM review/disposition/provenance contract, and the PR #85/86 documentation dependency. Codex owns #79/#80 provider connection, capability/asset grant, credential-custody, and ingress-security foundations. Shared frontend transport/privacy/localization and Integration Review UI start only after the backend contract is accepted.

## 2. Evidence terminology

Documentation must distinguish exact run facts from historical assertions. This documentation-only PR does not claim it reran tests, migrations, provider verification, or connector checks.

- Canonical baseline cited by Codex: `145d4cf00aa64d4b986ffd2b7a9de5462c7c6469`.
- Fresh isolated audit evidence received during this correction reports `pnpm test` at that SHA as **1,227** passing workspace tests: API 383, web 565, auth 91, domain 188; 181 migration files; highest migration label 0189.
- The previously stated 1,818-workspace / 509-API figures are retained only as unverified historical claims until their exact SHA, command, date, and package scope are reproduced. They must not be presented as the current-main total or as proof of this design PR.

A future implementation proof must report exact commit SHA, command, package scope, environment, run date, passed/skipped/blocked result, and cleanup result. A skipped/blocked/incomplete run is never reported as passing.

## 3. Required proof matrix

| Boundary | Required proof before implementation acceptance |
| --- | --- |
| Tenant resolution | Shared endpoint with unknown profile; valid signature/no tenant; ambiguous asset; forged tenant-like `externalId`; unknown form; two-school/cross-organization denial; no school queue/candidate/detail record until unique historical binding proves one school. |
| Historical cutover | A first-seen delayed delivery across A→B remap; event-time/cutover boundary tests; stale current mapping cannot expose A data to B; no automatic reassignment/copy/attach/merge. |
| Routing outcomes | Exact durable outcome, visibility, acknowledgement, retry, replay, conflict, and reconciliation behavior for all six fail-closed codes; `2xx` only after the bounded outcome commits. |
| Capacity and operator plane | Installation/connection byte, rate, concurrency, unresolved and dead-letter limits; saturation fails closed with no PII spill; optional operator-plane quarantine permission/retention/audit/metadata-only projection. |
| Credential custody | No secret/vault locator in ordinary rows/projections/logs; resolver ACL; platform/binding/connection/grant revoke and rotation propagation; no #80 HQ-status substitution for school authority. |
| Candidate privacy | V1 field allowlist; invalid/unknown-field rejection without retained rejected value; queue/audit/outbox/error/URL/storage/telemetry redaction; encrypted detail access only after owner-approved KMS/retention/backup/rotation implementation. |
| Receipt identities | Delivery attempt/event/source occurrence/mapping resolution/replay/conflict separation; same-digest replay; different-digest immutable conflict; reconnect/remap cannot form a new dedup namespace. |
| Human disposition | Unique `source_occurrence_id` CRM effect across two reviewers and browser keys; original idempotency/fingerprint conflict; deterministic lock ordering; rollback injection; stage/permission/entitlement revocation during wait; unknown-result reconciliation. |
| Canonical CRM behavior | Future transaction-aware reuse passes existing direct-human LeadService regressions unchanged; no nested transaction assumption; ordinary `crm.lead.created` v1 unchanged; integration evidence event structurally excluded from generic outbox claiming, automation, Action Engine, and consumers. |
| UI privacy and recovery | Explicit load; no data before scope; visual/accessibility-tree concealment; pending blur/hidden settlement; post-commit response loss with original-key exact retry; 401 global invalidation versus local 403; changed user/school destruction; disabled discard while unsettled; acknowledged abandonment; document-loss non-survival. |
| Presentation/accessibility | English/Korean/Spanish static catalog coverage; keyboard, screen reader, focus, contrast, reflow, reduced motion, 44px phone targets, no overflow; Modern/Classic/Big-Button switch creates no data/authority/request/capsule effect. |

## 4. Focused implementation PR breakdown — after owner approval only

1. **Contract checkpoint PR:** one migration reservation; closed provider-installation/credential-binding/connection/asset-grant/mapping-history/receipt identity vocabulary; no provider call, webhook, or PII.
2. **Ingress simulation PR:** fixed signed simulated payload adapter; six fail-closed outcomes; receipt/replay/conflict/quotas; no external provider and no CRM mutation.
3. **Protected candidate/custody PR:** only after owner PII policy; V1 contract, encryption/key custody/retention proof, metadata queue/detail boundary; no auto-create.
4. **Human disposition PR:** transaction-aware canonical CRM primitive, unique effect reservation, direct-human review decision, inert non-dispatchable evidence event; no attach/merge/automation.
5. **Integration Review UI PR:** after backend proof; isolated transport/state/controller/privacy/accessibility/localization/presentation work only.
6. **Provider pilot PR:** only after all prior gates and separate owner approval of vendor credentials, sandbox/live environment, PII processing, cost, monitoring, kill switch, incident/reconciliation plan, and load thresholds.

Each PR must include targeted tests, negative ACL/RLS checks, exact evidence update, and a fresh review of concurrent branches. None may silently broaden this scope.

## 5. Capacity and operating considerations

The 20-, 100-, and 1,000-school figures are planning checkpoints, not supported throughput or price claims.

| Planning scale | What must be measured before advancing |
| --- | --- |
| 20 schools | Per-installation/connection ingress rate, bounded webhook acknowledgement time, database pool/lock behavior, review queue latency, failure/replay/rollback evidence, operator burden, and cost telemetry without PII. |
| 100 schools | Shared-installation versus school binding isolation, mapping/cutover pressure, rate/byte/concurrency quotas, backlog drain, key rotation/revocation fan-out, reconciliation staffing, and representative failure injection. |
| 1,000 schools | Partition/index/pool/capacity plan, tenant-noisy-neighbor limits, outage/dead-letter recovery, retention/crypto-erasure and backup behavior, regional/processor policy, incident drills, provider limit evidence, and owner-approved operating cost model. |

No table above is a provider SLA, operating forecast, billing quote, health measure, or approval to purchase/use a provider. The future pilot requires cost and operational approval separately.

## 6. Disabled future extension: Verified Auto-Create

`Verified Auto-Create` remains `DISABLED`. This document creates no seed policy, approved checkbox, execution principal, tool, consumer, route, or automatic CRM action.

A later proposal requires its own owner approval for exact connection/asset/school binding, policy version/effective window, validation/duplicate rules, emergency stop, nonhuman execution principal, normal-domain CRM contract, audit, and revocation. It cannot impersonate a human or derive authority from a signature, API key, AI persona, or checkbox.

## 7. Owner decisions required

Before any implementation, approve credential custody, asset/capability/organization administration policy, historical remap treatment, optional operator-plane quarantine, candidate PII/encryption/retention/backup/region policy, reviewer/disposition/duplicate policy, inert-event/consumer policy, vendor sandbox/live/cost, pilot scope, capacity acceptance thresholds, kill switch, and incident/reconciliation handling.

See the [corrected ingress design](PHASE_2A_INTEGRATION_INGRESS_DESIGN.md), [UI specification](INTEGRATION_REVIEW_UI_SPEC.md), and [state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md).
