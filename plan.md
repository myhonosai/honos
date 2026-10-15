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

### Selected direction — Calm operations atelier with semantic signal paths

- **Design movement:** A refined operations console that combines martial-arts discipline with modern hospitality SaaS; it is calm by default and visually decisive only when an action, risk, or approval needs attention.
- **Core principles:** One primary job per view; operational state is explicit; hierarchy beats decoration; conventional navigation remains primary even when AI assistance is available.
- **Color philosophy:** Deep ink/navy supports focus and security-sensitive context; mist/light surfaces make dense tables readable; teal identifies trusted/available system pathways; gold identifies approval/review; coral identifies blocked/failed conditions. Belt-inspired accents are reserved for progression and not used as generic decoration.
- **Layout paradigm:** A persistent left operational rail with a contextual command lane and content that moves between concise overview, focused table/workspace, and right-side detail panel—rather than a grid of unrelated dashboard cards.
- **Signature elements:** A compact HON monogram mark; thin teal system-path rule; a visible context capsule showing organization/school/role; clear action-status chips that distinguish working, waiting for approval, failed, and complete.
- **Interaction philosophy:** Fast deterministic controls first. AI is a visible assistant surface that explains what it can do, produces structured proposed actions, and never replaces menus, filters, forms, or direct record work.
- **Animation:** Short 160–220ms transition/opacity movement for drawers, status changes, and command responses. No fake “thinking” loops; active motion requires a real request/work state.
- **Typography system:** Plus Jakarta Sans for navigation/headlines and Inter for operational body/table text; JetBrains Mono only for request IDs, tool/action labels, and technical diagnostics.
- **Brand essence:** The operating system that lets martial-arts schools run normally, automate intelligently, and delegate safely. **Disciplined, welcoming, trustworthy.**
- **Brand voice:** “Your next best action is ready.” “Review exactly what HON will do before it does it.”
- **Wordmark and logo:** A compact black belt loop forming an abstract H/O mark, paired with a geometric HON wordmark; no generic martial-arts iconography.
- **Signature brand color:** HON Signal Teal, used solely for trusted navigation, verified status, and safe automation paths.

### User-selectable operating views

The supplied Ideal OS and HON references establish a product requirement for three selectable, not merely responsive, operating views. The selected view changes presentation only; it never changes tenant scope, entitlement, navigation availability, action authority, or data visibility.

1. **Operations Light** is the approachable bright school-control surface: modular navigation, clear cards, small semantic color accents, and quick contextual actions.
2. **Operations Dark** is the low-light operational console: a denser dark workspace with the same conventional functions, high-contrast statuses, and focused work visibility.
3. **AI Office** is the Complete-tier team experience: visible Alex/Chad/Maya/Marcus/Jordan/Claire/Lena roles, real work/approval states, a text-first command lane, and optional voice controls. It makes no claim that an AI employee is working unless a durable work item exists.

Views are keyboard-accessible, preserve the same information architecture, and use exact data/status surfaces instead of illustrative dashboard metrics. The visual references guide light/dark palette, modular navigation, and the friendly but disciplined AI-team presentation; they do not become a second application architecture.

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

## Current external dependency

A protected PostgreSQL `DATABASE_URL` is used only for migration execution and controlled database-administrator checks. Supabase development now has a separate `HON_RUNTIME_DATABASE_URL` for the non-superuser, non-`BYPASSRLS` `hon_runtime` role; readiness, forced RLS, transaction-scoped isolation, and the current HQ Owner gate have been verified through that connection. The application refuses to fall back to the migration credential. Production requires an equivalently restricted runtime connection.

RLS is forced on all operational tables, including for the schema owner. Production runtime credentials must remain non-superuser and must not have PostgreSQL `BYPASSRLS`; the deployment role/bootstrap runbook will verify that fact before activation.

For Supabase development, the dedicated runtime role connects through the **Session Pooler** on the Supabase-provided host/port and uses the custom pooled username documented by Supabase. Session pooling is compatible with HON because every business action begins/ends its own transaction and binds tenant context with `set_config(..., true)` inside that transaction.

Outbox delivery has its own reviewed future credential and role boundary. `hon_outbox_worker` will receive only the fixed claim/result functions through `HON_OUTBOX_WORKER_DATABASE_URL`; it will not receive table privileges or RLS bypass. It is not activated until the separate worker login and explicit consumers are configured. An unknown external outcome goes to durable dead-letter evidence, never an automatic success or duplicate retry.

The repository includes a transaction-bound security test that creates temporary multi-tenant records inside a rolled-back transaction, verifies another tenant's row remains invisible, verifies a cross-scope composite foreign-key relation is rejected, and confirms context clears after transaction completion. It never leaves test records behind.

## Development operating rule

Continue with build, test, inspect, fix, retest, document, and integrate. The Master Directive’s Essential/Core/Complete behavior, Parent App/Eian, Student Journey, curriculum/testing, staff, marketing, reporting, Community/Marketplace, HON HQ, voice/recovery, AI economics, and Complete AI team experience remain required product scope and will be implemented through these shared contracts rather than retrofitted around them.
