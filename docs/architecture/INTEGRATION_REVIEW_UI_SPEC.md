# Phase 2A — Integration Review UI Specification

**Status:** Design-only proposal. No route, component, query, endpoint, provider action, connection, mapping, or review queue is implemented by this document.

## Design rule

The future Integration Review UI must display only response-backed, redacted facts from a server-authorized current-school projection. It begins with no integration facts. It must never present a generic provider console, a school selector, a token/account inventory, a health light, a sync claim, or an assumed connection.

The staff route family is proposed—not registered:

```text
/staff/marketing/integrations
/staff/marketing/integrations/mappings
/staff/marketing/integrations/review
```

A route or query reference is an untrusted selector. It cannot auto-load a connection, establish school scope, expose a provider event, or confer review authority. Detail navigation remains page-local until a separate opaque, authorized detail contract is approved.

## Navigation model

The proposed navigation is within Staff → Marketing:

```text
Marketing
  ├─ Lead Sources & Intake
  ├─ Public Forms
  ├─ Campaigns
  ├─ Integration Review        proposed
  ├─ Lead Migration Center
  └─ Chad draft guide
```

These destinations remain separate because they have different authority and evidence models:

- **Lead Sources & Intake** stays provider-free and read-only.
- **Public Forms** remains the existing first-party form configuration and ingress path.
- **Campaigns** remains human planning and aggregate attribution.
- **Integration Review** is a future evidence/review workflow, not a campaign dashboard.
- **Lead Migration Center** remains CSV migration and duplicate review; it is not a webhook queue.
- **Chad** remains a governed private draft path; it is not a connection, delivery, or lead-creation tool.

## Screen 1: Integration Status

The landing screen is called **Integration Status**. It begins with one explicit button:

> Load verified integration status

Before this read, the only truthful state is: **No verified integration status loaded. No provider action is starting.**

After a server-derived current-school response, the page has three independent lanes.

### Connections lane

Each card exposes only a safe redacted projection:

- provider label
- lifecycle label
- safely reportable state timestamp, if approved
- whether a credential is configured
- mapping readiness state
- whether reconciliation requires human attention

It never exposes refresh tokens, webhook secrets, authorization codes, raw secret references, raw provider errors, provider account inventory, unbounded vendor identifiers, delivery percentages, spend, health, lead count, or sync claims.

Status copy must distinguish stored configuration from operational evidence:

| Status | Meaning | Must not imply |
| --- | --- | --- |
| `NOT CONNECTED` | No response-backed current connection configuration exists. | That an account is available to connect. |
| `CONNECTION SETUP REQUIRED` | A future allowed setup contract has not produced stored configuration. | That OAuth may start without a human confirmation. |
| `MAPPING REQUIRED` | A configuration exists but no eligible mapping is confirmed. | Any school routing or lead delivery. |
| `ACTIVE CONFIGURATION` | A server-confirmed current configuration and mapping state exists. | Healthy delivery, consent, lead acceptance, conversion, spend, or ROI. |
| `MAPPING PAUSED` | A mapping is intentionally unavailable for new resolution. | Deletion of historic evidence. |
| `DISCONNECTED`, `REVOKED`, `EXPIRED` | Stored state requires human attention. | A provider call, automatic reconnect, or retry. |
| `RECONCILIATION REQUIRED` | Evidence needs human review. | A failed/successful provider delivery claim. |

A status card uses an explicit unavailable label when no current reconciliation evidence exists. Green is never sufficient evidence of delivery.

### Mapping readiness lane

This lane displays only a redacted current mapping summary: provider label, lifecycle, destination pipeline/stage label, optional active campaign label, and mapping/policy/schema version label if the server projection allows it.

The proposed mapping form is a **closed binding review**, not a generic field mapper. It is capable of binding only an approved provider asset to exactly one verified school, non-terminal CRM pipeline/stage, and optional ACTIVE campaign snapshot. A future command requires server-validated confirmation, expected version, in-memory idempotency behavior, and a visible explanation that remapping preserves historical provenance.

It never infers lead owner, communication consent, campaign performance, person identity, or assignment.

### Inbound review lane

This lane reports a bounded review state only after an authorized server read. It may show redacted counts or case-state summaries only when the server contract proves their scope. It does not show raw lead data, provider events, contacts, or a false "new leads" feed.

The empty state is:

> No inbound candidates require review in this verified school.

That sentence cannot be used without a successful review-read response.

## Screen 2: Integration Review queue

The queue is a separate explicit read. It starts empty and offers a bounded **Load review cases** action after server scope verification.

Allowed proposed filters are closed and applied only after scope is verified:

- provider
- connection lifecycle
- mapping state/version
- review state/reason
- bounded received-at UTC range
- exact opaque HON review reference, if the future contract explicitly permits it

There is no global people search, contact directory, raw provider event-ID search, vendor account browser, cross-school filter, fetch-on-keystroke behavior, or search-by-form-name shortcut.

Each queue row is a redacted fact set: opaque HON review reference, received-at timestamp, provider label, review state, mapping/schema/policy version labels, and a bounded review blocker. It never lists raw payload, secrets, raw endpoint/provider errors, audit/outbox internals, or unreviewed contact data.

## Screen 3: Review detail and decision

A qualified human can explicitly open one bounded case. The detail screen may display only the redacted candidate projection permitted by the future contract plus:

- opaque HON review reference
- provider/source label and receipt time
- relevant mapping/schema/policy/adapter versions
- validation and mapping blockers
- advisory duplicate suggestions with their match basis
- proposed CRM destination
- immutable decision/audit receipt after a decision

The decision control uses a new explicit human intent—not implicit row selection—and requires a fresh confirmation. The proposed initial decision labels are:

- **Create distinct new lead**
- **Skip or reject**
- **Insufficient evidence**
- **Escalate for reconciliation**
- **Request authorized remap**

The page must say what each decision does not do:

> This decision does not merge records, assign an owner, record consent, contact a customer, schedule a trial, create a follow-up, enroll a student, collect payment, or start AI work.

`Attach to existing lead` is absent from the initial UI because it is not approved in the current design.

## Roles and capability behavior

The interface may use server-returned capability flags for visibility and explanatory text, but flags never replace command authorization.

| Proposed capability | UI allowance | Command-time rule |
| --- | --- | --- |
| Status read | Load redacted status. | Server derives exact current human/school permission. |
| Connection manage | See a separately confirmed setup/reconnect/disconnect entry point. | Requires future sensitive lifecycle contract and owner/delegated role. |
| Mapping manage | Open closed mapping review. | Requires expected version, live current-school authority, and optional campaign revalidation. |
| Reconciliation manage | Read/acknowledge bounded exception work. | Requires separate sensitive authority. |
| Review read | Load redacted review list/detail. | Requires current CRM review authority. |
| Review decide | See decision choices. | Revalidates reviewer, target, version, and policy at execution. |

Family, public, HQ-derived, nonhuman, AI, Action Engine, and cross-school contexts receive no integration fact or control by default.

## State and privacy behavior

Every screen has explicit idle, loading, verified, empty, denied, unavailable, malformed-response, conflict, unknown-outcome, and session-invalid states.

A persistent atomic live region uses polite status for idle/loading/verified/empty and alert semantics for session-invalid, denied, unavailable, malformed-response, conflict, or unknown outcome. Example copy:

- Loading: **Verifying current school authority and loading integration state; no provider action is starting.**
- Denied: **Current human school permission is required; integration facts were cleared.**
- Unknown outcome: **Outcome is unknown; no change is assumed. Re-read current status or retry the unchanged command only if the server contract permits it.**
- Session invalid: **Your verified session ended. Integration facts were cleared. Sign in and load current status again.**

The UI clears all returned status, mapping, candidate, filter, retry, and capability facts on confirmed `401`, access loss, current-school transition, blur, page hide, hidden document, unmount, or late response generation mismatch. Candidate detail uses the same privacy-shield principle as sensitive CRM views: it is removed from the accessible tree immediately on privacy loss and is not restored without an explicit fresh verified read.

No polling, automatic retry, browser persistence, local/session storage, URL-carried evidence, or background provider request is allowed.

## Presentation and accessibility

The current visual collaboration hold remains in force. A future Integration Review surface is isolated; it does not edit, restyle, or import protected shared visual-reference components, logos, portraits, hosted source mappings, global layout/CSS, or shared appearance controls.

It preserves equivalent facts and actions across the three presentation modes:

- **Modern HON:** deep navy/black command surfaces, restrained panels, electric-cyan focus, and legible evidence-state hierarchy.
- **Classic CRM:** compact rows, explicit filters, dense yet readable review detail, and no hidden decision binding.
- **Big-Button / Phone:** one primary task per screen, single-column cards, explicit labels, no horizontal table dependency, and practical 44px+ targets.

A local presentation change never loads data, changes scope, changes the selected case, changes authority, or makes a provider request. Persistent appearance behavior requires a separate verified-scope design and visual-collaboration approval.

All static copy, visible labels, accessible names, errors, and state messages require route-specific English, Korean, and Spanish catalog entries. Server-returned provider labels and evidentiary values remain verbatim; the browser must not reinterpret or machine-translate them.

Accessibility acceptance includes named landmarks/headings, native label/control associations, visible focus, keyboard-native controls, status text in addition to color/icon, contrast, zoom/reflow, reduced motion, no focus movement for ordinary status changes, and mobile no-overflow behavior. Focus moves only for a deliberate privacy shield or an intentionally opened review heading when required for coherent interaction.

## AI Assistant Drafts

The Integration Review UI does not show a live AI employee state. A later, separately approved assistant may prepare private draft analysis only through the existing governed Action Engine path and only after the inbound evidence has passed the human-review boundary.

Required wording:

> **AI Assistant Draft — review required.** This is private proposed content, not a sent, queued, scheduled, published, or delivered communication.

For lead-related content:

> **Delivery state: NOT_CREATED_OR_SENT.** Approval records review of this exact proposal only; it does not create a message, change the lead, or authorize outreach.

The UI must never show AI-generated text as a lead decision, customer communication, provider action, or completed integration work.
