# Phase 2B Joint Contract Checkpoint

**Status:** Documentation-only contract checkpoint. It is a **NO-GO for runtime work** and does not authorize a migration, schema, persistence, controller, route, provider request, credential/key configuration or use, candidate/customer data, CRM mutation, payment activity, deployment, or activation.

**Baseline:** Canonical `main` contains merged META-1 / PR #79, Phase 2A, and PR #80's narrowly retained Zernio source foundation. PR #80 remains server-only, disabled, and non-authorizing: `HON_ZERNIO_VERIFICATION_APPROVED` stays absent or false, `ZERNIO_API_KEY` is not configured or used, and no verification, connection, mapping, ingress, provider operation, or activation may occur.

**Version:** `HON-INTEGRATION-V1.0.0-proposed`

![Phase 2B gated contract flow](../diagrams/phase-2b-contract-flow.png)

## 1. Purpose and gate split

This is the joint Manus/Codex contract to settle **before** a provider-neutral inbound-integration implementation starts. It preserves the accepted Phase 2A authority model: raw-byte signature verification before parsing; distinct installation, opaque private binding, school connection, exact asset grant, and historical mapping planes; organization/school composite scope; FORCE RLS; no browser/default-account/current-map tenant authority; and no-effect boundaries.

The former all-or-nothing G1 bundle is intentionally split. Approval of one row never authorizes another row.

| Gate | What it could authorize after explicit owner/joint approval | What it never authorizes |
| --- | --- | --- |
| **G1-A: 2B-1 written V1 vectors** | Closed contract/vector documentation, code-boundary map, recovery/lock/reservation agreement | DDL, persistence, routes, resolvers, credentials, provider I/O, candidate data, UI, CRM mutation, payment, AI, or activation |
| **G1-B: 2B-2/2B-3 provider-free foundation** | Later opaque authority/receipt records, artificial mappings, fixed synthetic bytes/test signing generations, zero-network assertions | A real secret facility, actual credential, KMS, protected-data retention, provider account/call, sandbox, cost, or operations policy |
| **G1-C: 2B-4 custody** | Protected-candidate allowlist and separately approved encryption/KMS/region/retention/backup/deletion boundary | Raw-body retention, provider activation, CRM effect, UI, or broad customer-data use |
| **G1-D: 2B-5 disposition** | Reviewer/result-read/create policy, canonical CRM primitive, source/stage/duplicate policy, and inert-consumer proof | Auto-create, attach/merge/update, provider contact, messaging, payment, AI, or automation |
| **G1-E: 2B-6 UI** | Response-backed UI only after backend/security evidence and visual-collaboration clearance | Browser-supplied authority, persistence, raw data, provider setup, or automatic execution |
| **G1-F: separate provider pilot** | A later real-vendor/sandbox/live operational decision | Any retrospective approval for earlier slices or Pitbull payment work |

## 2. Contract planes and immutable records

Each plane owns its state. A field, lifecycle, or status in one plane cannot confer authority in another plane.

| Plane | Proposed V1 record | Scope and purpose | Explicitly not authority for |
| --- | --- | --- | --- |
| Installation | `IntegrationInstallationV1` | Platform-registered endpoint and signing-key-generation eligibility | School selection, candidate identity, provider-data API use, CRM effect |
| Private binding | `CredentialBindingReferenceV1` | Opaque purpose-scoped custody reference and version | Secret disclosure, vault location, school connection, asset permission |
| School connection | `SchoolProviderConnectionV1` | Historical school-scoped lifecycle relationship to an installation | Default routing, browser selection, CRM authorization |
| Exact grant | `SchoolProviderAssetGrantV1` | Exact profile/account/Page/form capability grant and grant history | Wildcard school/organization authority or current-map fallback |
| Mapping | `HistoricalMappingRevisionV1` | Immutable source-asset lineage to connection/grant evidence over time | Rewriting received history or changing a dedupe namespace |
| Receipt | `InboundReceiptV1` | Canonical signed event identity, digest classification, routing result, and bounded outcome | Candidate display, lead creation, provider operation |
| Source occurrence | `IntegrationSourceOccurrenceV1` | Stable, historically owned provider lead-occurrence identity, distinct from delivery attempts/events | Attach/merge, alternate lead creation, cross-school movement |
| Review | `IntegrationReviewCaseV1` | Human review state and metadata-only projection | Automatic execution or protected-candidate storage |
| Disposition | `IntegrationDispositionRequestV1` | Original direct-human command `K`, fingerprint, frozen scope, and durable result | A new retry key, delegated/AI authority, or replay mutation |
| CRM effect | `IntegrationCrmEffectV1` | One source-occurrence-to-canonical-lead provenance/result | Ordinary outbox, automation, Action Engine, AI, communications, or provider dispatch |
| Browser lifecycle | `IntegrationReviewBrowserStateV1` | Ephemeral response/capsule concealment and recovery posture | Durable evidence, background retry, authority, or persistence |

All ordinary rows remain organization/school composite-scoped where applicable, subject to FORCE RLS, least privilege, fixed-function boundaries, immutable history, and redacted audit evidence.

### 2.1 Installation and purpose-separated custody

```text
IntegrationInstallationV1
  installationId (server generated)
  providerKind (closed enum)
  endpointKind (closed enum)
  signingKeyGenerationId (opaque historical selector)
  lifecycle (disabled | proposed | active-for-synthetic-test | revoked)

CredentialBindingReferenceV1
  bindingId (opaque)
  purpose (webhook-signature | provider-data-operation)
  keyVersion (opaque version, never material)
  lifecycle (proposed | active | rotated | revoked | disabled)
  custodyPolicyVersion
```

A fixed server-registered endpoint and installation/key-generation context may resolve only an eligible historical **webhook-signing** generation to authenticate bounded raw bytes before parsing. It cannot derive a key from an untrusted school/profile/body selector, enumerate tenants, expose material, or confer school, candidate, CRM, grant, or provider-data authority.

A provider-data operation remains a separate post-routing purpose. It requires verified school connection, exact asset/capability grant, current server authorization, correct credential purpose and lifecycle, and a post-lock recheck. Signing and provider-operation material are non-substitutable.

### 2.2 Historical connection, source asset, and mapping

```text
SchoolProviderConnectionV1
  organizationId + schoolId (immutable composite scope)
  connectionId + installationId + credentialBindingId (opaque only)
  lifecycle + lifecycleVersion

SchoolProviderAssetGrantV1
  grantId + connectionId
  providerAssetKind + providerAssetOpaqueReference
  closed capabilitySet
  grantLifecycle + grantVersion

SourceAssetLineageV1
  sourceAssetLineageId
  installationId + immutable verified sourceAssetOpaqueReference
  continuityEvidenceVersion
  lineageLifecycle

HistoricalMappingRevisionV1
  mappingRevisionId + sourceAssetLineageId + grantId
  effectiveFrom / effectiveUntil (UTC `[from, until)` interval)
  mappingVersion + mappingTrustCode
```

A provider account, profile, Page, form, URL, browser selector, external ID, present mapping, or default account never chooses a tenant. A received fact routes only through an exact historically valid installation → source-asset-lineage → connection → grant → mapping chain.

`sourceOccurredAt` is usable only when it is signed/authenticated under the provider-neutral adapter contract, normalizes to UTC, and carries a closed provenance/trust code. The server also records a durable received time. For one historically trusted source-asset lineage with contiguous mappings School A `[fromA, T)` then School B `[T, untilB)`, a verified `t < T` selects A and a verified `t = T` selects B: the lower boundary is inclusive and the upper boundary is exclusive. Missing, malformed, unsigned, untrusted, conflicting, overlapped, or **gapped** source time is **not** replaced by received time/current mapping/default selection: it reaches the existing bounded unknown/ambiguous non-school outcome. A delayed first-seen A event after A→B remap remains A when its verified `[from, until)` time proves A. An already recorded fact is never reparented to B.

A reconnect may continue a `SourceAssetLineageV1` only with explicit immutable continuity evidence. A reconnect/remap never creates a fresh event or occurrence namespace. Conversely, matching provider labels on distinct proven asset lineages are never merged.

### 2.3 Receipt and source-occurrence identity

```text
InboundReceiptV1
  installationLineageId + stableProviderEventIdentity
  eventIdentityCanonicalizationVersion
  digestAlgorithm + digestEncoding + digestCanonicalizationVersion
  protectedDigestInputDomainVersion
  historicalMappingRevisionId (nullable only for approved non-school quarantine)
  receiptState + bounded routingOutcome + receiptVersion

IntegrationSourceOccurrenceV1
  sourceOccurrenceId
  installationLineageId + sourceAssetLineageId
  canonicalProviderOccurrenceIdentity
  sourceIdentityCanonicalizationVersion
  immutable organizationId + schoolId + historicalMappingRevisionId
  sourceOccurredAt + sourceOccurredAtTrustCode + receivedAt
```

A physical delivery attempt is distinct from a canonical signed event/receipt. `(installation lineage, event-identity canonicalization version, stable provider event identity)` has one canonical receipt. The same identity plus the same comparable digest replays its original durable classification. The same identity plus a different digest becomes immutable `IDENTITY_CONFLICT`; it never overwrites, remaps, or creates a new case/effect.

A source occurrence is private evidence. Its immutable source key is the installation lineage, immutable source-asset lineage, canonical provider occurrence identity, and source-identity canonicalization version. It must not use delivery attempt, mutable connection ID, grant revision, mapping revision, browser selection, or current mapping as identity input. Many canonical receipts/events may resolve to one occurrence only under this closed source identity.

The future schema must enforce: one receipt-to-occurrence relation where eligible; at most one active/review case per occurrence; `IntegrationCrmEffectV1.sourceOccurrenceId` unique; and one immutable historical composite owner. Parser, digest, or canonicalization revisions require an explicit versioned reconciliation rule and may not widen a replay into a new namespace.

## 3. Boundary A: pre-tenant ingress and six outcomes

Ingress remains provider-neutral and has no CRM effect. Its fixed order is:

1. fixed endpoint and eligible signing-key generation;
2. bounded raw-byte signature verification **before** parsing or trusting body context;
3. event-identity reservation;
4. digest replay/conflict classification;
5. historical source-asset/connection/grant/mapping resolution;
6. one durable receipt state plus bounded outcome; and only then
7. adapter response.

No acknowledgement may precede the durable outcome. An eligible uniquely routed receipt uses canonical `ReceiptState.ROUTED_TO_REVIEW`; this receipt state is distinct from the six fail-closed routing outcome/reason codes and is not a seventh outcome.

| Outcome | Durable handling | School visibility | Adapter behavior |
| --- | --- | --- | --- |
| `SIGNATURE_REJECTED` | Bounded security telemetry only; no parsed body | None | Permanent rejection; no school write |
| `MALFORMED_REJECTED` | Minimal validated failure code only after signature verification | None | Permanent rejection; no business write |
| `UNSUPPORTED_VERSION_QUARANTINED` | Metadata-only operator-plane outcome only if separately approved | None by default | Acknowledge only after bounded outcome commits |
| `UNKNOWN_BINDING_QUARANTINED` | Metadata-only operator-plane outcome only if separately approved | None | Acknowledge only after durable outcome; otherwise reject |
| `AMBIGUOUS_BINDING_QUARANTINED` | Metadata-only operator-plane outcome only if separately approved | None | Acknowledge only after durable outcome; otherwise reject |
| `RETRY_AMBIGUOUS_RECONCILIATION_REQUIRED` | Original identity reconciliation state | None until reconciliation | No fresh effect/new identity before approved reconciliation policy |

## 4. Revocation by operation plane

No revocation introduces a new lifecycle enum or reassigns historical ownership.

| Operation plane | Current revoke/disable behavior | Immutable protection |
| --- | --- | --- |
| Pre-tenant signing | Revoked/disabled signing context reaches `SIGNATURE_REJECTED` before parse | No school/provider-data/CRM authority is created |
| Historical ingress routing | Revoked/disabled connection, grant, or mapping cannot create a school route; use existing non-school reject/quarantine semantics | No A receipt/occurrence/case is moved to B and no current-map fallback occurs |
| Provider operation | Recheck connection, exact grant/capability, purpose, credential lifecycle, and current server authorization after wait; deny **before** credential resolution or I/O | Never substitute signing key, other credential, default account, or mapping |
| Pending review | Current read revoke conceals/denies facts; current decide/create revoke blocks a new disposition/effect | Historical A case/evidence remains pinned; no copy, reroute, merge, or new dedupe namespace |
| Historical K result read | Same-human/frozen-school/current result-read authority may return K's committed scoped/redacted result; lost result-read denies/conceals | K, receipt, result, and provenance remain immutable |
| Fresh CRM mutation | Only a proven absent durable K result may proceed; any post-wait relevant revoke denies with no new key/effect | No decision, lead, effect, audit, outbox, or inert evidence writes survive |

## 5. Boundary B: original-K result read before fresh mutation

Boundary B is direct-human only. It receives no provider call, raw payload, inferred consent, delegated authority, or AI decision.

### 5.1 Result-read reconciliation — terminal, mutation-free

1. Reauthorize the **same signed human**, frozen organization/school, current `crm.integration_review.read` authority, original immutable K/fingerprint, and availability of K's private scoped receipt/result.
2. Reconcile only K's durable result.
3. If K is committed, return only K's original scoped/redacted result and **STOP with zero new writes**.

K-caused case/evidence/mapping/policy version advance, K closing its case, response loss, or later loss of decide/create authority cannot defeat an otherwise authorized historical result read. Changed subject/school, unavailable scoped receipt, invalid fingerprint, or lost result-read authority conceals/denies and **STOPs**. Unavailable evidence is never proof that no durable result exists.

### 5.2 Fresh mutation — only after proven absence

Only a proven absence of K's durable result may enter fresh execution, using unchanged K, fingerprint, subject, frozen scope, and idempotency identity. It then requires current `crm.integration_review.decide`, normal CRM-create authority, entitlement, eligible case/evidence/mapping/policy versions, source-occurrence/effect uniqueness, pipeline-stage/source/duplicate checks, and every post-wait recheck.

If any fresh gate fails or unrelated drift occurs, stop with no new key, action, effect, or writes. On success, one outer transaction commits review decision/case closure, unique source-occurrence effect reservation, transaction-aware canonical CRM creation, scoped provenance/result, redacted audit, and structurally inert integration evidence together; any failure rolls all of them back.

The internal `createInExistingTenantTransaction` primitive is available only after the outer transaction established the shared authorization prefix, K/case/source/effect locks, and rechecks. It must not call public `LeadService.create`, start/commit a nested transaction, mint a second idempotency identity, duplicate policy, or become a generic authorization bypass. Ordinary direct-human `LeadService.create` and dispatchable `crm.lead.created` v1 remain unchanged. Integration evidence is structurally unclaimable by outbox, automation, Action Engine, AI, communications, and generic consumers.

## 6. Shared lock-order contract

Exact relation names remain implementation work, but the rank/order is a contract requirement.

### Shared authorization prefix for every human/admin path

1. organization `FOR UPDATE`;
2. school `FOR UPDATE`;
3. user `FOR UPDATE`;
4. principal `FOR UPDATE`;
5. principal-role grants ordered by ID `FOR UPDATE`;
6. roles ordered by ID `FOR UPDATE`;
7. role permissions ordered by role/permission `FOR SHARE`; and
8. organization entitlements `FOR SHARE`.

This is the accepted `hon.lock_campaign_actor` prefix. A result-read/decision extension cannot introduce a competing prefix.

### Local ranks after the prefix

| Path | Local order after the applicable prefix |
| --- | --- |
| Boundary A after pre-tenant verification | installation/event identity → digest classification → immutable historical lineage/mapping evidence → receipt/outcome |
| Historical K result read | original K/result → return scoped durable result; no local mutation lock is acquired |
| Fresh Boundary B | original K → review case/version → source occurrence → unique CRM effect → canonical duplicate/provenance guard → lead/provenance/audit/inert evidence |
| Administrative connection/grant/mapping/remap/revocation writer | connection → grant → mapping/lifecycle/revision, after shared authorization prefix |
| Ordinary direct-human `LeadService.create` | retains its existing shared prefix and behavior |

After every wait, recheck current human/frozen scope, result-read versus decide/create authority, entitlement, K fingerprint, case/evidence/mapping/policy version and state, source occurrence/effect uniqueness, connection/grant/mapping lifecycle/historical validity, and ordinary CRM inputs. A newly observed remap/revoke fails closed for a fresh operation; it never rewrites historical evidence or destroys an authorized committed K result.

Serialization/deadlock/unknown-response handling restarts at the shared authorization prefix and reconciles original K first. A committed K returns and stops; only proven absence allows the unchanged-K fresh attempt. No retry can create a new key/request/lead/decision/effect/audit/outbox/inert-evidence record. Both arrival orders must be barrier-proven for ordinary CRM versus fresh Boundary B and administrative writer versus ingress/fresh Boundary B.

## 7. Shared migration coordination record

`0179` and `0180` remain untouched. `0190` is **not** an exclusive Phase 2B allocation.

| Field | Current coordination value |
| --- | --- |
| State | Owner-approved priority reservation: PR #82 holds the existing physical `0190` claim |
| Owner decision evidence | [PR #87 owner priority decision](https://github.com/myhonosai/honos/pull/87#issuecomment-6460748455) |
| Approved priority holder | PR #82, branch `codex/a2p-1-backend`, head `e35754188a618167305696a3e021fcc629f4fc3b` |
| Existing file | `packages/database/migrations/0190_a2p_registration_preparation.sql` |
| Recorded content checksum | SHA-256 `266d6a2f25a8051bce80cf625a0ae333bd8032fb3a1ae0b437bb4a03d36f5638` |
| Main high-water mark at review | 181 files through `0189` |
| Phase 2B status | 2B-1 records the resolved reservation only; 2B-2 has **no assigned migration number** and must obtain a later explicit shared allocation |

The owner decision above resolves priority for the existing `0190` claim only. It is not permission to merge or advance PR #82 and does not authorize Phase 2B runtime work, DDL, or any migration. PR #82 remains subject to its independent review, conflict, security, CI, and owner-approval gates. The one authoritative **future allocation** record for a Phase 2B consumer must identify the approved consumer and newly available number, timestamp, review/approval evidence, eventual merge commit, and post-merge validation after rechecking canonical main and concurrent branches. Do not rename #82, silently select a replacement number, or add a migration in this documentation PR.

## 8. Ownership and required future evidence

| Slice | Manus | Codex | Gate and mandatory future proof |
| --- | --- | --- | --- |
| 2B-1 | Review recovery, CRM, no-effect semantics | Review installation/custody/ingress boundary | G1-A; closed V1 vectors for occurrence/routing/recovery/revocation/lock/reservation; no runtime surface |
| 2B-2 | Review RLS/provenance/no-effect tests | Private authority/receipt schema | G1-B plus fresh allocation; RLS/ACL/immutability/composite-scope proof |
| 2B-3 | Review no-effect simulator proof | Deterministic provider-free simulator | G1-B; signed input, routing, reconnect/remap, zero-network, replay/conflict proof |
| 2B-4 | Candidate/review semantics | Custody infrastructure | G1-C; PII/KMS/retention/revocation proof |
| 2B-5 | Review disposition/canonical primitive | Cross-review | G1-D; two-reviewer/two-K, post-wait revoke, recovery, rollback, actual claimer exclusion |
| 2B-6 | API/recovery review | Response-backed UI | G1-E; mounted privacy/accessibility/localization/mode/performance evidence |
| Provider pilot | Cross-review | Cross-review | G1-F; separate credential/vendor/sandbox/cost/kill-switch/capacity/incident/reconciliation decision |

## 9. Owner decisions

Recommended defaults are deny/disabled until each consuming slice is approved:

1. G1-A: joint V1 vectors, code-boundary map, shared lock order, and PR #82 migration priority record only.
2. G1-B: opaque provider-free authority/receipt records, artificial mapping, fixed synthetic bytes/test signing generations, and zero-network proof only.
3. G1-C: protected candidate allowlist plus encryption/KMS/region/retention/backup/deletion.
4. G1-D: reviewer/result-read/create permissions, source/stage/duplicate policy, canonical primitive boundaries, and inert-consumer exclusions.
5. G1-E: response-backed UI/privacy concealment evidence only.
6. G1-F: actual credential facility/purpose/rotation, vendor/account, sandbox/live pilot, cost/liability, monitoring, kill switch, capacity, incident, reconciliation staffing, and any operator-quarantine implementation.

Pitbull merchant/payment/custody decisions remain independent and outside Phase 2B.

## 10. Documentation validation

This document proposes contract vectors only. It does not claim app/database/provider/payment evidence. The paired Mermaid must be rendered and visually inspected after any change. A future review must target the exact amended head; a Codex no-findings receipt or unrelated/older CI run is never runtime, lock-order, provider, or pilot proof.

## Related records

- [Phase 2A ingress design](PHASE_2A_INTEGRATION_INGRESS_DESIGN.md)
- [Phase 2A state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md)
- [Integration Review UI specification](INTEGRATION_REVIEW_UI_SPEC.md)
- [Merged PR #80 Zernio boundary](ZERNIO_INTEGRATION.md)
- [Provider-free simulation plan](PHASE_2B_PROVIDER_FREE_SIMULATION_PLAN.md)
- [Phase 2B PR sequence](PHASE_2B_IMPLEMENTATION_SEQUENCE.md)
- [Pitbull Payments Adapter requirements](PITBULL_PAYMENTS_ADAPTER_REQUIREMENTS.md)
