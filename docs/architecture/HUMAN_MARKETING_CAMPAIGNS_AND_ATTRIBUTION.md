# Human Marketing Campaigns and Attribution

## Scope and non-goals

This foundation extends the existing Nest API, PostgreSQL tenant/IAM model and Next staff workbench, after `6fbdb4a`. It supports **human school campaign planning**, immutable creation-time lead attribution and redacted CRM cohort counts on active **Essential, Core and Complete** entitlements.

> **ACTIVE is a human planning status. Planned budget is not actual spend.** Saving a campaign does not publish, buy ads, send messages, invoke AI, execute an Action Engine command or start a consumer.

There are no provider accounts, audiences, creatives, landing-page publishing, external URLs, credential fields, spend controls or delivery-success claims in this slice. Marcus and Lena receive no new authority. Existing provider, payment, communication and Action Engine implementations are unchanged.

## Contracts and human boundary

- Shared contracts: `packages/contracts/src/marketing-campaigns.ts`; human-only metadata: `packages/config/src/marketing-campaigns.ts`. The four command metadata entries are not Action Engine tools.
- API: `apps/api/src/marketing/`, rooted at `/v1/marketing/campaigns`. Identity comes from the existing identity guard; the controller resolves exactly one authorized principal/organization/school for the requested permission. Actor and school selectors are not accepted from clients. Multiple candidate scopes fail closed rather than choosing a school.
- Exact sensitive permissions: `marketing.campaign.read`, `.create`, `.update`, `.status`, `.attribute`. Attribution also retains the existing CRM-create or reviewed-import authority. HQ operator and guardian authority is not school campaign authority.
- Only `HUMAN_USER` / `HUMAN_UI`, without action-request or delegation claims. Mutation requests require the configured trusted public origin, JSON and the campaign human-command header; cross-site metadata is rejected. No-store responses and fixed parameterized SQL boundaries are retained.
- Workbench: `/staff/marketing/campaigns`, via the existing same-origin API proxy. It starts empty/unverified, retains keys for uncertain unchanged mutation retries, clears stale authorized data on denial and explains the planning-only and aggregate-only limits.

Campaign code (uppercase closed syntax, at most 40 characters), name, goal, optional offer label and enumerated channel are bounded human metadata. UTC millisecond date windows span 1–366 days. Planned budget is an integer from 0 to 1,000,000,000,000 minor units in one supported currency; there is no FX arithmetic. Code/currency/scope/creation identity are immutable. Create starts at version 1 and DRAFT. Valid status transitions are DRAFT → ACTIVE/ARCHIVED, ACTIVE → PAUSED/ARCHIVED, PAUSED → ACTIVE/ARCHIVED; ARCHIVED is terminal. Updates and status changes require the expected version and append a new snapshot, including reversals to previous field values.

## Storage, authorization and lock order

Unreleased migrations **0073–0074** add four private forced-RLS tables: `marketing_campaigns`, `marketing_campaign_versions`, `marketing_campaign_requests`, `crm_lead_attributions`. They intentionally have **no client policies or direct runtime grants**. Fixed SECURITY DEFINER boundaries have a fixed search path and trusted migration ownership. History/request/attribution evidence rejects update, delete and truncate; insert coherence guards and deferred current-version checks prevent inconsistent evidence even in privileged fixture writes.

Canonical runtime script `infra/postgres/010_supabase_hon_runtime.sql` reconciles the minimum ACLs, and `011_verify_supabase_hon_runtime.sql` plus `verify-rls.mjs` check them. The campaign runtime entry points are only `resolve_campaign_scope`, `authorize_campaign_lead`, `mutate_campaign`, `read_campaigns`; private validators, snapshot helpers and triggers are not runtime-executable.

`lock_campaign_actor` acquires **organization → school → user → principal → grants ordered by ID → roles ordered by ID → role permissions ordered by role/code → entitlement**, then revalidates live authority using a live clock. Reviewed-import 0074 now acquires the user **before** its retained principal/grant/role locks; finalize enters the campaign helper only after these earlier locks are already owned. No import authorization, review check or lock is removed. This eliminates the former principal → nested user inversion: organization serialization alone cannot protect a shared human who serves two different organizations. The deterministic integration test holds the user's row in one organization, observes another organization's finalizer actually blocked, proves the principal remains NOWAIT-lockable, enters the campaign helper, then releases the barrier and requires successful finalization.

Mutations and unchanged idempotent replays still require exact current authority; finalize additionally retains private-review authority. Campaign linkage requires attribution authority even before finalized replay. Campaign version snapshots, actor-scoped idempotency receipts, redacted audit and inert `marketing.campaign.human_planned` outbox evidence commit atomically. CRM and import attribution commits with its original command; injected audit/outbox failures must roll everything back. Events are internal evidence, not a new publishing consumer.

## Creation-time attribution and import compatibility

Every newly inserted lead gets a private immutable source-facts row; existing historical leads are **not backfilled**. The captured source code/facts and optional campaign snapshot cannot be rewritten by changing a lead's source, attribution, scope or creation identity later.

- Ordinary CRM creation accepts explicit top-level `campaignId` and/or `campaignCode`. Both selectors, if present, must identify the same ACTIVE current-school campaign at creation. The attribution snapshot retains that exact version/status even if the campaign is later revised, paused or archived. Dates are planning metadata; ACTIVE linkage does not imply a current date-window eligibility rule.
- Legacy CRM/import `campaign` remains independent free text and does **not** silently become canonical linkage. No-selector CRM request fingerprints preserve the previous shape for unchanged historic replay.
- Reviewed import adds explicit `campaignCode` to the closed mapping options. It preserves UTF-8/parser/caps/formula validation, explicit IMPORT/SKIP decisions, version/token/reviewer/expiry rules, deterministic never-merge duplicate suggestions, atomic selections and replay. Invalid or non-ACTIVE canonical linkage fails finalization without a partial person, lead, receipt or evidence row.
- Canonical import attribution preserves original batch ID, row index and SHA-256 source checksum, with composite organization/school/lead/campaign/import foreign keys and a deferred import-row-to-lead FK. Source facts must match the normalized source row and server-created provenance. Imports continue to emit only inert `migration.lead_import.*` evidence, never `crm.lead.created` automation.

Fixture cleanup for the existing import and affected CRM fixture suites removes immutable attribution first. The shared helper permits this only for the exact disposable local database/owner and loopback server, inside the caller's transaction. Only append-only cleanup guards are temporarily suspended; FK/check/coherence constraints and forced RLS remain. Trigger state must be restored. This is test-only, not a production deletion mechanism.

## Aggregate semantics

Campaign list reads return at most 100 ACTIVE or recently updated (90-day) metadata records; the per-school creation cap is 1,000. Known-ID current and saved-version reads do not expose lead identities or raw attribution.

Funnel windows are bounded historical 1–366 day half-open UTC intervals `[from,to)`. The cohort contains leads **created in that interval** with immutable attribution to the campaign. Trial counts use linked TRIAL appointments that also start in that interval; distinct trial leads and total/completed appointments are separate counts. WON/LOST/ARCHIVED counts use **current** lead status at read time, not event-time conversions. Counts can overlap. This is not a lifetime funnel or historical terminal-status reconstruction.

No contacts, raw import rows, notes, payment data or source facts are returned. `enrollmentLinkage` and `revenueLinkage` are explicitly **UNAVAILABLE**: the inspected schema has appointment-to-lead linkage, but no authoritative campaign → lead → enrollment/membership → revenue relationship. WON is not enrollment or payment. No ROI, actual spend, retention or fabricated revenue is inferred.

## Validation and rollout

Validation uses only guarded `localhost:5432/hon_campaign_validation`, disposable `hon_campaign_owner` / restricted `hon_campaign_runtime`, and private job-directory environment credentials. `setup-marketing-validation.mjs` refuses other targets or unmarked existing databases/roles, resets from scratch, applies all 74 migrations and applies aliased canonical 010 twice. No package installation, remote database, Supabase rollout or provider invocation is required or claimed.

Focused tests are `test-marketing-campaign-integrity.mjs`, `test-marketing-campaign-verifier.mjs`, existing `test-lead-import-integrity.mjs`, API `marketing-campaigns.test.cjs` and UI `marketing-campaigns-ui.test.tsx`. They cover exact live human scope, revocation/post-wait expiry, immutable/coherent source evidence, legacy/canonical separation, cross-organization lock ordering, replay/version races, redaction, forced RLS/private helpers, atomic rollback and zero external side effects. The verifier suite rejects/restores seven deliberate ACL/RLS drifts and checks no fixture trigger remains disabled. Root checks/tests/migration checks/builds run with database URLs unset.

**Final proof checkpoint:** pending the isolated fresh-reset validation; exact results will be recorded here and in `TODO.md` only after all gates pass. These new migrations have not been applied to a real database; edits are validated by disposable reset, never by asking a real database to reapply a changed migration.

## Remaining work

- **External marketing/publishing:** independently designed and reviewed ad/social/email/SMS adapters, provider credentials, consent, audience/creative/form/landing-page workflows, approval for publishing and budget changes, spend limits, external idempotency, reconciliation, failures and delivery evidence. Nothing is published or spent by this foundation.
- **Conversion/revenue/retention linkage:** establish authoritative scoped lead-to-enrollment/membership/payment relationships, event-time conversion evidence and attribution policy before reporting enrollments, revenue, ROI or retention. Do not infer them from current WON status or organization-wide billing totals.
- **Marcus/Lena AI path:** separately scope research/drafting/recommendations and approval-gated public publishing/budget proposals through the existing AI economics, permission and Action Engine architecture. Human campaign commands do not grant AI execution, delegation, access to private attribution or provider authority.
- Broader marketing product: offers beyond labels, audiences, creatives, forms, landing pages, calendar, social/reviews/SEO and performance workflows. This checkpoint is a useful human foundation, not completion of the whole growth product.
