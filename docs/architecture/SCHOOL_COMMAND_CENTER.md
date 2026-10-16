# HON School Command Center

## Purpose

The School Command Center is an **optional, conventional, read-only owner/staff dashboard**. It extends the existing operations dashboard with a smaller set of deterministic daily priorities and explained navigation cards. It does not replace CRM, reporting, renewal reviews, Action Engine approval workbench, or durable-work workbench.

The Command Center remains useful when every AI provider is unavailable.

## Authority and scope

`GET /v1/organizations/:organizationId/schools/:schoolId/command-center` accepts known organization and school IDs only as selectors. The fixed `hon.read_school_command_center(text, uuid, uuid)` projection independently verifies:

- exactly one active direct `HUMAN_USER` for the verified application subject;
- active organization and selected school;
- one effective direct school-level `reporting.view` grant;
- an active **Essential**, **Core**, or **Complete** organization entitlement;
- no parent/family or HQ authority path.

The projection is a `STABLE SECURITY DEFINER` function with fixed `pg_catalog, hon` search path. `PUBLIC` is revoked and `hon_runtime` receives only `EXECUTE`; the normal runtime role receives no new table or schema-administration grant.

## Returned facts

The snapshot contains only aggregate/status facts with explicit UTC windows:

| Fact | Semantics |
|---|---|
| New leads | Leads created in the prior 24 hours; current lead state does not change the count. |
| Upcoming trials | `SCHEDULED` trial appointments beginning in the next 24 hours. |
| Upcoming testing | Draft/open/closed testing events beginning in the next 30 days. |
| Pending approvals | Non-expired Action Engine requests currently awaiting human approval. |
| Outstanding work | Current nonterminal durable work-item count. |
| Membership terms ending | Active/cancellation-pending memberships whose recorded term end falls in the next 30 days. |
| Paid invoices created | Current `PAID` invoice state for invoices created in the prior 30 days, grouped by currency. This is **not** cash revenue, collections, payment timing, or MRR. |

The deterministic daily briefing and ordered navigation recommendations are rebuilt from those allowlisted facts in API and browser code. Each recommendation gives a reason and opens an existing same-origin workflow; it never executes a mutation.

## Honest unavailable states

The first slice deliberately returns an explicit status—not zero or a guess—for:

- unanswered inquiries, because no approved response-state projection exists;
- attendance decline, because no approved longitudinal policy exists;
- trial conversion, because no authoritative trial-to-enrollment linkage exists;
- revenue, because a current paid-invoice state is not authoritative cash revenue or collection evidence.

A later School Health Score or retention implementation must add defined source semantics, data-sufficiency gates, and transparent formulas before changing any of these states.

## Presentation and preferences

`/staff/command-center` is authenticated, dynamic, no-index and uses the existing same-origin API boundary. Users may locally hide dashboard sections and individual recommendation cards, then restore them. Those preferences remain browser-local and cannot change tenant scope, permission, tier, recommendation calculation, action authority, or school data.

After the aggregate projection independently verifies the exact organization/school, the Command Center may read or save only the existing current-principal/current-school presentation preference. It uses a generated idempotency UUID and the closed `selectedVia: SETTINGS` value; it neither loads a preference before verification nor reuses a school preference in HQ or family/parent contexts. Big-Button / Phone, Modern HON and Classic CRM alter touch targets and density only. The fixed facts, formulas, local-only hide behavior, links, entitlement/permission checks and authority path remain shared. Scope entry, reload, access denial, preference failure and unmount invalidate stale presentation state.

## Explicit exclusions

This slice does **not**:

- invoke AI, providers, voice, Action Engine execution, or automation;
- send communications, publish marketing, charge or reconcile payments, alter memberships, create CRM records, or mutate work;
- return names, contacts, notes, raw invoices, payment methods, action payloads, work-item details, private evidence, provider data, or any directory/HQ data;
- claim that a zero count means an unavailable source is healthy.

## Verification

`pnpm db:test-command-center` verifies fixed function posture, trusted owner, exact runtime-only `EXECUTE`, no client/PUBLIC ACL, forged caller-GUC denial, preserved transaction context, and no audit/outbox/action/work/AI usage effects. API and browser tests additionally reject unknown/PII-shaped projection fields, scope/tier/identity denials, malformed windows, fabricated reasons, unexpected routes, and client-side execution imports.
