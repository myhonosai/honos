# Phase 2A — Integration State Vocabulary

> **Status: proposed contract vocabulary only.** Names below do not create database enums, API values, UI routes, or implementation authority.

## Why this exists

Connection configuration, inbound receipt handling, human review, CRM execution, and browser knowledge are different planes. A state in one plane cannot authorize or replace a state in another. Diagrams, UI labels, future contracts, filters, and audit wording must use these terms consistently.

## 1. Authority and Connection/mapping plane

| Record | Proposed lifecycle | Notes |
| --- | --- | --- |
| `PlatformInstallation` | `CONFIGURED`, `DISABLED`, `ERROR` | Platform configuration only; never school authority. |
| `CredentialBinding` | `PROPOSED`, `CONFIGURED`, `ROTATING`, `REVOKED`, `DISABLED`, `ERROR` | Private security boundary. Revocation/disablement blocks dependent resolution. |
| `SchoolProviderConnection` | `PROPOSED`, `CONNECTING`, `CONFIGURED`, `PAUSED`, `REVOKED`, `DISCONNECTED`, `ERROR` | Historical school relation; not a credential or asset grant. |
| `SchoolProviderAssetGrant` | `PROPOSED`, `VERIFIED`, `ACTIVE`, `PAUSED`, `REVOKED`, `EXPIRED`, `CONFLICTED` | One exact asset tuple and one capability. |
| `MappingRevision` | `UNMAPPED`, `ACTIVE`, `PAUSED`, `RETIRED` | Historical routing evidence only. |

`ABSENT` is a projection-only condition when no connection row exists. It is not a persisted lifecycle. Capabilities are independent grants, not lifecycle states.

Credential-binding purpose is immutable and does not create another lifecycle enum. A signing-verification binding may be resolved before tenant routing only for the fixed server-registered endpoint/installation context and only for eligible current or approved-overlap signing generations; it verifies raw bytes before any body context is trusted and grants no school authority. A provider API/data-operation binding is distinct and may resolve only after verified routing plus the current school-connection, exact-grant/capability, authorization, purpose, and lifecycle checks. `ROTATING` is limited to the owner-approved generation cutover; `REVOKED` or `DISABLED` blocks the dependent purpose. A signing key is never an API/data-operation key, and an API/data-operation key is never a signing key.

### Derived UI projections

| Projection | Derivation | Must not imply |
| --- | --- | --- |
| `NOT_CONNECTED` / `CONNECTION_SETUP_REQUIRED` | `ABSENT` or `PROPOSED` | A provider account exists or OAuth may start. |
| `MAPPING_REQUIRED` | `CONFIGURED` connection plus `UNMAPPED` mapping | School routing or delivered leads. |
| `ACTIVE_CONFIGURATION` | `CONFIGURED` plus `ACTIVE` mapping and grant | Health, delivery, consent, conversion, spend, revenue, or ROI. |
| `MAPPING_PAUSED` | Mapping `PAUSED` | Historic evidence was deleted. |
| `RECONCILIATION_REQUIRED` | A separate bounded attention projection | A connection lifecycle or provider-health verdict. |

## 2. Receipt and ingress-outcome plane

`InboundTransportOutcome` is either `RECEIVED` or `REJECTED_SECURITY`. A rejected signature creates no tenant business receipt.

The six exact fail-closed routing outcome codes are:

1. `SIGNATURE_REJECTED`
2. `MALFORMED_REJECTED`
3. `UNSUPPORTED_VERSION_QUARANTINED`
4. `UNKNOWN_BINDING_QUARANTINED`
5. `AMBIGUOUS_BINDING_QUARANTINED`
6. `RETRY_AMBIGUOUS_RECONCILIATION_REQUIRED`

They are durable outcome/reason contracts with response, visibility, retry, and reconciliation semantics. They are not a school grant, connection state, review state, or CRM state.

| Concept | Proposed values | Boundary |
| --- | --- | --- |
| `ReceiptState` | `VERIFIED`, `NORMALIZED`, `ROUTED_TO_REVIEW`, `QUARANTINED`, `DEAD_LETTER`, `IDENTITY_CONFLICT` | An immutable receipt/evidence projection. |
| `ReceiptDisposition` | `NEW`, `REPLAY`, `CONFLICT` | A new delivery’s relationship to a canonical event. |
| `IDENTITY_CONFLICT` | same stable event identity with different verified digest | Separate immutable evidence; never overwrite, remap, or a replay. |

A `REPLAY` is a new delivery observation linked to its canonical event and original result. It is not a new case, CRM work item, or deduplication namespace.

**Boundary A diagram annotation — not a state:** `RECEIPT_RESERVED` means that the stable `event_id` is locked and delivery-attempt evidence is appended. It is not a `ReceiptState`, `ReceiptDisposition`, or a seventh fail-closed outcome. For an eligible authenticated envelope, the only order is reservation → `NEW`/`REPLAY`/`CONFLICT` deduplication classification → historical-binding routing and, only when permitted, source occurrence/candidate/case → complete durable outcome → adapter-specific response. A `2xx` may occur only after that commit and never states CRM creation. `REPLAY_RECORDED` is the diagram label for the durable outcome associated with `ReceiptDisposition.REPLAY`, not another `ReceiptState`; acknowledgement is a transport action, not a state.

## 3. Review-case plane

| Concept | Proposed values | Boundary |
| --- | --- | --- |
| `ReviewCaseState` | `QUEUED`, `ASSIGNED`, `NEEDS_EVIDENCE`, `READY_FOR_DECISION`, `ESCALATED`, `DECISION_RECORDED`, `CLOSED` | State of human review only. |
| `ReviewDisposition` | `CREATE_DISTINCT_NEW_LEAD`, `SKIP`, `REJECT`, `INSUFFICIENT_EVIDENCE`, `ESCALATE`, `REQUEST_AUTHORIZED_REMAP` | Append-only human decision evidence. |
| `DUPLICATE_CANDIDATE` | advisory match metadata | Not a state, identity proof, or create authorization. |

`SKIPPED` and `REJECTED` are decision/closure reasons. The ambiguous generic label `RESOLVED` is not used. Reviewability is not creation eligibility, verified identity, consent, or a CRM effect.

## 4. CRM-execution plane

`CrmExecutionState` is one of:

- `NOT_REQUESTED`
- `RESERVED`
- `IN_PROGRESS`
- `SUCCEEDED`
- `FAILED_NO_EFFECT`
- `UNKNOWN`
- `RECONCILIATION_REQUIRED`

`CREATED_BY_SEPARATE_HUMAN_COMMAND` is display/audit wording for `SUCCEEDED`, not an enum. Exact idempotent replay returns the same effect/result. Outbox event names and versions are independent contracts and cannot be inferred from execution state.

**Boundary B diagram annotation — not a state:** for `CREATE_DISTINCT_NEW_LEAD`, one tenant transaction records the immutable review decision and `DECISION_RECORDED`/`CLOSED` case result, reserves the unique CRM effect, invokes canonical CRM creation, and writes scoped private provenance/result, redacted audit, inert evidence, and the original disposition receipt. These facts commit together or roll back together; a create-path case cannot successfully be `CLOSED` without its effect/result. A non-create disposition records its decision/closure result with no CRM effect. `RESERVED` and `IN_PROGRESS` remain CRM-execution-plane values; they do not independently authorize or prove a closed review case.

**Historical result reconciliation and fresh execution are operations, not lifecycle values.** A mounted command K may have a browser `UNKNOWN_OUTCOME` without changing `CrmExecutionState`. After same-subject, frozen-school, current result-read reauthorization, historical reconciliation returns only K’s existing result and is not inbound `ReceiptDisposition.REPLAY`. Only when no durable K result exists may fresh execution reapply current version/mutation gates. K-caused case version advance never alone destroys its recovery identity; unrelated drift still blocks fresh execution.

## 5. Browser-controller plane — explicitly nondurable

The browser controller has no durable business-state authority:

- `PrivacyShield` means protected response facts are removed from visual and accessibility trees.
- A read epoch owns authorized reads/restoration only.
- A private request capsule is either absent, one active/unsettled instance, one settled unknown instance, or destroyed.
- Browser `UNKNOWN_OUTCOME` is an epistemic condition; it does not assert server `CrmExecutionState.UNKNOWN`.

This plane never appears in receipts, review cases, CRM effects, analytics, URLs, local/session storage, or another component’s state.

## 6. Cross-plane rules

1. A review case may reference one receipt/resolution/candidate evidence set and at most one CRM effect.
2. A connection/mapping revision is immutable context; it cannot replace a signed human authorization or source-occurrence uniqueness.
3. A provider signature, credential, mapping revision, browser label, or provider ID cannot become school authority.
4. UI labels are server-derived projections only.
5. Every school-scoped future row requires composite organization-school integrity and FORCE RLS as defense in depth. A non-school operator-plane record gains no school projection until unique historical evidence proves one school.
6. `Verified Auto-Create` is a future extension with status `DISABLED`, not a review or CRM-execution state.
