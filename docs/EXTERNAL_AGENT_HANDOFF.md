# HON OS — External Coding-Agent Handoff

**Purpose:** This is the repository-native handoff for Claude Code, Codex, Cursor, or any other engineering agent contributing to HON. Read this document and [`../AGENTS.md`](../AGENTS.md) before proposing or changing code.

**Repository:** [`github.com/myhonosai/honos`](https://github.com/myhonosai/honos)
**Canonical branch:** `main`
**Current baseline when this handoff was written:** `5bed20e8b4c5d94672f262eca051e108fbb62f24`
**Status:** Active development. The baseline is a validated checkpoint, not a production deployment. GitHub is canonical; auto-publish is disabled.

> Do not assume the baseline SHA is still current. Begin with `git fetch origin main`, inspect `git status`, and read the latest `TODO.md`.

---

## 1. Authority order

Resolve conflicts using this order:

1. **Latest explicit owner direction** and already approved owner policy decisions.
2. [`HON_MASTER_DIRECTIVE.md`](HON_MASTER_DIRECTIVE.md) — core product, security, tier, AI, and architecture authority.
3. [`TODO.md`](../TODO.md) — dependency-aware delivery outcomes and real validation evidence.
4. Relevant domain operating contract under `docs/architecture/` or `docs/`.
5. Reconciliation documents, especially [`architecture/VISUAL_MODULE_BLUEPRINT_RECONCILIATION.md`](architecture/VISUAL_MODULE_BLUEPRINT_RECONCILIATION.md).
6. Existing implemented contracts, tests, and migrations.

Visual mockups, reference screens, illustrative prices, sample metrics, names, agent activity, and screenshots are **direction only**. They never authorize a live fact, new permission, provider call, payment, message, deployment, or external action.

---

## 2. HON in one paragraph

HON is a secure, multi-tenant martial-arts School Operating System. Conventional software, deterministic automation, conversational command, and governed AI employees operate on the **same** authoritative records, domain services, permissions, audit trail, and tenant scope. It is not a collection of disconnected CRM, billing, scheduling, attendance, or AI demos. Human UI must stay useful when AI, voice, or providers are unavailable.

Core lifecycle direction:

```text
Lead → Follow-up → Trial → Enrollment → Membership → Payment →
Schedule → Attendance → Student Progress → Parent Engagement →
Testing → Retention → Renewal → Reporting
```

Do not create a parallel data model, duplicate lifecycle, AI-only service, or UI-only authorization shortcut to fill a gap.

---

## 3. Non-negotiable engineering rules

### Tenant isolation and authorization

- Ownership is **HON Platform → Organization → School/subaccount → school-owned operations**.
- Never trust a route parameter, URL query, selector, local state, form field, UI card, client role, theme, or agent name as authority.
- Enforce the chain:

  ```text
  Identity → role → organization scope → school scope → permission →
  AI authority → approval → audit
  ```

- PostgreSQL is the authoritative store. Runtime access is tenant-context-bound and subject to forced RLS.
- HQ, school staff, and family/parent identities are separate planes. Never bridge them through a UI query or convenience helper.
- A browser page session gate is defense in depth only. APIs and database boundaries must independently authorize every read/command.

### Consequential changes

Use the existing normal-domain-service path. A consequential mutation must preserve, as appropriate:

```text
business change + idempotency outcome + audit evidence + transactional outbox event
```

No raw SQL from web/API controllers, generic mutation endpoint, generic function executor, arbitrary internal HTTP, or client-supplied actor/scope/authority.

### AI and Action Engine

The only valid consequential AI path is:

```text
AI → typed registered HON tool → permission → policy → authority →
approval → normal domain service/API → verify → audit
```

- AI models never receive inherent authority.
- `AUTO`, `CONFIRM`, and `RESTRICTED` are action-level server-enforced modes; the effective mode is the most restrictive applicable rule.
- Approval binds the normalized payload, target, recipients/content/amount/provider account where relevant, reviewer authority, policy version, and expiry. Revalidate immediately before execution.
- AI presentation (name, portrait, anime/chibi style, voice, customizer) must never change identity, model route, tools, permissions, history, usage, or authority.

### Financial and communication safety

- Never store raw card data.
- Never infer payment success from a provider request or unknown result.
- No AI may invent a refund, credit, discount, concession, extension, waiver, or membership change.
- No approved content/draft becomes a customer message without the separately governed consent/queue/delivery/receipt workflow.
- No external provider, payment, customer message, ad spend, publication, or deployment without explicit owner authorization.

### Truthful UX

Only render verified facts, an explicit unavailable/denied/empty/loading/error state, or a response-backed receipt. Do **not** fabricate KPIs, provider health, AI activity, availability, seats, payment success, enrollment, promotion, agent work, prices, credit balances, or outcomes.

---

## 4. Tier and commercial rules

- **Essential** remains a valid legacy/foundation entitlement. Do not silently remove, reprice, or convert it.
- New public planning surfaces expose only **Core** and **Complete**.
- **Core** is a complete conventional operations product. It must not require AI employees.
- **Complete** adds governed AI workforce/delegation capabilities, still constrained by Action Engine and approvals.
- Public price and premium-AI-credit figures are planning/display metadata only. They do **not** create a subscription, payment, credit balance, allocation, grant, or entitlement.
- Any real per-school AI-credit allocation, usage, cost reconciliation, and warning policy is a future **HQ-only** ledger/policy feature. Never show it as a school command-screen fact until that governed system exists.

Read before entitlement work:

- [`architecture/CORE_COMPLETE_ENTITLEMENT_ENFORCEMENT_AUDIT_2026-10-17.md`](architecture/CORE_COMPLETE_ENTITLEMENT_ENFORCEMENT_AUDIT_2026-10-17.md)
- [`architecture/HQ_ORGANIZATION_ENTITLEMENT_TRANSITION.md`](architecture/HQ_ORGANIZATION_ENTITLEMENT_TRANSITION.md)
- [`architecture/PUBLIC_PLAN_CATALOG.md`](architecture/PUBLIC_PLAN_CATALOG.md)

---

## 5. Presentation and design rules

HON supports three user-selectable presentation modes:

1. **Big-Button / Phone** — touch-first, large targets, low density.
2. **Modern HON** — deep navy/black command surfaces, electric cyan focus, restrained glass/panel layers.
3. **Classic CRM** — compact, high-density operational workspace.

They are **presentation only**. Each mode must preserve equivalent records, permissions, errors, navigation, actions, and security behavior.

AI visual styles are **Realistic 3D**, **Modern Anime**, and **Chibi**. They are presentation only and independent of the locked school roster: Alex, Chad, Maya, Marcus, Jordan, Claire, and Lena. HQ personnel are separate.

The appearance controls must remain visible/easy to access, not removed:

- In the Modern Complete school reference, the compact inline appearance control lives directly below School/Location, expands in normal document flow, and is keyboard-native.
- It must not become a modal, hide/disable presentation options, or alter scoped server theme persistence.
- Browser-local reference preference is not a school/HQ/family preference contract.

Read [`architecture/VISUAL_MODULE_BLUEPRINT_RECONCILIATION.md`](architecture/VISUAL_MODULE_BLUEPRINT_RECONCILIATION.md) before visual work.

---

## 6. Current implemented baseline

This is a selective map, not a claim that HON is complete. Inspect the exact contract and tests before changing any area.

### Platform and security

- PostgreSQL migrations, forced RLS, scoped runtime patterns, audit/outbox/idempotency foundations, and restricted runtime role conventions.
- Shared fail-closed `/staff/*` and `/hq/*` server session layouts; APIs retain their own authority checks.
- Staff dashboard exact-one auto-default and authorized multi-school reporting selector are deliberately bounded; no generic selected-school persistence exists.
- Scoped school presentation preference is implemented for selected verified staff modules; HQ and family persistence are intentionally separate future contracts.

### Conventional school operations

- Owner Launch supports school/program/class setup, adult or guardian/child registration, first class booking, membership **DRAFT** receipt, and a direct-human DRAFT membership activation workbench. Activation does not claim agreement, payment, billing schedule, or collection.
- CRM bounded human workbenches include lead creation/list/close, trial scheduling/outcome, and selected inert workflow handoffs.
- Scheduling includes guarded session creation, a bounded Class Sessions operational read, and canonical direct-human booking. A selected loaded session can prefill only organization/school/session selectors into manual booking; that destination remains idle until a human supplies the student, kind, and confirmation.
- Attendance, ClassPass/walk-in, planned absence parent request/staff review, invoice draft/issue, curriculum progress observation, testing candidate registration/outcome, and human promotion decisions have bounded vertical slices.
- Parent/family reads and requests remain family-safe and separate from staff/HQ identity.

### AI / HQ

- Action Engine approvals and narrow Marcus/Claire/Chad governed draft-work paths exist. Do not generalize them into raw AI access.
- HQ has separate resolver-backed overview/school/entitlement surfaces. The HQ Core ↔ Complete immediate transition is non-commercial, auditable, and not a credit/payment activation.
- Provider integrations and external delivery are still deliberately blocked.

### Major remaining gaps / deliberate blockers

- Full CRM/enrollment/membership/communications lifecycle; message consent/queue/delivery receipts.
- Real commercial subscriptions, processor integration/reconciliation, real AI-credit allocation/ledger, Core general-assistant policy.
- Provider-dependent voice, Meta/Google, SMS/email/push, payments, media generation, and production deployment.
- A full endpoint/function entitlement matrix, broader HQ executive durable-work evidence, and full multi-school operations.
- Parent account activation/public signup and broad student mobile experience.
- Membership cancellation/financial adjustment policy and school-specific billing policy need separate owner decisions.

Use `TODO.md` as the source of truth for dependencies, constraints, blockers, and demonstrated evidence.

---

## 7. Repository map

```text
apps/api/                 NestJS APIs, domain adapters, guards, services, API tests
apps/web/                 Next.js/React web app, routes, components, browser tests
packages/contracts/       Shared closed contracts and validators
packages/domain/          Domain rules/types
packages/database/        PostgreSQL migrations, local fixtures, RLS/integrity proofs
packages/auth/            Session/auth utilities
packages/config/          Safe static product configuration (not live commercial state)
packages/design-system/   Shared theme/style primitives
docs/                     Product authority and implementation/operating contracts
infra/postgres/           Runtime-role and canonical SQL verification materials
```

Important entry documents:

| Topic | Start here |
| --- | --- |
| Product authority | [`HON_MASTER_DIRECTIVE.md`](HON_MASTER_DIRECTIVE.md) |
| Active work and evidence | [`../TODO.md`](../TODO.md) |
| Visual direction | [`architecture/VISUAL_MODULE_BLUEPRINT_RECONCILIATION.md`](architecture/VISUAL_MODULE_BLUEPRINT_RECONCILIATION.md) |
| Owner first-value lifecycle | [`architecture/OWNER_LAUNCH_LIFECYCLE.md`](architecture/OWNER_LAUNCH_LIFECYCLE.md) |
| Core/Complete enforcement | [`architecture/CORE_COMPLETE_ENTITLEMENT_ENFORCEMENT_AUDIT_2026-10-17.md`](architecture/CORE_COMPLETE_ENTITLEMENT_ENFORCEMENT_AUDIT_2026-10-17.md) |
| School dashboard/current-scope rules | [`architecture/STAFF_OPERATIONS_DASHBOARD.md`](architecture/STAFF_OPERATIONS_DASHBOARD.md) |
| Class Sessions bounded read | [`HUMAN_CLASS_SESSIONS_READ.md`](HUMAN_CLASS_SESSIONS_READ.md) |
| Manual class booking | [`architecture/HUMAN_CLASS_BOOKING_WORKBENCH.md`](architecture/HUMAN_CLASS_BOOKING_WORKBENCH.md) |
| Lead create/list/close | `architecture/HUMAN_CRM_LEAD_CREATE.md`, `architecture/HUMAN_CRM_LEAD_LIST.md`, `architecture/HUMAN_CRM_LEAD_CLOSE.md` |
| AI draft inbox | [`architecture/AI_DRAFT_WORK_INBOX.md`](architecture/AI_DRAFT_WORK_INBOX.md) |

---

## 8. Required development workflow

### Before changing code

1. Fetch, inspect, and preserve the workspace:

   ```bash
   git fetch origin main
   git status --short
   git log --oneline -5
   ```

2. Read `AGENTS.md`, this handoff, the Master Directive, `TODO.md`, and the exact domain contract.
3. Trace the existing web route → browser transport → controller/guard → service → contract → migration/function/test path.
4. Reuse canonical services and records. Add an additive migration only when the domain truly needs new durable data/boundary.
5. Update `TODO.md` before implementation with the concrete user-visible outcome and constraints. Mark it complete only with real evidence.

### While changing code

- Build the smallest vertical slice. Prefer direct-human conventional capability before AI enhancement.
- Use closed request/response parsers in the browser. Same-origin reads/writes must use no-store behavior and the appropriate existing human transport marker/guard.
- Keep query parameters inert and closed. A URL prefill is an **untrusted selector**, never an automatic fetch, command, identity, authority, receipt, or capability.
- Clear stale UI state after scope/input/access changes. Do not retain old-scope facts or preference state.
- Do not bypass current domain services or invent generic admin/search/list surfaces.

### Validation

Run the smallest relevant focused tests first. Then run broader checks when the change warrants them:

```bash
pnpm test
pnpm check
pnpm build
git diff --check
```

For database changes, also use the project’s safe, disposable-local scripts as applicable:

```bash
pnpm db:check
pnpm db:migrate              # only against the explicitly intended non-production target
pnpm db:verify-rls           # only with the correct approved isolated/runtime configuration
```

Never point a fixture/setup script at a remote Supabase or production database. Never print or commit connection strings, JWT/session secrets, provider keys, job credentials, `.env` files, `.next`, `node_modules`, scratch databases, or `/home/ubuntu/jobs` contents.

### Git collaboration

- GitHub is the canonical repository: `github.com/myhonosai/honos`.
- Prefer a narrow branch and pull request for an external-agent contribution, e.g. `claude/bounded-session-read`.
- Do not force-push, rewrite `main`, delete branches/tags, or use `git clean`/reset to discard others’ work.
- Keep commits focused. Stage explicit intended files; inspect `git diff --cached --check`.
- A push is a checkpoint, **not** deployment. Auto-publish is disabled. Do not enable publishing or deploy without owner authorization.

### Required handoff/PR summary

Every external agent should state:

1. What changed and why.
2. Exact security/authority boundary preserved or added.
3. Tests/checks actually run and their outcomes.
4. Database migration status and whether a disposable-local proof was run.
5. Explicitly unchanged/excluded effects.
6. Remaining blocker or owner decision, if any.

---

## 9. Actions requiring owner approval

Stop and request explicit owner approval before any of the following:

- Paid API/provider invocation, model billing, ad spend, payment attempt, checkout, or processor activation.
- Production deployment/publication, destructive data operation, destructive migration, or remote database fixture/setup action.
- Sending a customer message, email, SMS, push, marketing campaign, or external delivery.
- New legal/compliance interpretation, agreement/consent meaning, tax/financial policy, or employment/disciplinary decision.
- Broad public posting, provider account connection, voice recording/wake-word activation, biometric/sensitive-data scope, or irreversible commercial transition.
- Changing a locked business policy without an explicit owner decision.

If blocked, record the blocker in `TODO.md` and continue an independent safe vertical instead of weakening the boundary.

---

## 10. Copy-ready prompt for an external coding agent

```text
You are contributing to HON OS, a secure multi-tenant martial-arts School Operating System.

Before changes, read AGENTS.md, docs/EXTERNAL_AGENT_HANDOFF.md,
docs/HON_MASTER_DIRECTIVE.md, TODO.md, and the exact relevant domain contract.

Work on one small vertical slice only. Reuse existing contracts, domain services,
RLS/function boundaries, audit/outbox/idempotency patterns, and Action Engine rules.
Never treat UI/query/form input as authority. Never create a parallel data model or
AI-only business path. Keep conventional software first.

Do not call paid providers, activate payments, send communications, deploy, alter a
remote/shared database, or expose secrets. Do not force-push or rewrite main.

For every proposal, name the route → transport → guard/controller → service →
contract → database/test path. Add/update TODO.md before implementing. Run focused
checks, broader regression when warranted, git diff --check, and report exact evidence,
non-effects, and any owner-policy blocker.
```

---

## 11. Final reminder

HON is deliberately conservative around authority and customer claims. A small, truthful, validated slice that reuses the existing system is more valuable than a visually impressive parallel subsystem or an ungoverned “AI feature.”
