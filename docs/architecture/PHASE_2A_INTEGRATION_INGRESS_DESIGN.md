# Phase 2A — Provider-Agnostic Integration Ingress Design

> **Status: corrected design-only proposal; final design approval remains NO-GO.**
>
> This document proposes a future evidence-first, human-confirmed inbound lead-ingress boundary. It creates **no** migration, endpoint, credential, OAuth flow, webhook, provider call, customer-data record, CRM mutation, action-engine work, message, payment, deployment, or provider activation.

## 1. Reconciliation status and dependency order

The design starts from canonical main `145d4cf00aa64d4b986ffd2b7a9de5462c7c6469`.

- PR [#79](https://github.com/myhonosai/honos/pull/79) remains an **unmerged draft**. Its closed asset/capability vocabulary and unavailable-health convention are reusable only after its own review and current-main reconciliation.
- PR [#80](https://github.com/myhonosai/honos/pull/80) remains an **unmerged draft**. Its server-only configuration/status/check boundary is not a school authorization, provider client, encrypted tenant vault, or webhook verifier.
- PR [#85](https://github.com/myhonosai/honos/pull/85) is the independent readiness-documentation lane. It must be approved first; this PR must then be rebased onto its accepted baseline and remove duplicate assessment/source records without dropping #85’s other corrections.
- This corrected PR [#86](https://github.com/myhonosai/honos/pull/86) is a design dependency, not an implementation authorization.

The implementation order, if separately approved, is:

1. #85 documentation baseline; then #79 and #80 reconciled independently with current main.
2. Corrected Phase 2A design approval and owner policy decisions.
3. One joint versioned receipt/candidate/review/disposition/CRM-effect contract checkpoint with one migration reservation.
4. Provider-free simulated ingress and security proofs.
5. Transaction-safe human CRM disposition proof.
6. Integration Review UI after its backend contract is reviewed.
7. A separately owner-approved provider sandbox/pilot.

No phase automatically authorizes the next one.

## 2. Non-negotiable authority separation

A signature authenticates a **provider installation/key generation**. It never by itself authenticates a school, a CRM actor, a candidate’s identity, consent, contact ownership, guardian authority, or an executable instruction.

| Authority plane | Proposed record/boundary | What it may establish | What it never establishes |
| --- | --- | --- | --- |
| Platform installation | `ZernioPlatformInstallation` | A centrally configured provider app/team/subscription, approved endpoint context, and installation lifecycle | A school connection, school asset ownership, candidate access, CRM authority, or a default provider account |
| Private credential custody | `PrivateCredentialBinding` | A purpose-specific opaque binding to an owner-approved secret facility, version/lifecycle, stewardship, and dependency policy | A school grant, browser secret, ordinary table secret reference, or staff-visible vault locator |
| School provider connection | `SchoolProviderConnection` | A historical organization-and-school-scoped relationship to one installation and opaque credential-binding ID | An asset/capability grant, raw credential, routing authority without a grant, or cross-school authorization |
| Verified asset grant | `SchoolProviderAssetGrant` / historical binding | A versioned, evidenced authorization for one exact normalized profile/account/Page/form tuple and one #79 capability | Another asset, another capability, another school, a provider’s first/default account, or customer-PII authority |
| Organization provider administration | Future `OrganizationProviderAdministration` | Explicit coordination of enumerated target-school drafts when separately approved | A wildcard, inherited school access, shared asset right, or operational authorization |
| HQ configuration | Existing/proposed #80 HQ status surface | Safe platform configuration/verification status under HQ policy | School asset management, unresolved-payload access, CRM action, or candidate review |

For Phase 2A, the only relevant proposed #79 capability is **`LEAD_RETRIEVAL`**. A Page grant does not imply lead retrieval, messaging, publishing, ad management, another Page, a related Instagram account, or another school.

### 2.1 Private credential-binding boundary

Only an opaque `credentialBindingId` and version may appear outside the private credential facility. The vault locator, raw secret, refresh token, OAuth code, signature key, expiry, provider inventory, and raw provider errors must never appear in ordinary connection/mapping/receipt/audit/outbox rows, URLs, browser state, telemetry, logs, or staff projections.

Only named, allowlisted server operations may resolve secret material under one of two future purpose-scoped contracts:

1. **Pre-tenant webhook-signature verification.** For a fixed server-registered endpoint and installation/subscription context—not a body-supplied school, profile, asset, or other body context—the verifier may recheck the installation plus signing-binding purpose/lifecycle and resolve only the bounded server-recorded signing-key generation(s) eligible under the current or owner-approved overlap/cutover rule. It verifies bounded raw bytes before parsing or trusting body context. Unknown installation/key context, a revoked or disabled binding, a generation outside the permitted cutover set, or an invalid signature fails closed as `SIGNATURE_REJECTED`. This contract confers no school, candidate, asset, CRM, or provider API/data authority and must neither enumerate nor try tenant secrets.
2. **Post-routing provider/data operation.** A separate non-signing credential may resolve only after a verified route to exactly one school and a live recheck of the verified school connection, exact asset grant and capability, current authorization, credential-binding lifecycle, and operation purpose. A historical routing result alone is not current provider/data authority.

Webhook signing keys and provider API/data-operation credentials are distinct and may never substitute for one another. In either contract, material returns only in process memory to the fixed operation and records only redacted operation/version audit evidence. It is never browser-callable, a generic provider client, or a `PUBLIC`/runtime SQL helper. This is a future authorization contract only: it authorizes no resolver implementation, secret configuration, provider call, or webhook route.

A future owner-approved **Credential Custody Policy** decides platform-managed versus school-supplied custody for each purpose, permitted sharing/exclusivity, secret facility, issuer/scope, stewards, emergency revocation, rotation, and overlap/cutover rules. #80’s local `0700` directory and `0600` plaintext file are useful local setup hygiene only; they are not an encrypted multi-tenant vault.

## 3. Evidence-based tenant routing

The only valid school-routing chain is:

```text
verified signature/key generation
  → one provider installation
  → signed provider context correlated against server-held evidence
  → one historical verified asset grant/binding
  → exactly one organization + school
```

`externalId`, a form/account/campaign/ad label, a browser selector, an API-key-present status, the provider’s default/first account, and today’s current mapping are correlation inputs only. They are never tenant authority.

![Corrected inbound trust boundary](../diagrams/phase-2a-integration-ingress.png)

The exact receipt-routing outcomes are separately shown in the [tenant-routing and quarantine state machine](../diagrams/phase-2a-integration-routing-quarantine.mmd).

### 3.1 Historical binding and remap cutover

Every verified asset binding/mapping revision is append-only and records:

- installation, school connection, exact normalized asset tuple, asset kind, and capability;
- organization/school composite scope;
- verification evidence, policy/schema version, approving authority, and timestamps;
- validity interval, supersession/cutover reason, and owner-approved signed-event-time rule.

A receipt permanently pins the historical resolution selected at its first durable handling. A previously unseen delayed delivery after an A→B remap must be evaluated against historical verified evidence—not assigned to B because B is today’s mapping. If the signed event context, event-time/cutover rule, or stored historical evidence cannot prove exactly one school, it remains unresolved. It is never copied, attached, merged, reassigned, or made visible to either school.

### 3.2 Fail-closed routing matrix

The provider adapter may acknowledge only after its applicable bounded durable outcome commits. A `2xx` means only that this outcome committed; it never means CRM creation, consent, verified identity, healthy delivery, or a school route. Exact status/body choices remain provider-adapter-specific and must be approved with the provider contract.

| Outcome code | Durable boundary | School visibility | Acknowledgement and retry rule |
| --- | --- | --- | --- |
| `SIGNATURE_REJECTED` | At most bounded non-PII security telemetry; no parse-dependent tenant record | None | Reject; never acknowledge a tenant outcome. Rate-limit and preserve no raw payload/contact data. |
| `MALFORMED_REJECTED` | Bounded authenticated-envelope failure evidence only when safely available | None | Reject permanently under adapter policy; no school route, candidate, or CRM effect. |
| `UNSUPPORTED_VERSION_QUARANTINED` | Bounded non-school metadata outcome, if the operator-plane policy exists | None | Acknowledge only after durable bounded quarantine commits; no school case or candidate. Without approved operator plane, reject. |
| `UNKNOWN_BINDING_QUARANTINED` | A proved school-local exception only if independent stored binding evidence already proves that school; otherwise non-school metadata only | Only the uniquely proved school; never an inferred school | Acknowledge only after the allowed durable outcome commits. Unknown form on a known connection is not enough unless independent evidence already proves the school. |
| `AMBIGUOUS_BINDING_QUARANTINED` | Non-school bounded metadata outcome | None | Acknowledge only after approved non-school quarantine commits; never choose a school or current mapping. |
| `RETRY_AMBIGUOUS_RECONCILIATION_REQUIRED` | Immutable reconciliation marker keyed to the original verified identity/digest | No new school fact | Do not create a fresh identity, case, or CRM effect. Reconcile against the original durable evidence before any response claim. |

`IDENTITY_CONFLICT` is a separate immutable observation: the same stable verified event identity with a different verified digest. It never overwrites the original event, becomes a replay, or creates a new candidate/case/CRM effect.

### 3.3 Unresolved operator-plane quarantine

The default before an owner decision is **reject without tenant business writes**. A non-school operator-plane quarantine is optional and requires a separate policy before implementation. If approved, it must have:

- a narrow named permission distinct from school reconciliation and #80 HQ credential status;
- metadata-only safe projections, with no raw body, contact field, form label, provider error blob, or reversible digest;
- bounded installation/connection rate, bytes, event count, concurrency, unresolved backlog, dead-letter backlog, retention, expiry, and deletion;
- immutable redacted audit for operator read/adjudication/release/deletion actions;
- no school queue, browser URL, generic HQ view, credential-status page, or CRM creation path;
- no automatic adjudication, re-routing, assignment, cross-school copy, or asset discovery.

A future release from the operator plane to a school requires newly sufficient historical evidence and a separately authorized human adjudication. It cannot create a CRM lead.

## 4. Protected normalized candidate, not a raw payload

Raw-body retention is **prohibited by default**. Bytes may be held only long enough to verify an approved signature and derive allowed evidence. A raw-body vault is a separate future decision; this proposal does not create one.

After a unique school binding exists and only after PII custody approval, the proposed protected record is `IntegrationNormalizedCandidateV1`:

| Allowlisted field | Normalization / result |
| --- | --- |
| `givenName` | Required for future creation; existing direct-human CRM length/control validation. |
| `familyName` | Required for future creation; existing direct-human CRM length/control validation. |
| `email` | Optional; trim/lowercase and syntax validate when present. |
| `phoneE164` | Optional; valid E.164 only when present. |
| `programInterestCode` | Optional; retain only an owner-approved bounded HON code, otherwise mark `UNMAPPED` and omit. |

Each field has one immutable status: `PRESENT_VALID`, `MISSING`, `INVALID`, `UNMAPPED`, or `OMITTED_BY_POLICY`. Rejected values are not retained. Free text, provider field labels, raw JSON, provider identifiers, address, age/birth data, guardian data, consent content, notes, executable instructions, and contact hashes are excluded.

The protected record also pins `candidateSchemaVersion`, `canonicalizationVersion`, `evidenceVersion`, receipt/mapping/policy references, field-status codes, and a tenant/receipt-bound HMAC-SHA-256 `candidateEvidenceDigest` with integrity-key version. This digest is integrity evidence, not a display, search, or contact identifier.

### 4.1 Queue/detail split and PII custody

`IntegrationReviewListItem` is metadata-only: opaque case reference, received time, provider display code, safe state/blocker codes, and version labels. It contains no name, email, phone, interest, raw/provider identifier, candidate preview, or digest.

A separate no-store **protected detail** read may show only the allowed V1 fields/statuses to a current same-school `HUMAN_USER` with future `crm.integration_review.read` authority. It is not a contact directory and does not grant `crm.lead.read`. Any duplicate suggestion is an opaque same-school reference plus match-basis code; no existing-contact value is shown.

Before PII persistence or display, an owner must approve and implementation must prove:

- application-managed envelope encryption with a fresh per-record DEK, authenticated encryption, and AAD bound to organization, school, candidate, receipt, evidence, and schema context;
- KMS/HSM custody, a narrow decrypting service identity, redacted read/decision audit, and no browser/database-role decrypt capability;
- approved regions/processors, retention/expiry/deletion/hold policy, backup expiry and restore behavior, and key rotation/retirement;
- deletion/cryptographic-erasure behavior that preserves only non-reconstructable receipt/decision/digest evidence.

FORCE RLS, a provider signature, a digest, or #80 local key handling are not substitutes for this custody model. Provider assertions establish neither identity, contact ownership, consent, opt-in, guardian authority, legal basis, nor permission to send/queue a message.

## 5. Identity graph, deduplication, and two transactions

### 5.1 Proposed durable identities

| Identity | Purpose | Must not be used as |
| --- | --- | --- |
| `delivery_attempt_id` | One accepted physical transport attempt | Deduplication key |
| `event_id` | Stable provider event: provider + verified installation/subscription lineage + event type + signed body/context event ID | Current connection/mapping identity |
| `source_occurrence_id` | Provider lead occurrence: provider + historical verified asset lineage + `leadgenId` | A UI selection or mapping revision |
| `mapping_revision_id` / resolution | Append-only historical routing evidence | CRM dedup namespace |
| `review_case_id` / `review_decision_id` | Case lineage and append-only human evidence | CRM effect |
| `disposition_request_id` | Immutable original human command K, keyed by reviewer, frozen organization/school, original idempotency key, and canonical fingerprint | A new browser retry key or current case version |
| `crm_effect_id` | Reserved canonical CRM result; must be unique for `source_occurrence_id` | An arbitrary provider event |
| `replay_id` / `event_conflict_id` | Immutable same-digest replay or different-digest conflict observation | New candidate/case/CRM work |

A reconnect or mapping revision must not produce a new provider-event or lead-occurrence namespace. The external event ID must be extracted from HMAC-protected body/context; an unsigned header cannot supply or override it.

### 5.2 Boundary A — ingress acknowledgement

One ingress transaction, before any acknowledgement:

1. reserves/locks the stable event identity and appends delivery-attempt evidence;
2. classifies same-digest replay or different-digest conflict;
3. resolves and pins one historical binding or one fail-closed outcome;
4. links/creates a source occurrence only when allowed;
5. derives protected candidate evidence only when the custody and binding gates permit it;
6. creates a review case only for a new, resolved, eligible occurrence.

It commits the complete outcome before a `2xx`. It creates no CRM person/lead, CRM audit/outbox event, or human review decision.

### 5.3 Boundary B — human disposition and canonical CRM effect

A later direct-human command has one tenant transaction, with a deterministic reviewed lock order. Command K is the immutable `disposition_request_id` plus its original idempotency key/fingerprint, signed-human binding, and frozen organization/school.

**Historical result reconciliation comes first.** Before treating a mounted capsule as a fresh execution, the server may reauthorize the same signed human, frozen school, and current result-read authority to inspect K’s own durable result. If K already committed, it returns only K’s original scoped/redacted disposition/effect result—even when K itself closed or advanced the case version. This historical reconciliation is mutation-free: it creates no new decision, CRM effect, lead, audit, outbox item, inert evidence event, browser key, or action. Changed subject/school, missing or revoked result-read authority, unavailable scoped receipt, controller unmount, or full-document loss deny recovery. Historical result reconciliation is not inbound `ReceiptDisposition.REPLAY`.

**Fresh execution is allowed only after no durable result is proven.** It then rechecks time, signed human identity, exact school, roles/grants, entitlement, case/evidence/mapping/policy versions, source occurrence, original disposition request, reserved CRM effect, and target pipeline/stage after lock waits. Unrelated drift blocks fresh execution without minting a key/action/effect. In one atomic outcome a permitted `CREATE_DISTINCT_NEW_LEAD` command K:

1. appends an immutable review decision;
2. reserves the unique source-occurrence CRM effect;
3. invokes a transaction-aware canonical CRM creation primitive;
4. writes private scoped provenance/result, redacted audit, and inert evidence; and
5. completes K’s original disposition receipt and terminally transitions the case.

Any failure rolls all of this back. Unknown HTTP outcomes reconcile from K’s original disposition request/effect/case evidence and never retry under a new browser identity.

The current public `LeadService.create` opens its own tenant transaction. Future work must **not** call it inside the disposition transaction or duplicate its CRM logic. Instead, a separately reviewed internal `createInExistingTenantTransaction` primitive may be extracted: the public direct-human path continues to wrap it with the existing standard policy and retains ordinary `crm.lead.created` v1 behavior unchanged.

Integration provenance remains in scoped immutable integration relations, not a nested arbitrary provider object in the existing flat attribution contract. The proposed integration-only evidence event, `crm.integration_review.lead_created` v1, is minimal and non-PII and must be structurally excluded from outbox claiming, automation trigger registries, Action Engine catalogs, and all consumer allowlists. `internalOnly` in a payload alone is insufficient enforcement.

## 6. State vocabulary and human review boundary

The corrected design separates connection/mapping, receipt, review-case, CRM-execution, and browser-controller planes. See the canonical [state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md) and [review-state diagram](../diagrams/phase-2a-integration-review-state.png). No derived UI label, advisory duplicate signal, mapping exception, event name, or browser epistemic state may become a lifecycle enum in another plane.

A human disposition may eventually create only a distinct new lead. Initial attach/merge is absent. `Verified Auto-Create` is a named future extension but remains **disabled**: no policy seed, route, consumer, execution principal, or authority exists in this proposal.

## 7. Explicit exclusions

This correction does not authorize:

- a provider connector, OAuth, credential edit, provider SDK/client, default-account selection, webhook, provider call, secret resolution, or hosted key vault;
- raw-payload retention, protected candidate PII, detail access, candidate encryption, or data retention;
- automatic or manual CRM lead creation, attach, merge, enrollment, payment, messaging, consent change, or AI/Action Engine execution;
- an operational capacity, provider health, conversion, revenue, delivery, or ROI claim;
- any change to #79, #80, #85, existing CRM behavior, or another agent’s source.

## 8. Owner decisions before implementation

1. Credential custody, purpose separation, approved secret facility, sharing/exclusivity, rotation/revocation/cutover, and emergency governance.
2. Exact asset tuple/capability grants, organization administration policy, historical binding/cutover evidence, and delayed-event rules.
3. Whether a non-school operator-plane quarantine exists; if so, its permission, metadata limit, retention, audit, capacity, and response policy.
4. Candidate V1 allowlist, integration-specific at-least-one-contact policy, reviewer/decision roles, encryption/KMS, regions/processors, retention/deletion/hold, backups, and raw-body policy.
5. Human review/disposition policy: pipeline/stage/source mapping, duplicate handling (initially no attach/merge), reconciliation, and inert-event retention/consumer policy.
6. Vendor sandbox/live/cost, provider pilot, load/latency/backlog acceptance thresholds, and incident response.
7. Any future Verified Auto-Create policy, separately and only after the human-review path is proved.

## 9. Source and evidence limits

Zernio material remains feasibility/background evidence only; it does not validate a live integration. See the canonical source record proposed in PR [#85](https://github.com/myhonosai/honos/pull/85). This design-only PR did not independently execute or rerun application tests, database proofs, migration checks, provider verification, or connector checks; it does not provision credentials, call an API, or establish operational readiness.

The exact Codex reconciliation is tracked in [PR #86 correction record](PHASE_2A_PR86_CODEX_CORRECTIONS.md) and the proposed proof/rollout sequence in [Phase 2A verification and rollout](PHASE_2A_INTEGRATION_VERIFICATION_AND_ROLLOUT.md).
