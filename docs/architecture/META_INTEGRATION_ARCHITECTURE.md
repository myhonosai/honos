# Meta integration: full product scope and META-1 boundary

Status: **PARTIAL — code-only connection-contract foundation; no Meta runtime.**
Original source audit: `5e110057612b4846a73e4be7a45ead5212c1ffc2` (2026-10-25).
Reconciliation baseline: `a9f14667eca125d10d54e93dd243bf9e4774688e`, including
merged PRs #84, #85 and #86.

The merged [Phase 2A ingress design](PHASE_2A_INTEGRATION_INGRESS_DESIGN.md),
[state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md) and
[verification sequence](PHASE_2A_INTEGRATION_VERIFICATION_AND_ROLLOUT.md) govern
the future ingress boundary wherever this earlier roadmap is less specific.
They approve architecture only, not policy values, implementation or operations.
This reconciliation changes no selection-intent contract or domain helper.

## Scope and source audit

Meta means Facebook and Instagram publishing, messaging, comments, advertising,
lead synchronization and analytics. Ads/leads alone do not satisfy this roadmap.
No existing Marketing M1 branch, PR, OAuth connection implementation or Meta
adapter was found during this audit. This is an isolated first slice, not a
replacement for the existing marketing/CRM/communication systems.

| Existing source | Reuse | Boundary that must remain |
| --- | --- | --- |
| `apps/api/src/marketing/campaign.controller.ts`, `campaign.service.ts`; migrations 0073–0074; `HUMAN_MARKETING_CAMPAIGNS_AND_ATTRIBUTION.md` | Exact-school human authorization, campaign plans, immutable lead attribution and verified funnel records | Local ACTIVE campaign is not a live ad; planned budget is not spend; WON is not paid enrollment or revenue |
| `MARKETING_ASSISTANT.md`; migrations 0089–0091 | Marcus draft/approved internal content, bounded AI tasks, usage planning | Saving content is not publishing. Existing Complete/direct-human permission requirements remain unchanged |
| `apps/api/src/communication/communication-message.service.ts` | Draft/review/consent patterns, idempotency and honest queued status | Existing SMS/EMAIL/PUSH authorization does not authorize Meta messages; queued is not delivered |
| Existing CRM registration/recovery and Action Engine | Authorized lead reconciliation; typed approved actions and human takeover | No identity merge from provider handles; agent persona supplies no authority |
| Existing IAM, tenant transactions, audit/outbox | Server identity, exact school, live permission and entitlement rechecks; transactional evidence | No client role, tier, selected school, token or webhook payload establishes authority |

This PR adds closed **selection-intent** contracts, explicit asset/capability
compatibility checks, an always-unavailable health projection and additive tests.
These are not authenticated APIs, provider permissions, connection receipts or
durable consent. No database schema, permission registration, provider adapter,
OAuth callback, webhook route, token store, worker, frontend or external I/O is
added. Existing authentication, migrations and commercial gates are unchanged.

The existing path-scoped `meta-foundation-validation.yml` runs repository tests,
typecheck, build and migration-file checks on the exact draft head. It also runs
the complete existing guarded disposable PostgreSQL dispatcher using the regular
CI database steps. Both jobs retain read-only GitHub permissions, exact-head
checkout, same-repository gating, and no secrets or provider execution. Regular
`CI` still skips drafts; those skipped jobs are not passes. Report the actual
draft-safe run separately. Existing regression proofs are not new Meta custody,
IAM, webhook or RLS coverage: those require a separately reviewed runtime slice.

## Unified connection and asset authority

One school-facing connection experience orchestrates independently authorized
grant bundles. It is not one universal token. Facebook business login and
Instagram login have different supported products and grants. An Instagram-only
login must not be represented as ads authorization.

Asset kinds are Facebook Page, Instagram professional account, ad account and
lead form. Publishing, comments and messaging are independent capabilities of
the applicable Page/account; they are not invented provider account types.
Independent capability families:

- Ads reporting
- Lead retrieval
- Publishing
- Comments/moderation
- Messaging
- Advertising management/spend
- Social engagement insights (separate from ads reporting)

The contract matrix only rejects structurally incompatible requests. It never
proves provider eligibility, Meta approval, ownership, scope, subscription or HON
permission. Partial grants must remain partial; reporting never implies spend,
publishing never implies messaging, and a Page grant never transfers to another
Page, linked Instagram account, lead form or school.

Runtime connection design, **not implemented here and only after the joint
contract checkpoint below**:

1. Resolve the signed human identity, organization and exact school from existing
   server authorization. Current tenant scope uses `schoolId` for the school/
   location boundary; do not invent an organization-wide location wildcard.
2. Revalidate specific connection-management permission and effective entitlement.
   Bind a short-lived, single-use OAuth state to session, school, provider app,
   login route, explicit capability intent and a server-owned return target. Use
   the current documented Meta anti-CSRF/code-exchange controls. Never put tokens
   or arbitrary redirect URLs in this intent DTO.
3. Discover eligible assets server-side. Verify each exact asset and any parent
   Page/form/Instagram relationship against current provider evidence; never
   trust a browser-supplied parent relation. Decide exclusive ownership or
   explicitly authorized sharing before persistence; conflicting school claims
   remain denied/review-required, not last-writer-wins.
4. Keep tokens, signing keys and secret-manager/vault locators inside the approved
   private credential facility. Ordinary connection, grant, mapping, receipt,
   audit and outbox records may contain only opaque `credentialBindingId` values
   and versions with approved non-secret metadata, never a vault locator or raw
   credential. No secret belongs in browser storage, logs, telemetry, URLs or
   health responses.
5. Persist school-specific bindings and capability grants with revision,
   provider/app/asset identity, grant provenance, expiry/revocation and last
   verified health. Forced RLS, least privilege, immutable audit, canonical
   idempotency and inert outbox are required. Recheck human authority after lock
   waits. Approval binds exact asset, payload, policy version and expiry.
6. Read-only health must distinguish unconfigured, denied, missing grant,
   review-required, expired/revoked, rate-limited, stale and provider-unknown.
   A connected asset does not mean every capability or execution gate is ready.
7. Disconnect/revoke stops future execution and invalidates outstanding approvals;
   retain minimum audit and required reconciliation evidence under retention
   policy. It must not delete unrelated CRM records or another school's grant.

Organization administration is a **future, separately authorized** path. Enumerate
allowed schools and reauthorize each target; no wildcard token or inherited
school permission. Copying approved templates creates target-local drafts and
new approvals, not publication/spend authority or shared private conversations.

### Phase 2A authority and ingress alignment

The future authority planes remain separate: platform installation, private
credential custody, school connection, exact asset/capability grant, HQ
configuration and any explicitly approved organization administration. A
connection, signature, selector or valid API key never replaces another plane.

- Pre-tenant webhook verification may resolve only bounded eligible signing-key
  generations from fixed server-registered endpoint/installation context before
  trusting body context. It confers no school or provider/data authority.
- Post-routing provider/data operations use a distinct credential purpose and
  require live exact-school connection, asset/capability, authorization and
  lifecycle checks. API credentials and signing keys cannot substitute for one
  another. This document implements neither resolver nor credential facility.
- Resolve and pin unique historical asset ownership before school disclosure.
  A first delayed delivery after an A-to-B remap cannot use today's mapping to
  send A's lead to B. Unknown or ambiguous evidence fails closed; optional
  non-school quarantine needs its own approved bounded policy.
- Stable event and source-occurrence identities survive reconnects and remaps.
  Connection or mapping revisions cannot create a new deduplication namespace.
- Boundary A commits bounded ingress identity/evidence, routing and any allowed
  candidate/review case before acknowledgement; it creates no CRM lead.
  Ambiguous retries reconcile original durable identity/digest evidence before
  any acknowledgement claim, with no new receipt, review case or CRM effect.
- A later authorized human disposition uses separate Boundary B: one atomic
  transaction for the decision, unique source-occurrence CRM effect, canonical
  CRM creation, provenance/result, audit, inert evidence and disposition receipt.
  Preserve ordinary `crm.lead.created` v1 behavior; use a separately reviewed
  transaction-aware canonical primitive, not a nested public-service transaction.
- Integration-only evidence must be structurally excluded from outbox claiming,
  automation triggers, Action Engine catalogs and consumer allowlists. A payload
  `internalOnly` flag alone is insufficient. Initial attach/merge and Verified
  Auto-Create remain disabled.

Before **any persistence or API development**, Manus and Codex must agree one
joint versioned contract for installation/custody/connection/grants, mapping
history, receipt/event/source occurrence, protected candidate, review/disposition
and CRM effect/result. The checkpoint includes live authorization, lock order,
uniqueness, historical-result recovery, privacy, inert-event enforcement and one
migration reservation. Owner policy decisions and separately approved proof
slices still apply. No number is reserved or schema/API implemented here.

The existing `UNVERIFIED_SELECTION_ONLY` result is unchanged. Comparing a browser
school selector with a supplied school ID is only an intent consistency check;
the server must independently derive authoritative human, organization, school,
permission and entitlement scope. No new trusted fields are added to the DTO.

## Five independently reviewed phases

| Phase | Preserved product scope | Required dependencies / acceptance gate |
| --- | --- | --- |
| META-1 | Unified connection UI orchestration; exact-school asset mapping; independent grants; token custody; webhook verification; read-only capability health | This PR supplies intent/compatibility/unavailable contracts only. Next slice needs current provider documentation, reviewed custody/ownership design, IAM contracts and disposable RLS/authority proofs before any route is enabled |
| META-2 | Ad accounts/reports; lead forms; verified lead ingestion; attribution, reconciliation and CRM linkage | Ads/lead access and App Review as applicable; signed deduplicated ingestion; explicit identity reconciliation. Reporting does not authorize ad mutation |
| META-3 | Create posts; approved images/videos; FB Page and eligible IG Feed/Reels/carousels/Stories; calendar; drafts; scheduling/cancel; history; engagement; reusable templates | Per-account publishing/media eligibility, current API limits, human approval, scheduler permission rechecks, verified provider publication receipts. Unsupported account/format stays unavailable |
| META-4 | Messenger, IG DMs, supported requests/story/ad replies; comments, mentions, replies/moderation; unified inbox, notifications, assignment, notes, unread/follow-up, takeover | Separate messaging/comment approvals and current window/entrypoint rules; exact-account conversation ownership; duplicate/out-of-order webhook proofs; no unrestricted comment-to-DM permission |
| META-5 | HON overview/triage; Marcus content/calendar/comments/engagement/ad recommendations; Chad enrollment replies/follow-up/authorized CRM links; Lena briefs and later approved creative providers | Typed Action Engine tools, exact target authorization, explicit human approvals, approved AI spending/credit policy; later bounded automation requires separate owner/security/provider approval |

Google Ads is a separate workstream. Reuse provider-neutral campaign, attribution,
approval and evidence concepts where appropriate; do not inherit Meta OAuth,
asset types, messaging windows, identifiers or capability assumptions.

## Publication, scheduling and communications lifecycle

Draft → reviewed payload → explicit human approval → authorized execution attempt
→ provider receipt → reconciled outcome. Draft, approval, schedule and queue
intention are distinct from publication/delivery. Preserve attempt IDs, exact
account, provider object/message IDs, direction, provider/receipt timestamps and
available evidence. Do not fabricate read/delivery status where APIs do not
provide it. Failed, rejected, canceled and **unknown** outcomes remain distinct.

Scheduling must bind the approved content/media/account and local timezone,
retain UTC execution instant and DST ambiguity decisions, and recheck permission,
token, account/format eligibility, policy and consent at execution. Cancellation
must distinguish local intent cancellation from provider-confirmed cancellation;
a race with dispatch requires reconciliation. A job lease is not authorization.

Webhook design requires current Meta challenge/signature verification against
the raw body and approved app secret; no request-body school override. Resolve
events through a verified app/asset binding. Bound request size, verify before
ingestion, retain deduplication identifiers and event/receipt ordering, quarantine
unknown or ambiguous assets, and acknowledge only after durable acceptance.
Duplicate and reordered events cannot cause duplicate sends, identity merges,
lead creation or state regression. Reconcile missing/unknown provider outcomes;
never blindly retry publication, ad changes or messages.

Inbox records must scope conversations/messages/notes/assignments to the exact
school and Page/Instagram account, not only a provider person ID. A Page-scoped
identity does not identify a person in another Page or in CRM. Access revocation
must hide conversation contents immediately. Sensitive family/child data requires
minimization, retention/deletion controls, staff access and privacy review.

Public comments permit only the provider's currently allowed response paths.
Comment visibility is not consent to unrestricted DMs or marketing. Private
reply entrypoints, allowed follow-ups, messaging windows, supported requests and
story/ad replies must be checked per product/account at send time. Do not apply
a single Facebook rule to Instagram or infer permission from old consent records.

## Human and AI modes; product policy

- **Manual:** qualified staff compose and explicitly send within applicable rules.
- **AI assisted:** governed drafting only; staff review exact content and send.
- **AI automated:** future only, separately approved bounded policy, spending,
  windows, escalation, human takeover and emergency stop. Disabled in this slice.

HON summarizes verified activity and delegates drafts. Marcus prepares marketing
content, captions/hashtags, calendars, public-comment replies and recommendations;
Chad prepares inquiry/enrollment follow-ups
and proposed CRM reconciliation; Lena prepares briefs and later approved creative
provider requests. No persona independently receives Page, DM, publication or
spend authority. No AI draft is a sent message. Provider execution, AI generation
and paid credits require their own approvals; this PR invokes none.

The approved scope includes conventional marketing and basic approved assistance
for both internal CORE and COMPLETE capability profiles; COMPLETE may add governed
specialist workflows/triage/optimization and later automation. Existing server
entitlements and permissions remain authoritative. This is a roadmap, **not** a
change to existing Marcus eligibility or public plans. Public HON OS remains one
product; internal profile labels alone never authorize a feature.

## Provider documentation verification (2026-10-25)

Direct official developer documentation returned HTTP **429** on a bounded read:

- [Pages publishing](https://developers.facebook.com/docs/pages-api/posts/)
- [Instagram login/API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/)
- [Messenger policies](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/)
- [Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/)
- [Lead retrieval](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/)

Indexed Meta-maintained [Instagram](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api),
[Messenger](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api)
and [Marketing](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi)
collections support the need for separate login/grant paths, professional-account
eligibility, Page-scoped recipient IDs and messaging restrictions. Instagram-login
documentation describes no ads access through that setup. These indexed sources
are **not complete current policy or App Review verification**.

Before each adapter, record the pinned API version, official source/review date,
login product, account/format eligibility, precise permissions/access level,
App Review and business/access verification requirements, webhook subscription,
token lifecycle, rate limits, allowed windows/private replies, data-use/deletion
requirements and tested provider errors. Mark unverified items unavailable. Do
not invent a universal scope list or promise Stories/requests/private replies
across all accounts. Owner must approve factual app/business-review submissions.

## Threat model and independent review acceptance

| Threat | Required control / test |
| --- | --- |
| Cross-school asset claim, organization wildcard, linked-asset privilege inheritance | Server discovery and exact-school binding; explicit organization grant plus each target; foreign/ambiguous mapping denied |
| OAuth CSRF, redirect abuse, token leakage | Single-use session/school/app-bound state; server return allowlist, confidential exchange/custody; no token in public DTO/logs |
| Forged or replayed webhook | Raw-body authenticity; bounded ingestion; app/asset mapping; durable deduplication and quarantine; reorder-safe projections |
| Stale/revoked grants or privilege loss during execution | Live exact-capability authority and effective entitlement recheck after waits and immediately before dispatch |
| Double publication, duplicate DM/ad spend or uncertain outcome | Canonical immutable request/idempotency, unique provider receipts, explicit reconciliation; no automatic resend |
| AI overreach, prompt injection or public-comment consent inference | Typed tools, target-bound human approval, scoped context, no instruction-derived authority, current provider eligibility |
| Scheduled content misrepresented as published; guessed analytics | Separate intentions/attempts/evidence; actual receipts and denominators; unavailable/stale status |

This slice tests closed inputs, bounded selectors, separate capabilities, login/
asset compatibility, exact-school selection checks, immutable normalized values,
unavailable health and unconditional execution refusal. It **cannot prove**
runtime OAuth, webhook signatures, RLS, live revocation, custody, App Review or
provider delivery because none is implemented. Those are mandatory next-slice
API/disposable-database/provider-verification acceptance tests, not inferred passes.

Per-phase acceptance must also include: META-2 lead-event deduplication and explicit
CRM reconciliation without false revenue attribution; META-3 format eligibility,
stale approval, scheduled cancel/dispatch races and receipt reconciliation;
META-4 cross-account inbox denial, out-of-order messages, privacy, assignment,
takeover, provider window/private-reply denial and unknown delivery; META-5 prompt
injection resistance, bounded spending, unavailable tools and agent-role labels
never substituting for live human authority.

## Owner/security gates and next slice

1. Approve exclusive versus explicit shared asset ownership, organization-level
   management permissions, operator roles and template distribution policy.
2. Approve token custody, rotation/revocation, retention/deletion, sensitive inbox
   handling and factual Meta app/business-review details.
3. Verify each product's current API, App Review/access and eligibility; approve
   any test-account connection separately. No live connection is authorized here.
4. Define staff publication/message approval, quiet hours, takeover, moderation,
   escalation and later bounded automation/spending policies. Defaults fail closed.
5. Review internal capability-profile entitlement mapping without reopening public
   tiers or silently widening the existing AI assistant permissions.

The next checkpoint is the joint versioned contract above, after independent
foundation review and owner policy decisions. Only a separately authorized later
slice may implement private connection/asset/grant persistence, opaque credential
bindings and protected read-only health, with live revocation and disposable
tenant/authority/idempotency proofs. No persistence, API, dispatch or real OAuth
exchange starts merely because this foundation merges. Current provider contracts
and custody must be verified first. Subsequent phases require separate owner
approval; no worker, publishing, DM, ad mutation or paid provider execution is
enabled by this roadmap or this PR.
