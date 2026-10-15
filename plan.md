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

- The web app speaks only to versioned `/v1/organizations/{organizationId}/schools/{schoolId}/...` API contracts. It never sends an actor, permission, tenant, approval mode, or provider credential in its request body.
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

See [HQ AI Provider Control Plane](docs/architecture/HQ_AI_PROVIDER_CONTROL_PLANE.md) for contracts, deployment posture, test commands, and deferred activation. No SDKs, new environment keys, raw credentials, provider HTTP calls, LLM/media invocation, health probes, secret dereferencing, budget reservation, or model worker were introduced. Future tenant decision-only access and execution adapters require separate review and never inherit Action Engine authority from routing.
