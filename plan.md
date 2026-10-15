## Human family testing registration interest and exact staff review (after `1bac102`)
Implement only a verified family’s bounded interest for an existing currently OPEN future testing event, followed by a direct human staff member’s **ACCEPT**, **DECLINE**, or **WAITLIST** review under the exact sensitive `testing.registration.review` permission. A status is a human review record only: it does not establish eligibility, instructor approval, candidate, roster/capacity place, admission, payment, grade, promotion, history, notification, AI work or action.

Use private forced-RLS interest/receipt records and fixed trusted `SECURITY DEFINER` functions. A parent’s family scope is subject-derived and must be exactly one; student/event UUIDs shown by the redacted verified view are selectors, never authority. The mutation locks/rechecks active direct HUMAN_USER/HUMAN_UI, exact live family grant, active family-linked child profile and current open/future event. Staff scope must likewise resolve to exactly one live reviewed school; no client school/family/actor authority or permission fallback exists. Both commands use trusted same-origin JSON, closed bounded inputs, version/idempotency/replay protections, post-lock reauthorization, atomic redacted audit and inert internal-only outbox. No direct runtime/client table grants or consumer are added.

Deliver authenticated, dynamic, no-index `/parent/testing` and `/staff/testing/registrations` pages with strict same-origin HTTP DTO verification and truthful loading/access-loss/retry states. The parent view returns only the display child/event options and own redacted status; it excludes family/guardian/reviewer/rationale/parent-note, rank/curriculum/eligibility, candidate/grade/promotion, billing/payment, roster, audit/outbox, communication and AI facts. The staff queue allows explicit review actions only. Add focused contracts/API/web/SQL safety tests, canonical provision/verifier checks and architecture/TODO updates. Validate only a newly created disposable local PostgreSQL database; never a configured remote Supabase dataset.

# HON Implementation Plan

## Authority and scope

`docs/HON_MASTER_DIRECTIVE.md` is the durable product authority for this codebase. The architecture documents under `docs/architecture/` define the initial tenancy, CRM/Billing, outbox, and Action Engine implementation decisions; they do **not** narrow, replace, or supersede the Master Directive.

The build order is dependency-aware rather than sequential. Once shared contracts are stable, independent domains progress in parallel. No module creates a second business state machine, data model, authorization path, or AI-only service.

## Initial implementation approach

HON begins as a TypeScript workspace with a runnable web control surface and a separately bounded NestJS API/domain layer. The initial operational foundation establishes the reusable contracts that all later domains require:

- PostgreSQL schema migrations for tenant ownership, IAM, audit, event outbox, CRM, Billing, and Action Engine foundations.
- PostgreSQL transaction-context/RLS design in source, plus tests that run when a protected `DATABASE_URL` is supplied. The current managed Webdev database is MySQL-compatible and is intentionally not used because it cannot implement the approved PostgreSQL RLS model.
- A NestJS API application with versioned, school-scoped contract types, health/configuration readiness, typed command boundaries, and no direct client-to-database access.
- A Next.js staff-control application with conventional navigation, responsive operational shell, entitlement-aware navigation placeholders, accessible empty/loading/failure states, and an explicit safe configuration state when PostgreSQL is unavailable.
- Shared TypeScript packages for domain commands, API DTOs, permissions/action codes, tier-entitlement definitions, and UI design tokens.
- The first real vertical slice is a tenant-scoped CRM lead command/read workflow. Billing, Action Engine, and the transactional outbox are built to the same contracts in parallel once the command/audit/outbox interfaces stabilize. External payments, messaging, OAuth, realtime voice, Redis, and durable workflow providers remain adapter boundaries until their credentials/services are configured.

The application must never simulate a successful database write, payment, AI action, or third-party integration. If PostgreSQL or a provider is not configured, it presents a clear unavailable/needs-configuration state and preserves the contracts/migrations needed for safe activation.

## Product implementation boundaries

### Foundational shared contracts

`tenancy`, `iam`, `audit`, `eventing`, `entitlements`, `action-engine`, and `observability` are shared foundations. They are deliberately established before independent modules assume data ownership.

- All operational facts are organization- and school-owned.
- Organization metadata itself is RLS-protected by organization scope; the normal runtime role also excludes global identity/IAM directory tables so a future audited scope resolver—not ordinary domain code—will resolve verified identities to tenant scope.
- Every operational foreign key that could otherwise cross tenant boundaries is composite-scoped with organization and school ownership, rather than trusting an opaque UUID alone.
- All consequential changes use typed domain commands, idempotency, audit append, and transactional outbox append.
- Essential/Core/Complete is held as an organization-owned entitlement record enforced by the server, not a client-provided plan value. A missing or inactive entitlement fails closed for tenant mutation.
- Human UI, automation, AI tools, integrations, and Parent/Eian requests resolve to the same domain command.
- Permissions, tier entitlements, authority modes, approvals, and policy decisions are server-side.

### Parallel workstreams after contract stabilization

The following workstreams can progress concurrently once their shared contracts are accepted:

1. **CRM and enrollment** — pipelines, leads, activities, tasks, trials, conversion.
2. **Billing and membership** — account/payer/participant, agreements, schedules, invoices, reconciliation, ledger.
3. **Staff School OS** — navigation, dashboard, student/family, scheduling/attendance, staff, reporting, forms, and knowledge interfaces.
4. **Parent App/Eian contracts** — family-safe scope, Home/Schedule/Eian/Messages/More information architecture, student journey, progress and self-service APIs.
5. **Curriculum, testing, and progression** — flexible rank/curriculum models, instructor approval, testing lifecycle, no automatic promotion.
6. **Marketing, reporting, and growth** — attribution, campaigns, revenue goals, conventional reports and agent-ready analytics tools.
7. **Action Engine and Complete AI Office** — typed tools, approvals, durable work, orchestration, conversational status, voice/text abstraction.
8. **Community, Marketplace, and HON HQ** — separately permissioned public/community and privileged control-plane domains.

All workstreams consume the same tenant/RLS, API, audit/outbox, entitlement, and design-system contracts. Changes to these contracts require dependency review, additive migrations where possible, tests, and documentation updates.

## Technology structure

```text
honplatform/
├── apps/
│   ├── web/                    # Next.js staff/owner web application, port 3000 Preview
│   └── api/                    # NestJS domain/API process, independently deployable
├── packages/
│   ├── contracts/              # Versioned DTOs, commands, event envelopes, RFC 9457 problems
│   ├── domain/                 # Domain invariants, state transitions, policy interfaces
│   ├── database/               # PostgreSQL migrations, RLS helpers, repositories, test fixtures
│   ├── design-system/          # HON UI primitives, tokens, navigation, accessible states
│   └── config/                 # Tier/action/permission registry definitions
├── infra/
│   └── postgres/               # PostgreSQL role/RLS/bootstrap scripts and deployment notes
├── docs/
│   ├── HON_MASTER_DIRECTIVE.md
│   └── architecture/
├── TODO.md
├── package.json
├── pnpm-workspace.yaml
└── app.config.ts
```

### Service and API boundary

- The web app speaks only to versioned `/v1/organizations/{organizationId}/schools/{schoolId}/...` API contracts and the audited aggregate-only `/v1/organizations/{organizationId}/operations/summary` projection. It never sends an actor, permission, tenant authority, approval mode, or provider credential in its request body.
- The API maps authenticated request context to server-created command context and binds PostgreSQL tenant scope only within an explicit database transaction.
- Database repositories require `SchoolScope`; no operational `findById(id)` helper exists without verified organization/school scope.
- Provider adapters remain behind domain interfaces. PostgreSQL remains the source of truth; Redis/search/provider copies are derived state.

## Design direction

### Considered visual directions

| Direction | Probability | Character |
|---|---:|---|
| **Heritage dojo editorial** | 0.06 | Ink, paper, and belt-color accents with a ceremonial, editorial tone. |
| **Mission-control technical** | 0.05 | Dense operational telemetry with matrix-like interfaces and restrained glow. |
| **Calm operations atelier** | 0.04 | Warm stone surfaces, generous whitespace, and quiet progressive disclosure. |

### Locked direction — HON AI-native operating environment

The supplied HON Complete, HON HQ, HON Core, Parent/Eian, and mobile reference boards now remove broad visual discretion. HON must not become a generic CRM/admin template with a chatbot sidebar. Conventional modules remain fully available, but **Complete** and **HQ** place a visibly present, conversational AI team at the center of the operating experience.

- **Design movement:** Cinematic martial-arts command center with a disciplined, bright operational core; it pairs a premium dark AI environment with accessible high-clarity school-management surfaces.
- **Core principles:** AI team presence precedes dashboard density; conversation and voice/text command are the primary Complete/HQ interaction; business context frames the conversation rather than competing with it; conventional controls are always reachable and fully useful during AI/provider failure.
- **Color philosophy:** HON midnight/navy creates protected command space; electric sapphire is the Alex/Eian signal; teal represents safe active operation; violet represents creative/delegated work; gold represents review/approval; coral remains for risk or failure. Core and Parent/Eian use mist/white surfaces with these colors only as clear signals.
- **Layout paradigm:** A compact left rail anchors conventional navigation; the central field is a living AI command surface with a selected employee, work-state, voice/text lane, and contextual action proposals. The surrounding orbit holds only the business signals relevant to the current ask.
- **Signature elements:** Recognizable HON wordmark; distinct AI employee portraits with color/aura identity; work-state lozenges (Ready, Thinking, Working, Waiting for Approval, Completed, Needs Attention); a bright, speaking/listening command lane that visibly falls back to text.
- **Interaction philosophy:** A user can speak/type to a selected employee, switch employees within the same conversation, inspect collaboration/work states, and enter exact approval surfaces. Reference interactions demonstrate this state without claiming live automation before a scoped tenant and durable work backend exist.
- **Animation:** Ambient aura/presence is subtle and decorative only. Pulse, waveform, progress, and state transitions activate exclusively from an actual interaction/demo state; no fake claim that a real agent is working. Use 160–220ms state transitions and respect reduced-motion preferences.
- **Typography system:** Plus Jakarta Sans drives the expressive command hierarchy; Inter provides operational clarity; JetBrains Mono labels AI/team state, tool/action context, and approvals. Mobile preserves the same hierarchy at touch-first scale.
- **Brand essence:** The governed AI operating system that puts a martial-arts school’s team and next best action in one trusted command environment. **Capable, warm, disciplined.**
- **Brand voice:** “Your AI team is on it.” “See the exact action HON will take before you approve it.”
- **Wordmark and logo:** Bold geometric HON letterforms with a compact, energetic martial-arts mark; the wordmark lives confidently in dark command headers and remains crisp on bright Core/Parent surfaces.
- **Signature brand color:** **HON Signal Blue** — a bright sapphire reserved for the active AI command, speaking/listening state, and selected command path.

### Design-system checkpoint and representative screens

Before broad production screen expansion, the reusable design-system tokens/components establish typography, spacing, navigation, cards/surfaces, iconography, AI employee presentation/aura, voice/text interaction, approval surfaces, work-state, charts, mobile states, empty/loading/error states, and responsive behavior. All three presentation modes consume the same components and domain state.

Five high-fidelity, working **design-reference** screens are the approval boundary: **HON Complete Home / AI Command Center**, **HON HQ Home / AI Command Center**, **HON Core Home**, **Parent App Home + Eian**, and **Mobile HON Complete**. They use clearly identified representative data and interaction to demonstrate hierarchy, selected-agent switching, command/voice state, and contextual approvals. They do not fabricate an actual tenant action or propagate unapproved visual direction across the rest of the product.

The retained presentation modes are: (1) **Big-Button / Phone Style** for touch-first simplified operation, (2) **Modern HON Style** for the balanced AI-native daily school environment, and (3) **Classic / Agency-Platform Style** for higher-density conventional administration. A mode changes only presentation—not tenant scope, API, permission, tier, action authority, or data.

## Initial dependency graph

```text
PostgreSQL roles/RLS + tenant/IAM contracts
  ├── CRM command/query contracts ──┬── Staff CRM workspace
  │                                 ├── Trial/Scheduling contract
  │                                 └── Enrollment conversion
  ├── Billing command/query contracts ── Membership/Invoice UI
  ├── Audit + idempotency + outbox ───── Automation, reporting, provider adapters
  ├── Entitlements ───────────────────── Essential/Core/Complete navigation and tools
  └── Action catalog/policy ──────────── AI tools, approvals, durable work

Family scope + student model ─────────── Parent App/Eian + Student Journey
Curriculum/rank model ────────────────── Progress + testing + gamification
```

## Family and student data foundation

The first family/student migration deliberately separates **person**, **family**, **family relationship**, **student profile**, and **verified family-access grant**. It adds forced-RLS composite ownership to each table and avoids treating a phone number, email address, guardian relationship, or client-submitted family UUID as authorization. The later Parent App/Eian resolver must derive an active family grant from the verified human application principal; staff retains school-scoped permissions, and HQ does not inherit family access.

## Current external dependency

A protected PostgreSQL `DATABASE_URL` is used only for migration execution and controlled database-administrator checks. Supabase development now has a separate `HON_RUNTIME_DATABASE_URL` for the non-superuser, non-`BYPASSRLS` `hon_runtime` role; readiness, forced RLS, transaction-scoped isolation, and the current HQ Owner gate have been verified through that connection. The application refuses to fall back to the migration credential. Production requires an equivalently restricted runtime connection.

RLS is forced on all operational tables, including for the schema owner. Production runtime credentials must remain non-superuser and must not have PostgreSQL `BYPASSRLS`; the deployment role/bootstrap runbook will verify that fact before activation.

For Supabase development, the dedicated runtime role connects through the **Session Pooler** on the Supabase-provided host/port and uses the custom pooled username documented by Supabase. Session pooling is compatible with HON because every business action begins/ends its own transaction and binds tenant context with `set_config(..., true)` inside that transaction.

Outbox delivery has its own reviewed future credential and role boundary. `hon_outbox_worker` will receive only the fixed claim/result functions through `HON_OUTBOX_WORKER_DATABASE_URL`; it will not receive table privileges or RLS bypass. It is not activated until the separate worker login and explicit consumers are configured. An unknown external outcome goes to durable dead-letter evidence, never an automatic success or duplicate retry.

The repository includes a transaction-bound security test that creates temporary multi-tenant records inside a rolled-back transaction, verifies another tenant's row remains invisible, verifies a cross-scope composite foreign-key relation is rejected, and confirms context clears after transaction completion. It never leaves test records behind.

## Development operating rule

Continue with build, test, inspect, fix, retest, document, and integrate. The Master Directive’s Essential/Core/Complete behavior, Parent App/Eian, Student Journey, curriculum/testing, staff, marketing, reporting, Community/Marketplace, HON HQ, voice/recovery, AI economics, and Complete AI team experience remain required product scope and will be implemented through these shared contracts rather than retrofitted around them.

## HQ AI Provider Control Plane foundation

Completed the provider-independent, **configuration-only** foundation for OPENROUTER, DIRECT_LLM_API, HEYGEN, and HIGGSFIELD. Additive migrations 0052–0053 establish forced deny-all-RLS HQ provider/catalog/policy tables, opaque UUID-only credential references, HQ-only live-human resolver functions, optimistic/idempotent audited/outboxed writes, redacted reads, and server-entitlement-backed routing preview. A pure deterministic router enforces registered approval, ordered fallback, capability/modality/unit, active effective windows, health, minimum tier, and micro-unit budget without changing authority or invoking a provider. Schools receive no HQ config/table privileges or settings endpoint.

See [HQ AI Provider Control Plane](docs/architecture/HQ_AI_PROVIDER_CONTROL_PLANE.md) for contracts, deployment posture, test commands, and deferred activation. No SDKs, new environment keys, raw credentials, provider HTTP calls, LLM/media invocation, health probes, secret dereferencing, budget reservation, or model worker were introduced. Execution adapters require separate review and never inherit Action Engine authority from routing.

## Durable provider-independent AI invocation planning

Completed the next **decision-only** tenant dependency after the HQ control plane. Immutable additive migrations 0054–0056 establish `hon.ai_invocation_plans` with forced scoped SELECT RLS, immutable metadata snapshots, composite work-item ownership, fixed agent/TEXT/task/risk/token budgets, max/estimated provider microunits, customer-credit estimate, selected approved IDs/versions, metadata-only request hash and PLANNED-only status. Runtime has SELECT plus fixed planning/live-access EXECUTE, never HQ config/credential table access or direct plan writes.

`AiInvocationPlanService.plan` is internal-only and requires a direct HUMAN_USER/HUMAN_UI context, live active Complete entitlement, exact `ai.invocation.plan` permission/action metadata, locked RLS work item, expected READY/THINKING state/version, UUID idempotency and atomic plan/audit/outbox/replay. Selection is school-bound and HQ-approved, healthy only, with effective windows, code-owned task risk and provider/customer-budget eligibility. A narrow guarded GET returns a sanitized historical plan; there is no generic write/execute route. The registered action is RESTRICTED, not a Tool Gateway executable.

No provider/model/media call, credentials, raw prompt/output persistence, worker/consumer, Action Engine invocation/mutation, actual usage-ledger write, credit charge/reservation or work-state/assignment mutation is introduced. Successful replay returns history and never permits stale execution. No-choice persists nothing; a future retry can reevaluate live state. See [AI Invocation Planning](docs/architecture/AI_INVOCATION_PLANNING.md) for contracts, the first TEXT-only task slice, tests and separately reviewed execution dependencies.

## Core multi-location operations summary

Delivered the aggregate-only read slice through `GET /v1/organizations/:organizationId/operations/summary`. Migration 0058's fixed STABLE SECURITY DEFINER projection derives an active verified human, current effective `reporting.view` school set, active organization/schools and live Core/Complete entitlement in one statement snapshot. Only authorized schools contribute to either the organization aggregate or per-school rows; hidden-school IDs/counts, IAM/HQ directory data, PII/raw records and provider data are absent. School-bound forced RLS and runtime table grants remain unchanged; PUBLIC execution is revoked and the only new runtime right is the fixed projection EXECUTE.

Current students/leads, window-bounded sessions/attendance/recent activity and invoice status counts/minor-unit totals have explicit half-open, bounded UTC semantics and currency separation. Contracts/controller/service, real restricted-role integration tests, API unit tests, canonical provisioning and verifiers cover tier gates, active/effective grant revocation, same/cross-organization exclusion, READ ONLY/no-side-effect execution and safe response allowlisting. See [Core Multi-location Operations Summary](docs/architecture/CORE_MULTI_LOCATION_OPERATIONS_SUMMARY.md). Broader cross-school writes, permission administration, transfers, templates, tasks/goals, UI and AI coordination are deliberately deferred, not claimed complete.

## Human staff/custom-role administration

Continued after `b16320d` with a bounded **human-only staff IAM vertical slice**. Live inspection confirmed organization roles, role-permission mappings, school-effective grants, denied runtime directory grants and HQ's one system OWNER/bootstrap grant. Additive migrations 0059–0061 introduce sensitive exact create/update/manage/grant/revoke permissions (existing canonical OWNER only), school management/version metadata, explicit revocation, forced role-permission RLS, private registered-human exact target/recipient checks and fixed human commands/known-ID projections.

Identity-derived transaction context, organization/actor/school/grant/role/target locks, old/new permission subsets, no-self/HQ/system protections, optional 90-day expiry, immutable system ownership and final permission-equivalent owner coverage, SHA-256 idempotency and atomic audit/inert outbox preserve authorization. Live permission clocks execute after lock waits. There is no generic table mutation or runtime directory grant. Contracts/DTO/service/controller, canonical Supabase setup/verifier, live restricted-role integrity and unit tests cover these invariants.

The isolated conventional `/staff/roles` UI uses known IDs and exact forms through the authenticated same-origin API. Trusted `HON_PUBLIC_ORIGIN`, JSON/custom-header CSRF checks and HUMAN_UI/HUMAN_USER service/SQL gates exclude automation/Action Engine/AI/integration/delegation. Missing trusted origin refuses writes. No identity registration/contact lookup/invitation, payroll, autonomous employment/discipline, messaging delivery, provider call or consumer is introduced. See [Human Staff Role Administration](docs/architecture/HUMAN_STAFF_ROLE_ADMINISTRATION.md). Broader workforce product, ownership transfer and privileged IAM cleanup remain separately reviewed work.

## Human document templates, publication and internal acknowledgement foundation

Continued after `e73cb93` with a tenant-scoped **internal acknowledgement** foundation, not a legal e-signature integration. Additive migrations 0062–0064 establish single-school STAFF or single-family PARENT templates, immutable content versions/publication snapshots/hashes, server-derived human acknowledgement evidence, optimistic current-publication pointers and private domain idempotency response storage. All five document tables have forced deny-all RLS and no direct runtime grants; fixed SQL commands/projections alone read/write them. Sensitive explicit permission/command/tier registries, existing OWNER-only permission upgrades, canonical HQ bootstrap and Supabase setup/verifiers retain the closed authority boundary.

Direct HUMAN_USER/HUMAN_UI services/SQL, verified staff and existing parent-family resolvers, organization/school/actor/grant/template locks, fresh post-wait permission/guardian clocks, closed DTOs, idempotent replay and atomic audit/inert outbox reject AI/automation/integration/Action Engine/delegation. Acknowledgements require the currently published exact version/hash; superseded replay is denied, evidence never changes, parents never submit family/person/signer IDs and cannot read another signer/family receipt. Content and attestation do not enter generic audit/outbox or shared tenant-wide replay storage. STAFF/private/draft content never enters parent projection. STUDENT is rejected until a verified student-principal resolver exists.

Conventional staff and parent-safe reads and explicit same-origin `/staff/documents` and `/parent/documents` UI forms preserve a useful human-only path. Real runtime/direct RLS, contract/UI, cross-scope/audience, immutability/stale/replay/concurrency, source/expiry, directory/security, provisioning, atomic rollback and prohibited-effect tests cover the slice. See [Human Document Acknowledgements](docs/architecture/HUMAN_DOCUMENT_ACKNOWLEDGEMENTS.md). No provider/network call, signature image, legal signature verification, ESIGN/UETA compliance claim, payment, AI execution or automatic communication/delivery consumer is introduced. Legal/compliance/provider choice, student authority, broad distribution/export/retention and any downstream authorized workflows remain explicit separate decisions.

## Deterministic staff universal search

Add a single-school, verified-human GET projection with exact effective `search.global` authorization and no commercial upgrade gate. A code-owned fixed SECURITY DEFINER function uses an unambiguous active human, active organization/school, non-revoked effective role grants and a single statement snapshot; it does not trust tenant/principal GUCs. Only student names, CRM lead names/contact matching (contacts omitted from display), session names, program names and curriculum names are searchable. Responses contain at most 20 normalized display cards and scoped entity IDs with server-composed same-origin routes. Exclude directory identities, notes, knowledge/content/evidence, billing, AI metadata, HQ/credentials and all writes/executors. Reuse the established staff workbench visual style for `/staff/search`; add a reauthorized redacted result landing page so navigation does not imply a broader operational detail capability. HON Command and Parent/Eian search remain separate future work.

## Migration Center — deterministic human lead CSV slice

Continue from `878f586`. Add a conventional `/staff/migration/leads` workbench, not a whole-school migration product. Pinned local `csv-parse` parses UTF-8 CSV with strict quoting, 256 KiB / 1,000 data-row / 16-column caps. Every header has an explicit closed lead mapping; no fuzzy/AI matching or third-party storage. Validation errors remain staged and never write live CRM data. Existing `people` names/contact and `crm_leads.source_code` / JSON attribution are the only destinations; display-only names are retained verbatim (no guessed splitting), notes are attribution-only, not activity/communication records.

Private forced-deny-all-RLS batch, row, review-evidence and replay tables are accessible only through fixed authenticated HUMAN_USER/HUMAN_UI functions. Generic metadata reads contain no source filename, headers, contact values or row payload. An explicit reviewer-owned 15-minute token authorizes bounded raw-row review for that batch only. Exact sensitive `migration.lead_import.upload/read/review/finalize` permissions, live post-lock checks and trusted browser origin are required; no directory or import table grants. The server derives the single authorized school; ambiguous multi-school authority fails closed until a future trusted active-school session contract exists. A scoped pipeline/stage is selected from server-projected options, never an actor/tenant selector. All tiers including Essential may import.

Preview records deterministic exact normalized email/E.164 suggestions against existing school leads and same-file rows. Suggestions never merge or update existing records. Every row requires explicit IMPORT or SKIP; invalid rows can only be skipped. Version-checked idempotent review and a finalize request explicitly repeating the selected row indices are required. At most 1,000 leads are applied all-or-nothing in one controlled SQL domain transaction, with immutable private row decisions/applied evidence, unique batch-row lead provenance, redacted audit, and inert migration-only outbox events. Failure rolls back leads, batch, evidence, audit, outbox and replay together; the same request is safely retryable. No memberships, billing, messages, consents, AI, Action Engine or automatic follow-up effects.

Implementation lives in `apps/api/src/migration`, `packages/contracts/src/lead-import.ts`, migration `0067`, the fixed SQL verifier/provisioning scripts, and a same-origin Next staff workbench. Broader imports/export, provider integrations, automated deduplication, merge, and final whole-school migration remain deferred.

## Human curriculum progress completion checkpoint — after `7cfd7d4`

Completed the bounded instructor-only requirement/enrollment/progress foundation in additive migrations 0070–0071: immutable requirement versions, recorded enrollment/rank-placement history, explicit append-only observations, private idempotent replay and atomic redacted audit/inert `curriculum.human_recorded` outbox. Exact `curriculum.manage` / new sensitive `curriculum.progress.record`, live unambiguous human school authority, active Essential/Core/Complete entitlement, expected versions, locks and post-wait/replay authorization exclude AI, automation, integrations and delegated/Action Engine execution. All requirements MET never mutate enrollment/testing/promotion; existing explicit human registration, grading and evidenced instructor promotion remain separate commands.

The family-safe student-journey endpoint now projects only current matching-version requirement labels/kinds/required/status/time under live explicit guardian authority. Private notes, definition descriptions, instructor/rationale/history evidence and other families are absent; null means no current observation, not a score/readiness/approval. The unconnected `/parent` design reference shows Student Journey unavailable instead of fabricated progress. Canonical runtime and verifiers cover exact enrollment/grading column UPDATE minima, callable fixed command/read/authorization/lock functions and denied guard/evidence helpers, no direct private table/client grants.

Final validation passed from `/home/ubuntu/honplatform`: clean `pnpm check`, `pnpm test` (265 tests: API 48, web 32, auth 91, domain 94), `pnpm db:check` (71 files), `pnpm build` and `git diff --check`; the guarded disposable-local all-migration reset plus canonical setup; `pnpm db:test-curriculum-progress`; `pnpm db:verify-rls` (72 forced-RLS tables); and SQL runtime verification. Five deliberate ACL-drift probes were rejected and restored, then verifiers passed again after fixture cleanup. Canonical setup also reproduces existing 0046/0047/0051 grant minima for a runtime role first created after all migrations. Only pre-existing non-blocking CSS Autoprefixer warnings remain. No Supabase/production migration, provider invocation or fixture-dependent remote regression suite was run. See [Curriculum, Rank and Testing Foundation](docs/architecture/CURRICULUM_TESTING_FOUNDATION.md) for contracts and test scope.

**Remaining:** real React Native/Expo Parent App/mobile and authenticated child journey/practice wiring; conventional staff curriculum authoring/progress UI; age-appropriate gamification/achievements; the full eligibility → instructor approval → invitation → family registration/payment → roster/event lifecycle → grading/defer → promotion/history workflow; and separately reviewed external notification/push, certificates/belt fulfillment and registration/payment adapters/consumers. This foundation does not complete or activate any of those outcomes.

## Human campaign planning and immutable attribution (after `6fbdb4a`)

Reuse the existing Nest/PostgreSQL/Next staff architecture and staff workbench visual language. Add school-only campaign planning with exact sensitive `marketing.campaign.read/create/update/status/attribute` permissions on Essential/Core/Complete. Campaign status and bounded date/budget metadata are human-entered planning facts, never authority for spend, publication, credentials or delivery. Immutable campaign revisions, optimistic versions, actor-scoped idempotency receipts and redacted audit/inert internal outbox remain atomic behind locked live IAM and transaction-local RLS.

Inspection found free-text CRM `source_code` and JSON attribution, reviewed import migration checksum/batch/row provenance, TRIAL appointment-to-lead linkage and terminal lead status, but no lead-to-membership/revenue relationship. Preserve every new lead's source facts in a separate private immutable attribution row with composite lead/campaign/import FKs; optional campaign ID/code must resolve to an ACTIVE current-school record at creation/finalization. Legacy import `campaign` is historical free text; introduce explicit `campaignCode` mapping for canonical linkage rather than reinterpret existing data. Do not backfill or invent attribution. Summary reads allow only active/recent campaign metadata and bounded half-open cohort counts of leads, trials and current terminal outcomes; no contacts, notes, raw import rows, payment information or invented enrollments/revenue.

Structure: `packages/contracts/src/marketing-campaigns.ts`, `apps/api/src/marketing/`, numbered SQL migration, canonical `infra/postgres` ACL/verifier updates, `apps/web/src/app/staff/marketing/campaigns/` and accessible same-origin workbench. Retain uncertain mutation retry keys, clear stale authorized data on denial, and explicitly label human planning / budget-not-spend / no external publishing. Marcus and Lena remain future AI employees, with no access or scope increase in this slice.

Migrations 0073–0074 retain the existing import security model. Reviewed-import actor locking now uses organization → school → user → principal → ordered grants/roles before nested campaign permissions/entitlement locks, eliminating a cross-organization principal/user inversion without removing locks or post-wait review/authority checks. A deterministic observed lock barrier covers one human with campaign authority in one organization and a single exact import scope in another. Existing import integrity is rerun after attribution, including maximum 1,000-row finalization and inert migration-only evidence; immutable-attribution fixture cleanup is restricted to the guarded local disposable owner/database.

**Final checkpoint:** isolated fresh 74-migration/canonical-runtime validation and clean root gates are required before marking this foundation complete or committing. See [Human Marketing Campaigns and Attribution](docs/architecture/HUMAN_MARKETING_CAMPAIGNS_AND_ATTRIBUTION.md) for contracts, half-open creation-cohort/current-status semantics, test commands and rollout limits.

**Remaining:** external ad/social/email/SMS provider publishing, credentials, consent, approval/budget controls, spend and delivery/reconciliation evidence; authoritative lead-to-enrollment/membership/payment/revenue/retention linkage and conversion policy; broader audiences/creatives/forms/landing pages/calendar/reviews/SEO; and a separately reviewed Marcus/Lena research/drafting/recommendation and approval-gated publishing/budget proposal path through AI economics, exact permissions and Action Engine boundaries. No provider, AI, payment, communication or Action Engine execution changes are activated here.

## Public published lead-form intake (after c8e8b68)

Reuse the existing school CRM, campaign snapshots, human permission boundaries and staff styling. Exact human form read/configure/publish/disable permissions on Essential+ manage private pipeline/stage settings and an optional explicit ACTIVE same-school campaign. Publish only bounded presentation metadata and an unguessable ID. Vetted optional fields are closed choice codes, not arbitrary custom text or a website builder.

A dedicated unauthenticated JSON-only POST derives all tenant/actor/campaign state from the published form. Small uncompressed UTF-8 body cap, closed single-line/formula-safe fields, honeypot, bounded retry key, persistent per-form/contact limits and 24-hour duplicate receipts do not rely on IP. A fixed no-grant SYSTEM_SERVICE creates a new ordinary person/CRM lead through a private code-owned SQL helper. A private transaction-bound receipt proves public provenance to the attribution trigger; caller-set GUCs cannot authorize it. Immutable source/form/campaign evidence and redacted inert audit/outbox are atomic. Acknowledgement is only a fact: never messaging consent, merge, membership, payment, appointment, AI or external action.

Private forced-RLS tables have no direct runtime/client ACLs. Only exact runtime entry points have EXECUTE; no PUBLIC or Supabase client execute is needed. Live human revalidation, ordered locks and optimistic versions serialize lifecycle/campaign changes against submission. Add /staff/marketing/forms and endpoint-backed /forms/[publicId], canonical SQL/verifiers, isolated local proofs and docs. No hosting deployment or remote database mutation.

## Human staff availability and qualification foundation (after c1cbcf9)
Reuse the existing session-derived NestJS fixed-function boundary and same-origin Next staff styling. Existing IAM has no employment category: eligible staff are active unique HUMAN_USER identities with a live school role carrying reviewed staff-assignable authority, excluding parent/student/HQ/system categories and HQ principals. OWNER is eligible. Never create people, grant roles or make employment decisions.
Immutable school/principal profiles arise only at the first authorized revision. Independent availability and qualification streams are append-only full-state revisions with compare-and-append expected versions and immutable durable scoped receipts. ISO weekday 1–7, HH:mm school-local windows, no overnight/overlap, 15-minute minimum, 28 windows; applicability is a local date with optional exclusive end. Qualifications: at most 30 bounded title/issuer/optional expiry entries, no uploads/verification. ENDED revisions preserve history. Exact self availability, manager availability and qualification permissions are Essential+ HUMAN_ONLY metadata, not Action Engine tools. Exact self or already-known UUID reads only, no roster/directory/PII.
Lock organization/school, ordered users/principals/grants/roles/permissions and entitlement, then recheck live actor/target and clock before replay/write/evidence. Forced deny-all RLS; runtime receives three fixed definer functions, no tables/private helpers. Atomic redacted audit/inert outbox. No class/session mutations, assignment/qualification/availability inference, payroll/timecard/attendance meaning, employment decisions, calendar sync, messages, AI/provider/Action Engine execution. Add /staff/team/availability current/history/end controls, safe help, retained-key truthful retries and manifest. Extend canonical 010/011/verifier, isolated local integrity/drift tests and docs. Use existing check/test/build diagnostics because webdev MCP is unavailable; never mutate configured remote Supabase for validation.

Staff foundation delivered in the existing folders: `apps/api/src/staff-availability/`, `apps/web/src/app/staff/team/availability/` and staff components, shared contracts/config, migration 0077, canonical 010/011 and guarded integrity/drift tests. Final inspection also added an internal exact staff-permission predicate so a valid local staff role cannot borrow authority from a parent or wrong-management-school role. Full clean-local proofs and root validations are complete; remote application of 0077 and canonical role reconciliation remains an operator step, not a claimed deployment.

## Human CRM follow-up foundation (after 9b1d925)
Extend the existing fixed-function human API boundaries and mobile staff workbench, without changing durable Work Items or Action Engine. Private school identities link by composite FK to existing leads; append-only versions preserve create/update/complete/cancel/reopen and immutable scoped retry receipts. Essential, Core and Complete receive the same useful human workflow. Never advance lead stages or next-follow-up fields.
Independent `crm.follow_up.self_manage` and `crm.follow_up.manage` permissions also require exact-school `crm.lead.read` from valid staff roles. Self access follows current assignment and cannot assign others. Managers see bounded team metadata and may assign already-known active human UUIDs with exact self-manage/lead-read authority. No directory or external recipients. Team queues exclude subjects, notes and all joined lead/contact data; authorized detail exposes only follow-up content. Managers can recover inactive assignments through reassignment; inactive staff cannot use self access.
Closed DTO and SQL validation, bounded plain subject/note/priority, nullable canonical UTC due metadata (2000–2099, never a timer), immutable lead linkage, optimistic transitions and current-assignment replay authorization. Lock topology, ordered identities/grants/roles/permissions and entitlements, then live recheck before state and evidence. Atomic redacted audit/inert outbox/receipt; FORCE-RLS deny-all tables and exact runtime function grants only. No action proposal/tool, automation, AI/provider, communication, payment, trial, appointment or membership effects.
Deliver `/staff/crm/follow-ups`, own/team pagination, exact known lead/assignee IDs, detail/editor/lifecycle, retained uncertain retry keys and truthful empty/error states using existing mobile styling. Extend contracts/config/API/runtime, migration 0079, canonical ACL/verifier, disposable localhost integrity/drift tests and documentation. No remote mutations or publishing. Existing check-only diagnostics are the repository fallback when managed diagnostics are unavailable.

Delivered and validated locally: migration `0079`, the fixed controller/service/contracts/config/workbench, canonical ACL/verifier, architecture contract and guarded local migration alias now form the bounded human-only foundation. A fresh 79-migration reset used only `localhost:5432/hon_followup_validation` with `hon_followup_owner`/`hon_followup_runtime`; canonical provisioning was reconciled before `pnpm db:test-crm-follow-ups` passed, including all 12 deliberate drift denials, actual-row non-bypass-owner FORCE-RLS proof, late self-permission deletion, and wrong-management-school borrowing regression. With `DATABASE_URL` and `HON_RUNTIME_DATABASE_URL` unset, root `pnpm check`, `pnpm test`, `pnpm db:check`, and `pnpm build` passed. This is not a remote migration/deployment or authorization to add reminders, outreach, automation, AI, Action Engine execution, provider calls, or a consumer.

## Human membership renewal review foundation (after `2d32c29`)

Build `/staff/billing/renewals` as a conventional shared school finance/manager workbench, equally useful in Essential/Core/Complete. Use exact `billing.renewal.manage` plus `billing.membership.read` from live staff-valid school grants; there is no self/assignee permission, organization/HQ/parent/public access, or payer directory. Read only an already-known membership UUID. Payer identity is never authorization and payer/contact/payment-method/provider data is excluded.

Append-only review roots, immutable version snapshots and permanent scoped actor idempotency receipts capture a bounded canonical UTC half-open review window (1 minute–366 days in 2000–2099; past and future both permitted), status OPEN/REVIEWED/DEFERRED/CLOSED, mandatory explicit private note and reason, and optional manual reminder-needed boolean/null. Each human save snapshots existing membership state/version/term plus bounded safe schedule facts; current facts are read separately and never rewrite history. Missing/open-ended terms and an observed auto-renew schedule flag are facts only, not a renewal eligibility decision, collection plan or customer promise. Closed records need an explicit reasoned OPEN revision to reopen; deferred/reviewed are human workflow labels only.

Use fixed SECURITY DEFINER boundaries, forced deny-all private RLS, exact live locked IAM/role/permission/entitlement revalidation before replay and result, scoped membership/account/participant/payer/schedule locks for consistent safe facts without identity projection, atomic redacted audit and inert outbox. No notices, emails/texts, card charging, payments/refunds, invoice/membership/schedule mutations, Action Engine, AI/providers or external billing activation. Reuse existing same-origin proxy, staff styling and explicit retained-key retries; bounded queues and history exclude notes/reasons. Canonical 010/011/JS verifier and disposable-local ACL/RLS/drift/rollback/concurrency validation accompany the feature. Existing webdev diagnostics connector is unavailable in this execution; use full workspace TypeScript checks/tests/build instead, without changing hosting.

## Human HON owner community foundation (after `08336e8`)
Closed authenticated `/community` reuses server identity, same-origin human guard and existing staff styling. Published topics/posts/comments are deliberately shared only with live verified human owner/operator members across explicitly opted-in organizations/profiles. Drafts, archives and history are author-private; no public internet, parent, generic staff or arbitrary HQ access. Trusted manual verification is private database administration, not role self-attestation. Exact-school permissions, active identity/topology/entitlement and current verification are checked before reads, saves and replays. Explicit already-known school selection supports multi-location without a directory. Minimal display name only; no contacts or operational records.
Append-only consent/profile/content/history and redacted community-only audit/receipts; closed bounded plain fields reject URLs, contact patterns, markup and attachment keys, immutable kind/parent, optimistic lifecycle, no hard delete. No global outbox, execution, Action Engine tools, AI/provider, automated moderation, external/social publishing, marketplace, marketing, messaging or payments. FORCE-RLS deny-all private tables, fixed trusted boundaries, canonical ACL/SQL and JS verifier. No remote database mutations or hosting changes. Diagnostic connector discovery found no applicable tool; existing TypeScript checks/build/tests supply validation.
Structure: `packages/contracts/src/community.ts` closed contracts/redacted verifiers; `packages/config/src/community.ts` human-only command registry; `apps/api/src/community` fixed API/DTO/service; migration `0081` private SQL/IAM boundaries; `infra/postgres/010`/`011` and database scripts enforce ACL/RLS; `apps/web/src/components/community-*` and `/community` provide the mobile-safe conventional workbench with explicit opt-in, publish/archive and manual retained-key retries.

## Human Action Engine approval workbench (after `102c1d1`)
Reuse `ActionEngineService`, existing requests/approvals/policies, and the reviewed CONFIRM/two-person/hash/policy/expiry rules. Add `/staff/action-center/approvals`, an authenticated same-origin queue/detail/approve/refuse surface. School UUID is a selector, never authority; verified subject and live exact `action.approve` resolve actor/organization. Reject HQ, parent, nonhuman, delegated and Action Engine contexts. Display immutable normalized payload and exact hash/requester/action/policy/authority/expiry/required permission; withhold unsafe credential-bearing payloads and block decisions rather than silently redact approved intent. No payload editor or create/execute endpoint.

Harden existing decision binding to the displayed snapshot, live reviewer/requester IAM, topology/entitlement/current authority and post-lock expiry. Preserve row-locked idempotent atomic decisions/audit/inert outbox and honest historical receipts. Add a fixed live reviewer lock/check function, immutable proposal/evidence triggers, precise ACL/RLS and canonical verifier checks; no generic SQL/tool/directory privileges. Reuse existing clean staff styling and same-origin Next rewrite. No new handler/worker/consumer, provider/LLM calls or external financial/membership/marketing/communication effects; do not invoke the existing executor. Validation uses a fresh guarded disposable localhost PostgreSQL database only; remote credentials remain unused. Broader execution adapters and future action-specific domain revalidation remain separately reviewed.

## Complete human voice/text handoff foundation (after `7cd8eaa`)
Implement `/staff/voice` as a same-origin verified-human, exact Complete school/actor-owned session ledger, not a voice adapter. Fixed private SECURITY DEFINER create/read/status/fallback/end boundaries retain only approved static catalog IDs, optional scoped work/action/approval IDs and an actor-owned prior-session ID. REQUESTED → VOICE_CONNECTING → VOICE_UNAVAILABLE → TEXT_FALLBACK → ENDED permits forward skips; no connected/listening/speaking success state exists. Live IAM/topology/entitlement/reference permissions are locked/rechecked after waits, exact versions and UUID receipts serialize retries. Thirty-minute expiry blocks changes except explicit end; reads expose historical evidence without rewriting it. Audit/inert outbox are atomic and omit draft content. Strict bounded safe-text fallback drafts belong only to the creating user and explicitly do not send a command. No microphone/provider/LLM/transcript/audio/invocation/action/work/usage/billing/communication execution, configuration or authority is added. Eian/family and HQ remain separate designs.

## Conventional human work-item workbench (after `0ce9442`)
Extend existing `hon.work_items`, not a parallel/AI queue. Keep exact states and matrix: READY (new), WORKING (in progress), WAITING (blocked), NEEDS_ATTENTION (triage), COMPLETED, FAILED (closed unsuccessful). No invented cancelled/reopened state or AI thinking/approval claim. Legacy rows stay legacy and are not presented as human work.
Bounded plain title/description, LOW/NORMAL/HIGH, optional canonical UTC due date and optional already-known active exact-school human assignee. Exact work_item.manage enables school team read/edit/reassignment; work_item.self_manage permits current-assignee read/state updates only; work_item.create allows self/unassigned creation (assigning others also requires manage) and creator visibility. No global directory/parent/HQ/nonhuman/delegation reuse. Basic work is equally available on active Essential/Core/Complete.
Owner-only forced deny-all RLS and closed SQL entrypoints; live actor/assignee IAM locks/rechecks, version/idempotency/concurrency, immutable revision metadata history, atomic redacted audit/inert outbox. Existing AI planner retains only a scoped reference lock; detail displays existing plan IDs only, not work attribution, prompts/results/tool payloads. Comments are deferred; human attribution is immutable metadata history.
Structure: packages/contracts owns closed fields; packages/database migrations/canonical SQL own authorization/durability; apps/api/src/work-items owns fixed human endpoints; apps/web components and /staff/work reuse restrained staff workbench styling with queue/detail/forms and manual retained-key retries. No worker, autonomous assignment, executor/reminder, provider, communication/payment/marketing effect.

## Permission-aware human marketplace assets (after `cfee067`)
Reuse explicit community organization/profile opt-in and verified human membership only, never discussion content. Authenticated same-origin `/community/marketplace`: browse/save for review only; no purchase/install/automation. Exact `marketplace.asset.read`/`marketplace.selection.save` require verified OWNER; `marketplace.asset.manage` permits verified OWNER/OPERATOR creators. No parent/HQ/generic staff/delegated/AI/Action Engine contexts. Creator draft → publish → terminal archive; manual trusted database-owner curation binds each published version. Publishing or updating alone never grants shared visibility. Minimal curated projections omit creator/school/profile/discussion/internal history. Strict closed bounded descriptive metadata, category/module/required-permission allowlists; no private/PII/credentials/URLs/attachments/code/arbitrary JSON/scripts. Deterministic syntax checks are not semantic PII classification: human curation must reject confidential content.
School-bound owner planned selections pin an exact version, forever disabled REQUIRES_REVIEW; revocation/archive/curation withdrawal redacts saved metadata and blocks replay. Private append-only tables, FORCE deny-all RLS, exact owner-only SQL entrypoints, live locked IAM rechecks and community serialization, optimistic versions/receipts, atomic redacted private audit and inert outbox with no consumer. No configuration/domain/provider/execution/public distribution changes. Structure: contracts/config marketplace modules, migration 0085/canonical ACLs/verifiers, API marketplace folder, web marketplace components/route reuse community styling. Validation uses a new guarded disposable localhost PostgreSQL database only; no remote migration/configuration.

## Human-governed student achievements (after `56fe162`)
Reuse the active school/person/student/family topology and exact live school staff IAM, not a directory or curriculum rules engine. School-owned, human-created achievement definitions are closed descriptive name/description/category/age-band/optional visual-catalog metadata with active → terminal archive and immutable revisions. Explicit known-student awards pin the definition version and keep instructor/staff human decisions, optional private reason, award date and family visibility in immutable revision streams; corrections and terminal withdrawal never retarget a student/definition. Age-band validation uses the known birth date at the human award date, not readiness scoring. Unknown ages fail closed. No automatic award, promotion, testing eligibility, attendance/points/rank or curriculum-observation writes.
Exact `achievement.definition.read`, `achievement.definition.manage`, `achievement.award.read`, `achievement.award.record` are school staff-assignable; management permissions do not imply unrelated read permissions. Verified human UI only, no HQ/parent role reuse, AI/delegation/actions. Recognition has no commercial tier restriction. FORCE deny-all RLS, private immutable identities/versions/receipts/events/inert outbox, live locked IAM and family/student topology, optimistic versions and scoped fingerprinted replay reauthorize before results. Parent GET is exact current authorized family/child only, latest visible nonwithdrawn awards and pinned descriptive metadata, no reasons/actors/history/sibling records.
Structure: contracts achievement closed types/verifiers; migration 0086 and canonical runtime grants/security verifiers; API achievements controller/service/guard; authenticated same-origin staff `/staff/students/achievements` and separate parent `/parent/achievements` safe exact-child read workbench, route manifest/navigation. Reuse restrained staff workbench style. No child social feed, notifications, provider/AI/action execution, communications or payments; private inert evidence is deliberately not the global delivery outbox. Local disposable database validation only, no remote database mutation.

## Staff operations dashboard — delivered

- Added `/staff/dashboard`: a conventional, session-protected, no-index staff operational dashboard backed solely by the existing same-origin single-school operations report.
- The dashboard verifies the selected school through the report's existing live `reporting.view` scope, rebuilds the aggregate-only DTO client-side, and clears all content on access failure.
- It shows only supported classes/attendance, lead, membership, and invoice-status aggregates. Trial, revenue-plan, follow-up, renewal, approval, and work-item totals are deliberately marked unavailable/not counted where no approved aggregate exists, with links to the managed workflow pages.

## Family-safe Parent Student Journey (after `bed5444c`)
Replace the unconnected `/parent` reference with authenticated dynamic no-index `/parent/journey`. One fixed read-only API accepts no selectors/query/body authority. Internal subject-only discovery delegates to the exact existing live family resolver; missing/ambiguous families fail closed rather than selecting an arbitrary family. Child selection stays local to the returned authorized Journey child set, never sends IDs. Contracts own a closed ID-free display DTO/verifier; API families own read aggregation and resolver adapter; web routes/components reuse HON theme IDs/CSS variables with mobile-first touch targets. Only active child profiles/current enrollments and current observations, unambiguous name-matched authorized schedule and visible human achievements are shown. Historical testing, staff reasons, contacts, co-parent evidence and all billing are omitted. Existing documents LIST exposes publications but no receipt list; existing absence API has no parent GET. Mark receipt/absence status unavailable, never infer acknowledgement or fabricate data. Link the existing explicit document desk only, no write integration. Add a read-only scope-discovery SQL function and exact ACL entry only; no domain/table mutation, broad grants or remote migration. Reauthorize before/after aggregation; clear data on failure, blur and permission loss. No AI/provider/voice/action/payment/communication effects.
