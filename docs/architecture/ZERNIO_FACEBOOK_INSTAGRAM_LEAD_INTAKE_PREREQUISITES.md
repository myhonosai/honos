# Zernio Facebook & Instagram Lead Intake — Prerequisites

**Status:** Design and activation-gate record only. No Zernio, Meta, Facebook, Instagram, Google, messaging, advertising, or AI provider is connected by this document. The Lead Sources & Intake Monitor must continue to show **NOT CONNECTED** for Facebook/Instagram via Zernio until a response-backed school-authorized connection state exists.

## Purpose and current boundary

PR #84 adds a provider-free, read-only monitor. Its only browser read is the minimal, same-origin `GET /api/v1/marketing/forms/intake-monitor` projection for current authorized website forms. It does not fetch a provider account, lead, campaign, spend, delivery, conversion, contact, consent, trial, enrollment, payment, or revenue fact.

Zernio is a possible future server-side adapter for Facebook and Instagram lead events. It must be a new, narrowly governed integration boundary—not a browser-to-CRM shortcut and not a way to impersonate a human staff member. The existing public-form ingress, immutable source facts, human duplicate-review flow, audit/outbox, and restricted runtime/RLS patterns are the relevant precedents.

## Activation blockers: owner decisions first

Before code or a sandbox connection, record an explicit owner decision covering all of the following:

1. The exact Zernio product/contract and whether Zernio is the processor/counterparty for Meta assets and forms.
2. Per-school versus organization connection ownership; eligible schools, regions, and pilot scope.
3. The permitted Meta assets, lead-form/event types, data fields, scopes, retention/deletion policy, and legal/consent basis.
4. Whether initial ingestion is review-first or may create a canonical lead after validation; permitted pipeline/stage and campaign-attribution policy.
5. Which role may connect, view status, reconcile, disconnect, retry, and review duplicates; whether the feature has tier/entitlement limits.
6. Provider outage, support, incident, kill-switch, disconnect, and rollback ownership.
7. Explicit exclusions: no ad spend, campaign/page/Instagram publishing, outbound messaging, automatic consent, automatic contact merge, enrollment/payment/revenue/ROI inference, or AI/Action Engine authority.

No feature flag, UI affordance, or provider configuration changes these policy blockers.

## Required architecture

### 1. School-scoped connection and credentials

Add a dedicated private, `FORCE ROW LEVEL SECURITY` connection model with composite organization/school ownership. It must include immutable binding/config revisions and redacted state such as `CONNECTING`, `ACTIVE`, `REVOKED`, `EXPIRED`, `DISCONNECTED`, or `ERROR`.

Store only a protected secret-manager reference or other owner-approved protected secret material. Never expose access/refresh tokens in the browser, audit history, outbox, runtime tables, logs, query strings, error bodies, or the monitor projection. Model external account/page/form bindings, least-privilege scopes, expiry/refresh, rotation, unlink/revocation, and a school-local kill switch.

Use dedicated permissions for connection management, status read, reconciliation, and duplicate review. Deny public, parent/family, cross-school, nonhuman, delegated, Action Engine, generic client, and unapproved HQ access by default.

### 2. Install/OAuth protocol

After vendor documentation is verified, use a server-only authorization-code flow with PKCE and a single-use opaque state. Bind the state to a verified human actor, exact school, requested operation, nonce, expiry, and approved scope set. The callback or query must never select the actor or school.

Use an explicit protected redirect configuration—not a request host or forwarded-header-derived origin. Re-resolve live authority before token exchange and before activation. Fail closed for cancel, expiry, replay, scope mismatch, denied staff authority, and token exchange failure. A sandbox/pilot contact still needs separate owner authorization.

### 3. Signed inbound webhook boundary

Create one fixed provider webhook path before JSON parsing. Apply bounded raw bytes and exact method, content type, query, content-encoding, and header policy; do not accept browser cookies or generic authorization headers. Implement only the vendor-documented verification challenge plus signature, timestamp, nonce, replay, and secret-rotation rules after validating the current official documentation.

Malformed, stale, unsigned, replayed, unmapped, wrong-tenant, or unauthorized events must not create CRM, audit, or outbox business facts. Any redacted security telemetry must be separately designed and cannot become a source of lead data.

### 4. Closed mapping and immutable source provenance

Define a closed, versioned mapping from normalized provider event to an active school binding, non-terminal pipeline/stage, and explicit campaign attribution policy. Store mapping version; provider form/account/event identifiers or keyed hashes; provider and received time; and minimal redacted source facts in private immutable evidence.

Raw payload retention is prohibited unless an owner-approved retention/security policy specifically authorizes it. Validate mapping, pipeline, campaign, and provider binding state during ingestion. Expose only a redacted monitor projection.

### 5. Duplicate review and consent firewall

Provider event redelivery is an idempotency concern; possible matching people are a separate human-review concern. Reuse the Migration Center principles: deterministic private suggestions, reviewer-owned capability/token, live authorization, explicit `IMPORT`, `SKIP`, or `CREATE NEW` disposition, immutable provenance, and no automatic merge.

A provider form acknowledgement, lead contact field, or source record is never `OPTED_IN` communication consent. Any conversion to a communication consent command requires separate owner/legal policy, explicit source evidence, purpose/geography/age/guardian handling, withdrawal behavior, and the existing consent boundary. Inbound lead intake must not queue or deliver messages.

### 6. Atomic ingestion, idempotency, and reconciliation

Reserve a private event receipt keyed at least by school/connection and provider event identity, with a canonical normalized-event digest and mapping version. In one transaction, reserve/replay the receipt, create only the allowed canonical CRM/provenance result, append redacted audit evidence, append an internal-only outbox record, and persist a redacted result. Same event identity with a different digest must quarantine/conflict.

Acknowledge the webhook only after commit. Define explicit out-of-order behavior, retry classes, retry status codes, reconciliation cursor/watermark, permitted backfill/pull behavior, dead-letter review, and operator remediation. Unknown, late, or timed-out provider outcomes are reconciliation-required—not success and not a blind resend.

### 7. Observability and truthful monitor state

Define redacted connection lifecycle, signature verification/rejection, event lag, accepted/replayed/quarantined/reviewed counts, reconciliation/dead-letter backlog, correlation IDs, safe error codes, alert thresholds, and an incident runbook. Only these school-authorized response-backed facts may later change the monitor from `NOT CONNECTED`; it may not infer health or sync success.

## Required validation before any activation

Build disposable-local and focused evidence for:

- OAuth state/PKCE/callback replay/scope-school binding and credential rotation/revocation;
- raw-byte webhook challenge/signature/timestamp/nonce/replay validation, malformed/oversized/query/cookie/header rejection, and secret rotation;
- cross-school, HQ, parent, nonhuman, delegated, Action Engine, and direct-runtime denial;
- forced RLS, ACL, fixed-function path/search-path, immutable evidence, mapping-version, and event-time drift probes;
- concurrent event receipt races, same-ID/different-digest conflicts, ordering, retry, UNKNOWN, dead-letter, and reconciliation/backfill behavior;
- duplicate suggestions/review and proof of no automatic merge;
- proof of no unintended consent, message, provider delivery, campaign, ad-spend, payment, AI, Action Engine, enrollment, or revenue effect;
- atomic rollback of CRM/audit/outbox/receipt changes; and
- the monitor’s strictly redacted provider projection and unavailable/denied states.

Then run the affected database proofs and API/web suites, followed by `pnpm test`, `pnpm check`, `pnpm build`, and `git diff --check`. Provider credentials, a sandbox/pilot connection, or external traffic must not be used until the owner approves that isolated rollout.

## Initial-adapter non-goals

The first reviewed adapter must not manage ads, audiences, campaigns, pages, Instagram publishing, outbound Meta/Instagram/SMS/email messages, consent creation, contact merge, automated lead progression, trials, memberships, payments, enrollment, revenue, ROI, AI/Action Engine operations, generic credential storage, raw-payload browser access, cross-school aggregation, or unverified provider health claims.
