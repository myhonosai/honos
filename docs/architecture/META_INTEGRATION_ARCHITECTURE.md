# Meta integration: full product scope and META-1 boundary

Status: **PARTIAL — code-only connection-contract foundation; no Meta runtime.**
Source baseline: `5e110057612b4846a73e4be7a45ead5212c1ffc2` (2026-10-25).

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

The path-scoped `meta-foundation-validation.yml` runs repository tests, typecheck,
build and migration-file checks on the exact draft head with read-only GitHub
permissions and no secrets. It does not connect Meta or claim new database/RLS
coverage. The regular CI workflow still skips drafts; runtime/database proofs
must accompany the next persistence/API slice rather than being inferred here.

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

Runtime connection design, **not implemented here**:

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
4. Keep tokens encrypted in server-only custody via the approved secret facility;
   no token in browser storage, logs, telemetry, URLs, outbox payloads or health
   responses. Persist only secret references, scope metadata and evidence.
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

Recommended next implementation is a separately reviewed META-1 persistence and
read-only health slice: private school-scoped connection/asset/grant records,
secret-reference boundary, authorized health API, revocation and disposable
tenant/authority/idempotency proofs. No dispatch or real OAuth exchange until
current provider contracts and custody are verified. Subsequent phases require
their own owner approvals; no worker, publishing, DM, ad mutation or paid provider
execution is enabled by this roadmap or this PR.
