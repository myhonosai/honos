# Phase 2 CRM Integration Readiness Assessment

**Status:** Owner-review assessment only. No provider, webhook, credential, message, AI execution, payment, deployment, migration, or production configuration was added or activated.

> **Historical assessment status — 2026-10-26:** This readiness assessment predates the corrected Phase 2A architecture. Its preliminary design observations and next-step language are superseded wherever they conflict with the reviewed [Phase 2A design in PR #86](https://github.com/myhonosai/honos/pull/86) at [`7ec9a5adb3ee80ffb3f00ce4e47e87122dc362fd`](https://github.com/myhonosai/honos/commit/7ec9a5adb3ee80ffb3f00ce4e47e87122dc362fd), subject to final owner approval. This historical note authorizes no implementation, provider activity, credential handling, or customer effect.

## Executive decision

HON has a meaningful **provider-free CRM foundation** for a human-operated lead lifecycle: public website forms can create an attributed CRM lead; staff can schedule and record a trial outcome; staff can create and manage a follow-up; Campaign Planning provides bounded aggregate attribution; Lead Migration provides human duplicate review; and Chad remains a governed draft-only path. That foundation is sufficient to design the next integration boundary, but it is **not ready to connect Zernio, Meta, Facebook, Instagram, Google Ads, or any provider today**.

The correct Phase 2 decision is therefore: **prepare a separately reviewed, human-confirmed integration-ingress design first; do not connect an account or create provider code yet.** The integration must create durable, school-scoped inbound evidence and a human review path rather than silently creating, merging, messaging, enrolling, billing, or activating records.

## Current capability audit

| Capability | Current evidence | Readiness | Boundary that remains true |
| --- | --- | --- | --- |
| Website-form lead intake | Public forms have their own fixed ingress, attribution guard, no-effect evidence, current-school form monitor projection, and signed-session authorization proof. | Available for its existing bounded purpose. | A public form creates a lead only through its registered ingress; it is not a generic provider adapter. |
| Lead Sources & Intake Monitor | Provider-free staff read projection; it displays only form title/lifecycle, accepted count, and campaign-association presence. | Available, read-only. | It may not claim Zernio/Meta/Google connectivity, delivery, spend, conversion, enrollment, payment, or ROI. |
| Campaign attribution | Human planning, immutable creation-time source facts, ACTIVE campaign linkage, and redacted cohort reads are implemented. | Available, planning/aggregate only. | `WON` is not enrollment or revenue; campaign-to-payment/ROI evidence is unavailable. |
| Manual import and duplicate review | Migration Center has explicit IMPORT/SKIP review, bounded suggestions, no automatic merge, immutable evidence, and atomic finalization. | Available for CSV migration. | It is not a real-time connector queue and cannot become one implicitly. |
| Trial scheduling/outcome | Human-only direct CRM trial scheduling and outcome services are available. | Available. | Recording a trial outcome does not create an enrollment, membership, payment, message, or automation. |
| Follow-up | Human follow-up service/workbench exists, with a separate Chad draft path. | Available. | A follow-up record is not a customer contact; Chad has no live delivery authority here. |
| Meta/Facebook/Instagram via Zernio | No connector, OAuth flow, credential record, form mapping, signed webhook endpoint, inbox/queue, idempotency key, or provider reconciliation record exists in HON. | **Not connected.** | Vendor documentation is feasibility evidence only, never provider-health or delivery evidence. |
| Google Ads | Existing campaign association can be configured on a website form; no Google credential, account mapping, click/conversion/spend import, or reporting contract exists. | **Unavailable.** | No Google API call, conversion, spend, or ROI claim is authorized. |

## Synthetic local lifecycle verification

A fresh, marked `localhost` fixture ran the actual human domain services in this sequence:

```text
public website form ingress
  → CRM OPEN lead
  → human schedules a TRIAL
  → human records COMPLETED outcome
  → human creates an OPEN follow-up record
```

The verifier asserted that the trial and follow-up retained the same lead and that no membership, billing account, payment schedule, invoice, payment attempt, communication consent/message, booking, attendance, Action Engine request, AI usage/invocation, work item, or provider effect was created. This is evidence of the current **human CRM path**, not an external-provider integration or a production customer flow.

## Zernio feasibility—what is documented, versus what HON has not implemented

The official Zernio materials describe a connected-account model, Meta lead-form delivery, webhooks with an event identifier and signature, connection/reconnection mechanics, and provider error handling. See [official-source record](../research/PHASE_2_ZERNIO_SOURCES.md).

That makes a future adapter technically plausible. It does **not** prove an HON integration, an available tenant account, a working authorization grant, a valid Meta Page/form mapping, consent, delivery, data retention, or reliable lead creation. HON currently has none of the following:

1. A school-scoped Zernio/Meta connection object or secret reference.
2. An owner-confirmed OAuth/connect handoff with a deliberate return path and account/Page/form selection.
3. A raw-body signature verifier, event-schema validator, duplicate-event ledger, dead-letter/replay queue, or provider reconciliation model.
4. A versioned mapping from a connected account/Page/form to exactly one school, pipeline/stage, and optional existing campaign.
5. A human integration-review queue that can reject, inspect, or explicitly accept an inbound candidate without auto-merging people/leads.
6. Consent-policy evidence that distinguishes a lead-form checkbox from HON communication consent.
7. Provider outage, rate-limit, reconnect, unknown-outcome, data minimization, or retention controls.

## Required Phase 2 design boundary

> The observations in this section identify readiness concerns; they are not the authoritative implementation contract. The corrected PR #86 design governs pre-tenant signature verification, historical tenant binding before any school disclosure, distinct signing-versus-provider/data credential purposes, transaction boundaries, inert integration evidence, and the initial no-attach/no-merge posture.

### 1. School-scoped connection and credential boundary

A future connection must belong to exactly one HON organization and school. The browser may display only connection state derived from a server-side record; it must never receive a provider token, raw secret, provider-account inventory, webhook secret, or cross-school selector. Connection, reconnection, form mapping, and disconnect are owner-confirmed human commands and require audit/outbox evidence.

The credential store should contain an opaque managed secret reference plus provider/account metadata necessary for scoped routing—not a token in ordinary application tables, logs, audit payloads, browser state, or idempotency receipt. A provider account/Page/form can be mapped to **one current school mapping** at a time; remapping must leave immutable historical provenance.

### 2. Inbound evidence before CRM mutation

A future Zernio webhook is governed by the corrected PR #86 flow: a fixed server endpoint uses a bounded signing-key purpose to authenticate raw bytes before parsing or trusting body context; receipt reservation/deduplication and historical binding resolution occur before a unique school is disclosed; only a uniquely routed candidate may reach a human review queue. Signature failure, unknown/revoked/disabled signing context, malformed payload, unsupported version, unknown or ambiguous historical binding, identity conflict, and retry ambiguity are fail-closed durable outcomes—never a silent CRM mutation.

The preliminary order below is retained only as historical context and is corrected as follows:

```text
Zernio/Meta event
  → pre-tenant raw-byte signature verification under a bounded installation context
  → durable receipt reservation + idempotency/dedup evidence
  → historical verified binding resolution before school disclosure
  → human Integration Review queue
  → later direct-human CREATE_DISTINCT_NEW_LEAD only if the corrected contract and current authority permit it
  → atomic CRM-effect/provenance/audit result or no effect
```

No external call is held inside the CRM transaction. A timeout or unknown provider result remains unknown until the original event identity is reconciled. An inbound event may produce a candidate or duplicate suggestion; it must not attach to or merge records in the initial design, claim contact consent, enqueue AI work, message a customer, create a trial, enroll a student, create a membership, or create a payment.

### 3. Explicit source, attribution, and duplicate policy

The immutable `crm_leads.source_code`/source-facts path has an effective 80-character source bound. Future source labels should be closed, short, and truthfully distinguish channels, for example `WEBSITE_FORM`, `META_LEAD_FORM`, `GOOGLE_ADS_WEB_FORM`, and `MANUAL_IMPORT`. The source alone is not proof of ad spend, consent, campaign conversion, enrollment, payment, or ROI.

Provider-specific data should be minimized into a private inbound event/source-facts record: provider, account/Page/form identifiers, provider event ID, received time, mapping version, selected campaign snapshot (if any), and schema version. Raw provider payload retention, if approved, must be private, encrypted/controlled, bounded by policy, and unavailable to ordinary CRM reads. It must not be copied into lead notes, browser receipts, audits, or outbox payloads.

Existing Migration Center duplicate suggestions are an appropriate behavioral precedent only for deterministic suggestions followed by a human **IMPORT/SKIP** decision. It has no attach or merge operation. A new integration queue needs its own explicit decision model; reusing migration tables or presenting a provider event as a CSV import would blur provenance and authority.

### 4. Existing workflows remain separate

- **Native website forms:** remain on the current public-form ingress. A Zernio connector must not replace their public IDs, provenance, rate controls, or monitor projection.
- **Manual CSV import:** remains the explicit Migration Center path. It is not a fallback webhook endpoint.
- **Lead owner/assignee:** do not infer assignment from provider account, Page, campaign, or source. The assessed path has follow-up assignment, but an explicit lead-owner assignment policy/boundary should be confirmed before an adapter offers routing.
- **Trials and follow-ups:** remain current human commands. A connector may surface a candidate; it may not schedule a trial or create/signal an outbound follow-up automatically.
- **Chad:** may prepare a governed draft only after its separate policy/approval path. No inbound lead grants Chad messaging, provider, or mutation authority.
- **Paid access, plans, memberships, billing, credits, and provider subscriptions:** are out of scope and must not be coupled to marketing-source ingress.

## Minimum human confirmation points

| Decision | Required human authority | Must bind |
| --- | --- | --- |
| Connect/reconnect provider | School owner or separately approved delegated role | Exact provider, organization/school, selected account/Page, policy version, expiry. |
| Map a provider form | Current authorized school operator with a dedicated sensitive permission | Exact account/Page/form, one school, pipeline/stage, optional ACTIVE campaign, mapping version. |
| Process an inbound candidate | Current human CRM authority | Exact inbound event, protected candidate data view, current CRM stage/version, and—only if later authorized—the corrected direct-human `CREATE_DISTINCT_NEW_LEAD` decision. Initial Phase 2A design has no attach or merge decision. |
| Record communication consent | Authorized human/parent consent workflow only | Channel, status, capture method, subject, timestamp, policy basis. |
| Send anything | Separate communications/approval boundary | Exact recipient/content/channel/provider account and consent at execution time. |

## Test and safety requirements before any connector code

1. Disposable PostgreSQL proof for forced RLS/private inbound event tables, no direct runtime grants, exact fixed-function ACLs, and immutable dedup/provenance records.
2. Raw-body signature tests: valid, malformed, missing, duplicate, delayed, retry, expired/misbound mapping, cross-school, and cross-organization cases.
3. Two-school same-user ambiguity, role/permission revocation, entitlement expiry, disconnect/reconnect, and mapping-version drift tests using the same live-lock discipline as the current CRM proofs.
4. No-effect snapshots covering memberships, invoices, schedules, payments, messages, consent, attendance, AI usage/work, Action Engine approvals, provider calls, and browser persistence.
5. Browser/UI tests that begin idle, never claim a connection without server-confirmed evidence, clear stale facts on session/school changes, and keep all provider identifiers/credentials out of URLs and browser storage.
6. Provider sandbox or recorded-contract tests only after owner approval; no live Meta lead, ad, spend, message, OAuth grant, webhook registration, or production secret before that separate approval.

## Historical CI baseline and separately reported assessment evidence

This documentation-only correction did **not** rerun application tests, PostgreSQL proofs, migrations, provider verification, or CI.

### Independently verified source-equivalent CI baseline

GitHub Actions [run `40265190111`](https://github.com/myhonosai/honos/actions/runs/40265190111) is an independently verified historical CI baseline for a source-equivalent canonical-main tree. It passed:

- **1,818 workspace tests**, including **509 API tests**; the API figure is a subtotal, not an additional or complete root-test total.
- **41 PostgreSQL security proofs** across eight fixtures.
- Typecheck/build and validation of **181 migration files**, with highest identifier **0189**.

Those are historical baseline results, not a fresh execution of PR #85. The prior local `509` observation is retained only as an author-reported limited-scope result: this document does not retain a sanitized command, exact tree, discovery scope, or output sufficient to elevate it to a workspace-total claim.

### Separately reported assessment results

The following are author-reported local assessment evidence and were not independently rerun by this documentation correction:

- A marked campaign-attribution fixture plus its verifier reportedly passed, including live authority/revocation, immutable source facts, aggregate redaction, rollback, and negative ACL/RLS drift probes.
- The marked synthetic human service-chain described above reportedly passed.

These historical results describe assessed provider-free CRM boundaries. They do not prove a Zernio, Meta, Facebook, Instagram, Google, Stripe, communication, AI-provider, or production integration.

## Owner decisions required before implementation

1. Approve whether inbound Meta leads must always enter a human review queue, or identify the narrow conditions under which a separately reviewed policy may create a new CRM lead automatically.
2. Approve retention/minimization policy for raw provider payloads and whether any data crosses regions or an external processor boundary.
3. Approve the exact owner/delegated role model for connect, mapping, disconnect, and inbound candidate decisions.
4. Approve provider account/Page/form mapping semantics and an explicit lead-assignment policy; no mapping may imply a person/lead owner silently.
5. Approve a separate consent policy for any eventual messaging. A lead-form checkbox alone must not become HON SMS/email/push consent without the approved capture semantics.
6. Approve sandbox credentials and recurring provider cost only after the design, security proof, and test plan are reviewed.

## Recommended next step

The separate **Phase 2A Integration Ingress Design** now exists in [PR #86](https://github.com/myhonosai/honos/pull/86) at reviewed commit [`7ec9a5adb3ee80ffb3f00ce4e47e87122dc362fd`](https://github.com/myhonosai/honos/commit/7ec9a5adb3ee80ffb3f00ce4e47e87122dc362fd). Review that corrected design and the source record before any owner decision. Do not start provider onboarding, OAuth, webhook registration, messaging, spend, live lead retrieval, or implementation until the owner decisions and PR #86 dependency gates are explicit.
