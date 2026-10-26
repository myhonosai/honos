# Integration Review UI — Corrected Design Specification

> **Status: design only; not implemented and not approval to expose provider or candidate data.**
>
> This specifies a future staff surface only after a reviewed backend contract exists. It creates no route, API, UI component, secret editor, browser persistence, provider request, review case, CRM effect, AI work, customer communication, or deployment.

## 1. Purpose and hard boundary

Integration Review lets an authorized human understand a **server-projected** inbound integration status and later make a closed, human-confirmed decision about one protected candidate. It is not a provider dashboard, CRM contact directory, generic payload browser, connector setup wizard, or automation console.

The future surface may eventually show only response-backed facts from server-authoritative projections:

- safe connection/mapping/attention projection for the current resolved school;
- metadata-only review queue entries;
- a separately authorized, minimum protected candidate detail; and
- a redacted disposition receipt or generic shield state.

It must never show tokens, vault locators, raw provider inventory/IDs/errors, raw payloads, raw or reversible contact digests, consent claims, customer history, alternate school data, campaign/ad spend, conversion/revenue/ROI, payment facts, provider health, or an AI-generated recommendation presented as a fact.

## 2. Future route family and direct-human authority

The proposed route family is intentionally illustrative until a separate API/UI contract review:

```text
/staff/marketing/integrations
/staff/marketing/integrations/review
```

A browser supplies no organization, school, connection, credential, provider, mapping, asset, actor, authority, candidate, or policy truth. The server resolves exactly one current school from the verified signed human session. Zero or multiple eligible schools fail closed.

| Future capability | Purpose | Never implied by |
| --- | --- | --- |
| `marketing.integration.status.read` | Read safe status for the resolved school | HQ credential status, a connection label, or a Page selector |
| `marketing.integration.mapping.manage` | Draft/manage a future asset mapping | Read access or provider-key presence |
| `marketing.integration.reconciliation.manage` | Handle school-proven reconciliation cases | Generic HQ access or cross-school context |
| `crm.integration_review.read` | Read metadata queue and protected detail after live checks | `crm.lead.read`, family/parent access, or a provider signature |
| `crm.integration_review.decide` | Submit a closed human review decision | Read access, AI identity, or a queued item |
| Existing normal CRM create authority | Permit later distinct-lead effect after review | Review access or a provider claim |

Parent/family, public, HQ-derived, delegated, nonhuman, AI, Action Engine, generic-service, ambiguous-scope, stale-session, cross-school, and cross-organization contexts deny by default.

## 3. Information architecture

### 3.1 Status lane

The initial status lane is explicit-load only and begins with no facts. It may show server-derived labels such as `NOT_CONNECTED`, `MAPPING_REQUIRED`, `ACTIVE_CONFIGURATION`, `MAPPING_PAUSED`, or `RECONCILIATION_REQUIRED` only as projections defined by the [state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md). They are not provider-health claims or lifecycle enums.

The status lane never offers credential entry, provider-account browsing, OAuth, connection, verify, refresh, default-account selection, webhook registration, or an external link that carries scope/secret data.

### 3.2 Mapping lane

A future mapping lane is a direct-human administrative command surface, not an ingestion shortcut. It must:

- display only bounded current-school projections;
- use separately reviewed direct-human permission, exact human confirmation, idempotency, expected version, audit, and outbox rules;
- make the exact asset/capability scope visible without exposing raw provider inventory or credential material;
- keep `LEAD_RETRIEVAL` independent from messaging, publishing, ads, or other #79 capabilities;
- use no client-selected school as authority and never select a provider’s default account.

A mapping command is not part of this PR and must not be built before credential, asset-grant, historical-binding, and RLS contracts are approved.

### 3.3 Review queue and protected detail

The queue is metadata-only and filterable only with bounded, server-recognized values. A row may contain an opaque case reference, received time, provider display code, safe state/blocker code, and version labels. It contains no candidate name/contact/interest, raw provider identifier, digest, preview, or duplicate contact data.

A protected detail read is separate. It is `no-store`, same-origin, response-validated, server-resolved to the exact school, and current-authority checked. If policy approves candidate storage, it can reveal only `IntegrationNormalizedCandidateV1`’s minimum approved fields and field-status codes. The UI must make clear that these values are provider assertions, not verified identity/consent/contact ownership.

An advisory duplicate indicator, if separately approved, shows only an opaque same-school reference and a match-basis code. It never exposes existing contact values and offers no attach, merge, source rewrite, owner assignment, or automatic suppression.

## 4. Closed decision surface

The proposed initial decision set is:

- `CREATE_DISTINCT_NEW_LEAD`
- `SKIP`
- `REJECT`
- `INSUFFICIENT_EVIDENCE`
- `ESCALATE`
- `REQUEST_AUTHORIZED_REMAP`

There is no `ATTACH_TO_EXISTING_LEAD`, merge, update, assignment, trial scheduling, follow-up creation, enrollment, payment, communication, provider action, AI proposal, or auto-create choice.

A create decision remains unavailable unless a future server contract proves valid V1 names, at least one valid contact method under an owner-approved integration safety policy, current mapping/pipeline/stage/source, current case/evidence/policy versions, and live same-school review/decision/normal-CRM-create authority. Client-side validation is only usability feedback; server checks are decisive.

## 5. Concealment, reads, and private decision capsules

Sensitive rendered facts and consequential-request recovery have different lifetimes.

### 5.1 Immediate privacy concealment

On blur, hidden-document visibility, `pagehide`, route/detail unmount, current-school transition, `HON_SCHOOL_CONTEXT_CHANGED_EVENT`, confirmed authenticated-session invalidation, or a read-generation mismatch, the UI must synchronously remove every response-backed status, mapping, queue, detail, candidate, duplicate suggestion, capability, filter, error, and receipt fact from the visual **and accessibility** trees. The protected region becomes inert before asynchronous work continues.

Reads abort where possible, their read epoch advances, and late read/restoration results are discarded. There is no focus-return auto-reveal, automatic read, automatic command retry, browser storage, URL/query/hash value, telemetry value, or background recovery request.

### 5.2 Mounted private request capsule

A confirmed future decision creates at most one immutable private request capsule, only in the still-mounted Integration Review controller’s private memory. It contains only the exact transport identity needed for a later identical attempt:

- command-instance identifier;
- opaque case reference;
- frozen organization/school and authenticated-subject binding;
- expected case/evidence/mapping/policy versions;
- canonical serialized closed body; and
- original idempotency key.

It is never rendered while shielded, placed in React-visible queue/detail state, local/session storage, URL/history, logs, analytics, crash telemetry, or copied into another component. Retaining the capsule is not permission to retain or reveal candidate detail.

Read generation and request ownership are separate. A privacy boundary invalidates reads and presentation facts, but it does not cancel a consequential request already sent. Only the currently mounted command instance may settle its own busy/unknown/result state behind the shield. A `finally` handler may clear busy only when its command-instance ID still owns the mounted capsule. Stale callbacks from an earlier case, prior capsule, discarded controller, changed scope, or unmounted controller are ignored.

### 5.3 Session, authorization, and exact retry

A confirmed `401` from an authenticated same-origin Integration Review read, command, or associated authenticated staff transport dispatches `hon:session-invalidated`; every co-mounted Integration Review surface conceals immediately. A `403` is a local current-resource authorization denial: it conceals and blocks this surface but does not assert that the whole session ended or dispatch session invalidation.

Neither status automatically resends a command. While the controller remains mounted, `Verify access and resume` may consider a capsule only after it proves:

1. the same signed human subject;
2. the exact frozen school;
3. fresh `crm.integration_review.read` authority for any reveal;
4. current `crm.integration_review.decide` and normal CRM-create authority for a retry; and
5. still-matching case/evidence/mapping/policy versions.

The server independently repeats authorization. A changed subject, changed school, missing/revoked relevant permission, unavailable/mismatched case, or controller unmount destroys the capsule; it must never be revealed or replayed for another principal or school.

### 5.4 Unknown outcome and abandonment

Network loss, timeout, redirect, unexpected status, malformed/unverifiable success, and any response that cannot prove the exact durable decision/CRM result are `UNKNOWN_OUTCOME`. The UI assumes neither success nor failure.

After settlement, the shield may offer only an explicit **Retry exact unchanged decision** using the unchanged capsule and original idempotency key, after the reauthorization gate. It never allocates a fresh key or silently rebuilds the command.

Discard, close, navigation, case switch, and reset controls that could drop a capsule are disabled while the command is unsettled. After an unknown outcome is settled, deliberate abandonment requires a separate acknowledgement:

> This removes browser-only recovery. It cannot cancel, reverse, or prove the result of a server action that may already have completed.

Abandonment destroys only the local capsule. A later durable-result lookup is a separate server design; it is not created by this UI.

### 5.5 Full-document limit

Mounted-memory recovery is intentionally not durable. Reload, hard navigation, tab/window close, process termination, full page/document destruction, or signing in through a new page destroys the capsule. The UI must not promise retry survival or compensate with browser storage. Staff must verify authorized current state before any new decision.

## 6. Presentation modes, localization, and accessibility

Modern HON, Classic CRM, and Big-Button / Phone must expose identical facts, controls, disabled/unsettled behavior, privacy shield, reauthorization prerequisite, exact retry, abandonment acknowledgement, and no-auto-retry semantics. A presentation switch is local styling only: it cannot load data, advance a read epoch, mutate/destroy/copy a capsule, change scope/authority, call a provider, or submit a command.

New fixed messages require English, Korean, and Spanish catalog entries. The design must support:

- visible native keyboard focus and keyboard-operable controls;
- a persistent atomic live region that announces generic loading, shield, denied, session-invalid, unsettled, and unknown state without candidate facts;
- protected detail removed from both visual and accessibility trees before a generic shield is announced;
- no hidden/inert focus targets, no sensitive label in an accessible name, and no automatic candidate focus restoration;
- contrast, reflow, reduced motion, responsive mobile layout, and 44px minimum phone targets without horizontal overflow;
- equivalent semantics and controls across all three modes.

No shared appearance component, HON asset, portrait, logo, or experimental visual source is changed by this specification.

## 7. Explicit exclusions

This design does not authorize any component, route, API, selector, database record, secret store, OAuth, provider webhook/call, candidate field storage, review list, CRM command, AI action, outbound communication, billing, or customer-visible feature. It is a corrective UI contract for a future approved backend only.

See the [ingress design](PHASE_2A_INTEGRATION_INGRESS_DESIGN.md), [state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md), and [verification/rollout plan](PHASE_2A_INTEGRATION_VERIFICATION_AND_ROLLOUT.md).
