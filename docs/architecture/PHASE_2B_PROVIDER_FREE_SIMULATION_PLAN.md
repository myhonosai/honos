# Phase 2B Provider-Free Simulation Plan

**Status:** Proposed proof plan only. It does not add a simulator, HTTP endpoint, provider account, key, webhook, customer record, CRM mutation, or deployment.

## Objective

Before any provider connection or external request, prove with deterministic local fixtures that a bounded signed lead event can be received, routed only by historical evidence, reviewed by an authorized staff member, and create exactly one canonical CRM lead through the normal CRM boundary.

This plan is executed only after the gated PR sequence in [the joint contract checkpoint](PHASE_2B_JOINT_CONTRACT_CHECKPOINT.md). It is not a substitute for provider contract testing or owner approval.

## Fixture-only model

The future proof harness must create a fresh, marked disposable PostgreSQL fixture. It makes **zero external network requests** and uses no provider SDK, real credential, live account, production data, or public route.

| Fixture element | Allowed synthetic fact | Never present |
| --- | --- | --- |
| Installation | Closed provider-neutral installation ID and test signing-key generation | Provider account, live endpoint, real key |
| Connection/grant | One organization, two schools, exact opaque asset references, capability allowlist | Browser-selected school, wildcard grant, current-mapping fallback |
| Mapping revisions | Historical A mapping and later B mapping with explicit cutover | Rewriting prior revision or merging dedupe scope |
| Raw event | Fixed byte string, bounded encoding/size, stable event identity, controlled timestamp | Real lead PII, external request, provider payload retention |
| Candidate | Future allowlisted synthetic values only after the custody slice is authorized | Raw body, inferred consent, real contact data |
| Human reviewer | Signed fixture principal with exact school/capability/entitlement | HQ, parent, AI, delegated, stale, or cross-school authority |

## Demonstration sequence

### 1. Prepare immutable authority evidence

In a marked fixture, create:

- one installation and eligible synthetic signing-key generation;
- one organization with School A and School B;
- one opaque private binding reference, one School A connection, one exact School A asset grant, and one historical A mapping;
- a later B mapping revision for the same source asset, preserving A as historical evidence;
- a reviewer principal scoped to School A with the future read/decision capability; and
- a separate unprivileged school principal, HQ principal, parent/family principal, expired-session principal, and nonhuman principal for negatives.

All setup occurs through the approved migration/fixed-function fixture path. Runtime direct table access is denied.

### 2. Simulate signed inbound event

The deterministic simulator provides a fixed raw byte buffer and test-only signature. It must:

1. choose the fixed simulated endpoint and installation/key generation;
2. verify raw bytes before parsing;
3. reserve stable `installation + providerEventIdentity`;
4. calculate canonical digest;
5. classify replay/conflict;
6. resolve the historical A mapping from the source occurrence time, despite current B mapping;
7. commit one `ROUTED_FOR_REVIEW` bounded receipt/outcome before synthetic acknowledgement; and
8. create no candidate display, CRM lead, ordinary outbox event, provider call, or API/webhook route.

A later custody slice may add a protected normalized candidate. Until then, the receipt and review projection stay metadata-only.

### 3. Create and inspect review case

The authorized School A reviewer explicitly loads the response-backed review case. The proof asserts:

- only School A receives the case;
- School B, another organization, HQ without explicit school context, parent/family, nonhuman, expired, suspended, and revoked principals receive no protected facts;
- the browser/API projection contains only approved metadata, never raw bytes, signing material, provider errors, vault locations, or candidate values outside the authorized custody plane;
- hidden/blurred/session/scope-invalid browser state is concealed and unrecoverable without fresh authorized read; and
- no action runs automatically.

### 4. Execute one direct-human disposition

The reviewer supplies the exact confirmation literal and original idempotency key `K` for `CREATE_DISTINCT_NEW_LEAD`. Boundary B performs, atomically:

- current reviewer/school/capability/entitlement/case-version rechecks;
- decision and case closure;
- unique source-occurrence effect reservation;
- canonical CRM lead creation through the reviewed transaction-aware primitive;
- scoped provenance/result;
- redacted audit; and
- structurally inert integration evidence.

Assertions: exactly one lead and one effect exist; normal direct-human lead behavior remains unchanged; no payment, enrollment, membership, schedule, attendance, message, provider contact, Action Engine, AI, automation, ordinary integration outbox dispatch, or duplicate suggestion merge occurs.

### 5. Recover a lost response exactly

The fixture commits `K`, advances the case version as a consequence of that commit, and drops the simulated response. The same authorized reviewer reissues **the same `K`** after fresh read authorization. The system returns the original durable result; it does not create a second decision, lead, effect, audit, outbox event, inert evidence event, or retry identity.

A changed key or fingerprint, changed school, unavailable entitlement, unrelated version drift, or lost authorization fails closed with no effect. Fresh execution with unchanged `K` is possible only if no durable result is proven.

## Required negative matrix

The dedicated proof must include at minimum:

| Area | Required negative assertions |
| --- | --- |
| Signature | Invalid signature, malformed bytes, unsupported version, size/encoding refusal, no body parse before verification |
| Routing | Unknown/ambiguous binding, first-seen delayed A event after B remap, revoked/disabled connection or grant, post-wait cutover, quota saturation |
| Idempotency | Same identity/same digest replay, same identity/different digest conflict, concurrent duplicate delivery, retry-ambiguous original identity recovery |
| Tenancy | Foreign organization/school, selector manipulation, current/default mapping fallback, direct runtime table access, RLS policy drift |
| Review | HQ/parent/nonhuman/limited/expired/suspended/expired-entitlement denial, wrong school, read revocation after wait, stale case version |
| Effect | **Two reviewers**, two idempotency keys, injected rollback, ordinary LeadService regression, no duplicate lead/effect/provenance |
| Privacy | No raw bytes, signing material, opaque binding internals, provider errors, protected candidate PII, browser storage, URL, logs, audit/outbox leakage |
| External effects | Zero network requests, zero provider calls, zero provider setup, zero messages, payments, enrollments, AI/Action Engine/automation effects |

## Evidence and CI placement

The proof is a named guarded disposable PostgreSQL script registered in `.github/scripts/run-db-proofs.sh`. It must require the existing local-fixture guard, generate/erase task-owned credentials only under `/home/ubuntu/jobs`, stop its fixture, and assert cleanup.

Each implementation PR also records focused API/contract/web tests plus `pnpm test`, `pnpm check`, `pnpm build`, `pnpm db:check`, `git diff --check`, and the entire dispatcher. Draft CI skips remain skips. A provider-free simulator result is evidence of local safety behavior only; it is not vendor compatibility, sandbox validation, production readiness, or permission to activate an integration.
