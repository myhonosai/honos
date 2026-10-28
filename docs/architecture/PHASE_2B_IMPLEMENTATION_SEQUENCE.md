# Phase 2B Implementation Sequence

**Status:** Planning only. No Phase 2B implementation is authorized by this document.

## 1. Preconditions and one migration coordination record

**G0 is complete and source-only:** merged PR #80 exact-head evidence is recorded in the [joint checkpoint](PHASE_2B_JOINT_CONTRACT_CHECKPOINT.md). It authorizes neither provider operation nor Phase 2B code.

The current decision is **NO-GO for runtime work**. A potential 2B-1 documentation/vector checkpoint needs G1-A; every later slice needs its own gate.

### Shared migration coordination record

`0179` and `0180` remain untouched. PR #82 is the known existing physical `0190` claim:

- PR #82 / branch `codex/a2p-1-backend`, head `e35754188a618167305696a3e021fcc629f4fc3b`;
- `packages/database/migrations/0190_a2p_registration_preparation.sql`;
- recorded content checksum: SHA-256 `266d6a2f25a8051bce80cf625a0ae333bd8032fb3a1ae0b437bb4a03d36f5638`; and
- reviewed main high-water mark: 181 migration files through `0189`.

The status is **`PENDING_COORDINATOR_DECISION`**. 2B-1 records coordination only and creates no migration/DDL. 2B-2 has no allocated migration number. Before any DDL, one owner/coordinator record must name both claims, the one approved consumer, decision/timestamp/evidence, eventual merge commit, and post-merge validation. Recommended default: recognize #82's existing physical claim while retaining its independent review/conflict/authorization gates. If no priority exists, both DDL paths remain blocked. Never rename #82, silently allocate a replacement number, or infer priority from PR age/status.

## 2. Per-slice approval matrix

| Gate | Scope if later approved | Does not authorize |
| --- | --- | --- |
| G1-A | 2B-1 closed written V1 contract/vector review, recovery/lock/reservation agreement | DDL, persistence, route/controller, key/credential, provider I/O, candidate data, UI, CRM mutation, payment, AI, activation |
| G1-B | 2B-2/2B-3 opaque provider-free schema/synthetic proof after fresh allocation | Real secret facility, KMS, protected data retention, provider account/call, sandbox, cost, operational policy |
| G1-C | 2B-4 custody/PII policy | Raw-body retention, provider activation, CRM effect, UI |
| G1-D | 2B-5 human disposition/canonical CRM policy | Auto-create, attach/merge/update, provider contact, payment, messaging, AI, automation |
| G1-E | 2B-6 response-backed UI evidence | Browser authority/persistence, provider setup, automatic execution |
| G1-F | Separate provider pilot/operations decision | Retrospective approval for earlier slices or Pitbull work |

## 3. Prioritized small PRs

| Order | PR | Included only after its gate | Explicit exclusions | Ownership | Mandatory future evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | **2B-1 Joint V1 Contract Checkpoint** | Closed validators/vectors, plane vocabulary, source-occurrence identity/cardinality, recovery/revocation/lock path maps, code-boundary map, shared migration coordination record | SQL/DDL, persistence, API, secret resolver, provider/network code, payload/candidate values, UI, CRM mutation | Joint Manus/Codex | Closed-shape rejection vectors; result-read versus fresh-mutation vectors; source/digest/cutover/reconnect vectors; lock/owner/reservation audit; no-runtime-surface scan |
| 2 | **2B-2 Private Authority and Receipt Schema** | After G1-B and fresh allocation: private immutable authority/receipt metadata, FORCE RLS, fixed functions | Raw secret/vault/signing material, raw payload/PII, provider route, browser/API, review UI, CRM effect, #80 activation | Codex implementation; Manus review | Disposable RLS/ACL/immutability/composite-scope proof; migration allocation record; unchanged prohibited-table snapshots |
| 3 | **2B-3 Deterministic Ingress Simulator** | After G1-B: injected raw-byte simulator, six outcomes, replay/conflict/cutover/reconnect evidence, durable outcome before synthetic acknowledgement | External HTTP/SDK/key resolver, webhook route, configuration, raw retention, candidate UI, CRM effect, automation | Codex implementation; Manus review | Signed-input negative matrix; two-org/routing/revoke proof; zero-network assertion; dispatcher integration |
| 4 | **2B-4 Protected Candidate Custody** | After G1-C: approved V1 allowlist, encryption/key-version evidence, metadata queue, narrow protected detail read | Raw-body vault, provider call, browser UI, review disposition, CRM create, attach/merge, consent/message, AI | Joint; Codex custody, Manus semantics | PII policy; encryption/AAD/key rotation; no-leak/revocation proof |
| 5 | **2B-5 Direct-Human Disposition + Canonical CRM Effect** | After G1-D: closed decision/result backend, case closure, unique occurrence effect, exact K recovery, transaction-aware primitive, provenance/audit/inert evidence | Provider contact, auto-execution, attach/merge/update, assignment, trial/follow-up, enrollment, payment, consent/message, AI/Action Engine, UI | Manus implementation; Codex review | Two-reviewer/two-K barriers; both lock arrival orders; committed-K/read-retained/decide-revoked recovery; no-result/revoke denial; rollback residue zero; actual outbox-claimer exclusion; ordinary LeadService unchanged |
| 6 | **2B-6 Integration Review UI** | After G1-E: response-backed status/metadata/detail/receipt screens following backend proof | Provider setup/inventory, credential input, raw data, automatic load/retry, new backend behavior, shared visual assets, activation | Codex implementation; Manus API/recovery review | Mounted browser/accessibility/privacy/localization/mode/performance evidence |

## 4. Premium UI non-functional bar

The established HON direction remains glass-like, responsive, and smooth. Those are non-functional requirements, never justification for early UI or integration activation. Any later 2B-6 must use response-backed facts only, retain Modern HON/Classic CRM/Big-Button equivalence, preserve visual-collaboration protections, respect reduced motion, avoid narrow-screen overflow, offer 44px phone targets, maintain keyboard/screen-reader/contrast quality, and localize English/Korean/Spanish without claiming provider or business outcomes.

## 5. Coordination

- **Codex:** preserve PR #80 source-only disabled controls; co-sign 2B-1; lead later 2B-2/2B-3 only after their gate; cross-review all owner-boundary evidence.
- **Manus:** own integration review/disposition/provenance semantics, later canonical CRM primitive/no-effect proof design, co-sign 2B-1, and review 2B-2/2B-3.
- **Owner/coordinator:** record the #82/0190 priority decision; authorize each gate/slice; separately approve any provider/sandbox/pilot path.

No provider pilot, OAuth, account connection, webhook registration, paid call, credential use, deployment, customer messaging, ad spend, Verified Auto-Create, or Pitbull payment activity follows from this sequence.
