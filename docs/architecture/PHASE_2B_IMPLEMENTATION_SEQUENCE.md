# Phase 2B Implementation Sequence

**Status:** Planning only. No Phase 2B implementation is authorized by this document.

## Entry gates

**G0 is complete and source-only:** merged PR #80 exact-head evidence is recorded in [the joint checkpoint](PHASE_2B_JOINT_CONTRACT_CHECKPOINT.md). It does not authorize provider operation or Phase 2B code.

No PR below may begin before **G1**: owner policy plus joint V1 contract/lock-order/reservation approval. The current decision remains **NO-GO for runtime work**. The only potential first authorization is 2B-1, a joint contract-and-test PR with no migration or runtime capability.

## Prioritized PRs

| Order | PR | Included | Explicit exclusions | Ownership | Mandatory evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | **2B-1 Joint V1 Contract Checkpoint** | Closed V1 validators, plane vocabulary, lock ranks, code-boundary map, owner-decision record, `0190` reservation | SQL/DDL, persistence, API, secret resolver, provider/network code, payload/candidate values, UI, CRM mutation | Joint Manus/Codex | Closed-shape rejection tests; migration reservation audit; no-runtime-surface scan |
| 2 | **2B-2 Private Authority and Receipt Schema** | Additive migration `0190` only; private immutable installation/binding/connection/grant/mapping/receipt identity metadata; FORCE RLS; fixed functions for provider-free proof | Raw secret/vault/signing material, raw payload/PII, provider route, browser/API, review UI, CRM effect, #80 activation | Codex implementation; Manus review | Dedicated disposable RLS/ACL/immutability/composite-scope proof; unchanged prohibited-table snapshots |
| 3 | **2B-3 Deterministic Ingress Simulator** | Injected provider-free raw-byte simulator, six outcomes, replay/conflict/cutover/quota evidence, durable outcome before synthetic acknowledgement | External HTTP/SDK/key resolver, webhook route, configuration, raw retention, candidate UI, CRM effect, automation | Codex implementation; Manus review | Full signed-input negative matrix; zero-network assertion; dispatcher integration |
| 4 | **2B-4 Protected Candidate Custody** | Approved V1 allowlist, encrypted protected candidate store, key-version evidence, metadata-only queue projection, narrow same-school protected-detail backend read, expiry/rotation proof | Raw-body vault, provider call, browser UI, review disposition, CRM create, attach/merge, consent/message, AI | Joint; Codex custody, Manus semantics | PII policy gate; encryption/AAD/key rotation, no-leak and revocation proofs |
| 5 | **2B-5 Direct-Human Disposition + Canonical CRM Effect** | Closed decision/result backend, review closure, unique source occurrence effect, exact `K` recovery, transaction-aware canonical create primitive, provenance/redacted audit/inert evidence | Provider contact, auto-execution, attach/merge/update, assignment, trial/follow-up, enrollment, payment, consent/message, AI/Action Engine, UI | Manus implementation; Codex review | Two-reviewer/two-key races, rollback injection, original-K response-loss recovery, unchanged ordinary LeadService behavior |
| 6 | **2B-6 Integration Review UI** | Response-backed status/metadata/detail/receipt screens after backend proof | Provider setup/inventory, credential input, raw data, automatic load/retry, new backend behavior, shared visual assets, activation | Codex implementation; Manus API/recovery review | Production-mounted browser/accessibility/privacy/localization/mode/performance evidence |

`0179` and `0180` remain reserved/untouched. `0190` is the sole Phase 2B reservation and is only consumed by 2B-2. If an approved branch consumes it first, stop and reconvene the checkpoint; do not silently renumber or reserve another number.

## Premium UI non-functional bar

The product direction remains glass-like, responsive, and smooth, but those are non-functional requirements—not a reason to start UI or activate integrations early. 2B-6 must use response-backed facts only, retain Modern HON/Classic CRM/Big-Button equivalence, preserve the active visual-collaboration protocol, respect `prefers-reduced-motion`, avoid horizontal overflow at narrow widths, offer 44px phone targets, maintain keyboard/screen-reader/contrast quality, and localize English/Korean/Spanish. It must demonstrate performance without claiming provider or business outcomes.

## Coordination checkpoint

- **Codex:** preserve the merged #80 source-only exception as disabled; 2B-2/2B-3 implementation after G1 approval; co-sign 2B-1 contract/lock/reservation.
- **Manus:** integration review/disposition/provenance semantics; canonical CRM primitive extraction and no-effect proof design in 2B-5; co-sign 2B-1 and review 2B-2/2B-3.
- **Owner:** policy decisions, 2B-1 authorization, every subsequent slice, and any provider/sandbox/pilot decision.

No provider pilot, OAuth, account connection, webhook registration, paid call, credential use, deployment, customer messaging, ad spend, or Verified Auto-Create follows from this sequence.
