# Phase 2A — Verification, Capacity, and Focused PR Plan

**Status:** Design-only planning. No implementation, provider onboarding, webhook, OAuth, secret, external call, customer message, payment, advertisement, or deployment is authorized by this plan.

## Verification model

The Phase 2A boundary is security-sensitive because an external delivery can be duplicated, delayed, malformed, misrouted, or contain private contact data. A green unit test is not enough. Each implementation increment needs focused contracts, disposable PostgreSQL integrity/security proof, API/browser checks where a surface exists, root regression, and a clear no-effect snapshot.

### Required proof categories

| Category | Required evidence |
| --- | --- |
| Tenant isolation | Same-user two-school ambiguity denies; cross-school and cross-organization connection/mapping/case access deny; parent/HQ/nonhuman/public/service/AI contexts deny by default. |
| RLS and ACL | Every private integration table has enabled and forced RLS; no direct runtime/browser access; no `PUBLIC` execute; no helper/grant-option drift; function owner/search path and trigger coherence are verified. |
| Connection/mapping | Expected-version conflicts; active mapping cardinality; reconnect/disconnect/rotation; mapping/remap history; campaign ACTIVE/current-school revalidation; kill-switch behavior. |
| Inbound transport | Raw-byte signature good/bad/tampered/missing cases; exact header/method/content/body bounds; event/schema allowlist; mapping mismatch; stale/replayed/delayed/test events; no JSON parse before verification. |
| Idempotency | Same event ID + same digest replays safely; same ID + different digest quarantines; concurrent delivery; reordered delivery; provider-unknown outcome; separate human command idempotency. |
| Review | Reviewer token expiry; case/evidence/mapping version drift; live permission/entitlement revocation during lock waits; duplicate suggestion is advisory; no auto-merge/attach/assignment. |
| Transactionality | Fault injection at each receipt, case, decision, audit, outbox, and CRM-command boundary proves atomic rollback or a truthful UNKNOWN/reconciliation state. |
| Privacy | Raw payload, token, credential reference, provider error body, event inventory, PII, consent claim, and target data stay out of browser responses, URL, storage, audit/outbox, logs, and ordinary CRM reads. |
| No-effect boundary | Whole-table/observable snapshots prove zero consent, messages, communication queue/delivery, trial, follow-up, scheduling, enrollment, membership, invoice, payment, attendance, AI usage/work, Action Engine, provider call, ad spend, or browser persistence effects unless a separately approved human CRM command executes. |
| UI and accessibility | Starts idle; explicit authorized reads; scoped/denied/stale clearing; three-mode equivalence; English/Korean/Spanish catalogs; keyboard, screen-reader, reflow, reduced motion, and mobile no-overflow coverage. |

A real provider sandbox or recorded vendor contract fixture is a later approval gate. It is not a substitute for the provider-free test matrix and must not run until the owner approves credentials, cost, retention policy, and the provider onboarding plan.

## Capacity and operational assumptions

HON is designed to grow beyond a single school, but current source and disposable proofs do not certify production throughput. The following are gated hypotheses, not capacity claims.

### Up to 20 beta schools

The first provider-free beta cohort may be designed for up to 20 owner-approved schools after a separate deployment authorization. The existing exact-one reporting-school selector's 20-school ceiling remains an intentional per-user safety cap; no over-cap shortcut is allowed.

Each school requires a documented current-scope review, staff operating guide, rollback/incident contact, and one observed conventional lifecycle path: first-party form or human lead, optional campaign association, human trial/outcome, and human follow-up. Daily review examines redacted rejected/invalid/rate-limited outcomes without exposing contact data.

Graduation requires no unresolved tenant-scope, provenance, privacy, or authorization defect and a clean repeat of the affected proof bundle on the exact release candidate.

### 100-school readiness

Before accepting a 100-school cohort, build a synthetic 100-tenant load/soak and recovery harness. It must exercise form rate boundaries, campaign cohort reads, lead/trial/follow-up writes, aggregate reports, two-school/multi-organization isolation, and role revocation during lock waits.

Record p50/p95/p99 latency, error/lock-timeout rates, database CPU, connection/pool utilization, migration duration, backup/restore time, and relevant query plans. The measured environment—not the UI or an aspirational number—sets ceilings. No real provider, payment, or communication traffic is required or permitted for this stage.

### 1,000-school operational readiness

A 1,000-school posture needs a representative synthetic dataset and high-water workload, query-plan/index review, connection/job isolation, failure/restore rehearsal, supported-history migration rehearsal, redacted observability, capacity runbook, and an incident/revocation process. If evidence finds a bottleneck, address it in a focused remediation PR. Never solve scale by relaxing RLS, exposing a tenant directory, widening scope selection, or using client-selected school identifiers.

## Cost and provider operating considerations

The current commercial model contains planning assumptions only. It must not be used to activate prices, credits, entitlements, payments, or provider service.

A later provider design must separately model:

- connected-account economics, including the fact that Zernio documents shared team-level rate capacity and counts Facebook Page, Instagram account, and Meta Ads account as separate connected accounts for billing purposes.[1]
- secret-manager storage and rotation cost
- bounded raw-payload vault storage, encryption, retention/deletion, and access-review cost if the owner approves payload retention
- reconciliation, dead-letter, retry, operational support, and incident response cost
- rate-limit behavior based on current response headers and `Retry-After`, not fixed hard-coded RPM assumptions
- vendor endpoint limits, whose published scope should be confirmed contractually before architecture depends on it

The implementation must use a single bounded routing plane rather than an endpoint per school. Zernio documentation has inconsistent wording about its 50-webhook-endpoint limit and its REST rate capacity is shared across a team, so a per-school endpoint/polling design is not an approved scale assumption.[1]

## Incremental rollout stages

### Stage A — provider-free design and proof baseline

Deliver the design documents, closed contracts, security test plan, no-effect matrix, and owner decision record only. Do not add a provider credential, OAuth, webhook route, migration, connection, or UI that claims a live integration.

### Stage B — private integration evidence foundation

After owner approval, introduce the smallest provider-agnostic private connection/mapping/receipt/review data boundary with FORCE RLS, fixed-function ACLs, immutable versions, secret-reference redaction, and disposable proof. No inbound endpoint, vendor SDK, external call, or CRM mutation is included.

### Stage C — human Integration Review and canonical CRM command

After Stage B review, add redacted status/review reads and direct-human review decisions. A separate normal CRM command may create one distinct lead only after the review decision, live reauthorization, and atomic audit/outbox/idempotency proof. There is no auto-merge, attach, messaging, consent, scheduling, enrollment, billing, AI, or provider effect.

### Stage D — simulated signed payload adapter

After Stage C review, use deterministic simulated signed payloads in disposable/local or contract-test environments. Demonstrate signature verification, replay/digest conflict, schema/mapping drift, quarantine, dead-letter/reconciliation, and no-effect proofs. Do not connect Zernio, Meta, Facebook, Instagram, or a provider sandbox.

### Stage E — separately approved provider pilot

Only after the owner approves the connection, retention, role, mapping, operational, vendor-cost, and sandbox decisions may a narrowly scoped sandbox/onboarding proposal be presented. It requires a new implementation review and must not automatically advance to live Facebook/Instagram/Meta activity.

## Focused PR breakdown

| PR | Scope | Explicitly excluded |
| --- | --- | --- |
| A — private ingress foundation | New private evidence model, closed contracts, fixed functions, RLS/ACL verifier, and disposable security proofs. | OAuth, webhook route, SDK, credential values, CRM mutation, UI, provider calls. |
| B — review queue and direct-human disposition | Redacted review reads, reviewer capability/version/idempotency, exact human decision receipts, canonical distinct-lead command, audit/outbox/no-effect tests. | Attach/merge, auto-create, assignment, consent, messaging, trial/follow-up, AI, payment. |
| C — Integration Review UI | Isolated staff route/components/transports/tests for response-backed status/review states and three presentation modes. | Protected visual components/assets, real connection/mapping command, provider data, browser persistence. |
| D — simulated transport and reconciliation | Provider-agnostic raw-body adapter interface, simulated signature fixtures, dedup/conflict/quarantine/dead-letter/replay/reconciliation evidence. | Zernio/Meta credentials, webhook registration, external request, polling, live endpoint claim. |
| E — sandbox/onboarding proposal | Owner-review runbook, approved secret custody, vendor contract mapping, egress, sandbox test plan, and kill switch. | Live customer leads, ad spend, customer messaging, production deployment, automatic rollout. |

Each PR is independently reviewable. It begins with affected focused tests and ends with root validation appropriate to its changed boundary. No PR may include unrelated visual cleanup, shared visual source change, payment/commercial activation, or provider-side action.

## Release evidence package

Before any stage moves forward, record the exact source SHA, migration ledger/hash when applicable, disposable fixture target/role attestations, test/check/build/db-check outcomes, RLS/ACL negative probes, concurrency/replay/revocation result, redaction/no-effect result, no-egress/provider sentinel result, browser accessibility/session-clearing result, and manual review sign-off. A green CI badge proves only the jobs it executed; it never proves provider delivery, customer impact, or production readiness.

## Owner decisions for Stage B approval

1. Approve or reject any raw-payload vault, including minimization, retention/deletion, encryption, region/processor, and access policy.
2. Approve the role/capability model for connection lifecycle, mapping, reconciliation, and human review.
3. Approve mapping cardinality, remap semantics, disconnected/retired form behavior, and optional campaign linkage.
4. Confirm that no attach-to-existing-lead flow is required in the first implementation.
5. Approve the exception policy for invalid signatures, test events, schema drift, dead letters, delayed/replayed events, reconciliation cadence, and kill switch.
6. Approve the focused PR sequence and independent security-review stop points.

## References

[1]: https://docs.zernio.com/webhooks "Zernio webhooks"
[2]: https://docs.zernio.com/llms-full.txt "Zernio documentation corpus"
