# Phase 2B Provider-Free Simulation Plan

**Status:** Proposed future proof plan only. It does not add a simulator, endpoint, provider account, key, webhook, customer record, CRM mutation, or deployment.

## 1. Objective and gate

Only after the separately approved Phase 2B slices may a fresh marked disposable PostgreSQL fixture prove that a bounded synthetic signed event is historically routed, explicitly reviewed by an authorized human, and yields at most one canonical CRM lead through the normal CRM boundary.

This fixture has **zero external network I/O**. It is not vendor compatibility, a sandbox/pilot, a KMS/retention decision, a provider contract test, an operational-readiness result, or activation approval. Synthetic candidate values remain unavailable until the separate 2B-4 custody approval.

## 2. Deterministic fixture model

The future harness creates one fresh, marked local fixture with:

| Fixture element | Required synthetic fact | Explicitly absent |
| --- | --- | --- |
| Organizations | Organization 1 with Schools A and B; Organization 2 with a distinct school | Cross-organization authority or data sharing |
| Principals | Same-School-A reviewers R1 and R2, foreign-organization principal, unprivileged school principal, HQ-without-school-context principal, parent/family principal, expired-session principal, and nonhuman principal | AI/delegated/default school authority |
| Installation/signing | Closed provider-neutral installation and test-only signing generation | Provider SDK/account/live key/real endpoint |
| Authority | Distinct opaque binding, verified source-asset lineage, School-A connection/grant and historical A mapping; later B mapping for the same source asset | Wildcard grant, browser-selected school, current/default mapping fallback |
| Event | Fixed bounded byte string, stable event identity, canonical occurrence identity, controlled signed timestamp/digest inputs | Real PII, raw-payload retention, external request |
| Review/CRM | Original immutable K, exact confirmation, closed stage/source/duplicate fixture facts | Attach/merge/update, payment, enrollment, message, AI, automation |

All setup uses the approved migration/fixed-function fixture path. Runtime direct table access remains denied.

## 3. Boundary A: synthetic ingress proofs

### 3.1 First acceptance and receipt state

The deterministic simulator must:

1. select the fixed synthetic endpoint and eligible installation/signing-key generation;
2. verify bounded raw bytes before parse;
3. reserve the stable `(installation lineage, event-identity version, provider event identity)`;
4. compute the versioned digest and classify replay/conflict;
5. resolve only the immutable historical source-asset/connection/grant/mapping chain at the signed/trusted source time;
6. commit canonical `ReceiptState.ROUTED_TO_REVIEW` **and** its separate bounded routing outcome before synthetic acknowledgement; and
7. create no candidate display, CRM lead, ordinary outbox event, provider call, API/webhook route, or external effect.

### 3.2 Historical routing, reconnect, and conflict

Required deterministic cases:

- First accept event E/source occurrence S under historical School A. Reconnect/change connection version and remap the source asset A→B. A repeated same installation/event identity and digest is the original A-scoped replay; it creates no B receipt/case/occurrence/effect.
- Same stable event identity with changed comparable digest is immutable conflict, not a new event/case/effect.
- A delayed first-seen A-time event resolves A from historical `[effectiveFrom, effectiveUntil)` evidence; a B-time new identity resolves B only.
- Exact cutover, gap, overlap, missing/malformed/untrusted timestamp, and post-wait mapping change cases fail closed through existing bounded outcomes. None falls back to receipt time/current mapping/default account.
- Source-asset lineage continuity and distinct-asset noncollision are explicit: reconnect does not mint a dedupe namespace, but unrelated proven lineages do not merge matching provider labels.

## 4. Review visibility and privacy

The authorized School-A reviewer explicitly loads response-backed metadata only. The fixture proves:

- only School A can view the case; Organization 2, School B, HQ without exact school context, parent/family, nonhuman, expired, suspended, limited, and revoked principals receive no protected fact;
- browser/API projections contain no raw bytes, signing material, binding internals, provider errors, vault locations, or protected candidate values;
- hidden/blurred/session/scope-invalid state conceals data and requires fresh authorized read;
- no action runs automatically; and
- later A→B remap/revocation never moves A-scoped receipt/occurrence/case/K/result/provenance into B.

## 5. Boundary B: two operations, not one retry path

### 5.1 Historical original-K result read

After a disposition commits, the fixture advances the case version as a consequence of K and drops the simulated response. R1 repeats the **same K** with same subject/frozen school/current result-read authority.

Required assertions:

- the original scoped/redacted durable result returns;
- every mutable/effect/audit/outbox/inert-evidence count remains unchanged;
- the result remains readable when `crm.integration_review.read` is retained but R1's decide and/or normal CRM-create authority is revoked;
- lost result-read authority, changed subject/school, changed fingerprint, or unavailable scoped receipt denies/conceals with zero new writes; and
- receipt unavailability never falls through to fresh mutation.

### 5.2 Fresh `CREATE_DISTINCT_NEW_LEAD` attempt

Only a proven absent durable K result may enter fresh current mutation checks. R1 and R2 submit the same source occurrence under distinct K values through deterministic barriers and both arrival orders.

The successful path atomically commits one decision/case closure, one unique occurrence effect, one canonical lead, provenance/result, redacted audit, and structurally inert evidence. The loser creates no second lead/effect/provenance/audit/dispatchable outbox work/retry identity.

A separate barrier authorizes a fresh command, revokes decide or normal CRM-create entitlement while it waits, then releases it. The post-wait recheck denies and rolls back all staged mutation. A rollback injection after primitive/effect staging but before commit leaves zero decision/case closure/lead/effect/provenance/result/audit/outbox/inert-evidence residue. Unchanged K may be reconsidered only after proven absence of a durable result.

An ordinary direct-human `LeadService.create` control remains unchanged and claimable by its normal path. The integration path must create neither ordinary dispatchable `crm.lead.created` work nor a claimable integration evidence item.

## 6. Required negative and structural matrix

| Area | Required deterministic assertions |
| --- | --- |
| Signature | Invalid signature, malformed bytes, unsupported version, size/encoding refusal, no parse before verify |
| Receipt identity | Same identity/same digest replay, same identity/different digest conflict, multiple delivery attempts, retry-ambiguous original-identity reconciliation |
| Occurrence | Distinct events resolving to one closed occurrence only when allowed; reconnect continuity; distinct-asset noncollision; immutable owner pin |
| Routing time | Delayed A→B, exact cutover, gap, overlap, missing/untrusted time, post-wait mapping change, no current/default fallback |
| Tenancy | Foreign organization/school, selector manipulation, direct runtime table access, RLS policy drift, zero cross-tenant read/recovery/race |
| Revocation | Signing before parse; provider-operation denial before resolver/I/O; pending A case no B movement; committed-K read retained/decide revoked; result-read revoked; no-result decision/create/entitlement revoke |
| Concurrency | R1/K1 and R2/K2 same occurrence, both arrival orders, exact-one effect/lead/result; administrative remap/revoke versus ingress/fresh mutation both orders |
| Recovery | K-caused V+1 result recovery, original K/fingerprint only, no new write; changed subject/school/fingerprint/scoped receipt denies |
| Atomicity | Injected rollback after primitive/effect staging; all durable mutation residue equals zero; ordinary `LeadService` control unchanged |
| Structural inertness | Real registered worker/claimer selection cannot claim integration evidence or integration-created ordinary lead work; ordinary direct-human control remains claimable without executing handlers/network |
| Privacy/external effects | No raw bytes, key material, binding internals, provider errors, candidate PII, browser storage/URL/log/audit leak; zero network/provider/setup/message/payment/AI/automation effect |

## 7. Evidence placement

Future 2B-1 records closed documentation/vector requirements only. Future 2B-3 proves Boundary A/provider-operation denial with zero network. Future 2B-5 proves the executable historical-result, fresh-mutation, race, revoke, rollback, and real-claimer cases.

A future named guarded disposable proof must require the existing local-fixture guard, generate/erase task-owned credentials only under `/home/ubuntu/jobs`, stop its fixture, and assert cleanup. Any future implementation PR separately records focused contract/API/web tests plus `pnpm test`, `pnpm check`, `pnpm build`, `pnpm db:check`, `git diff --check`, and the complete dispatcher. Draft skips remain skips.
