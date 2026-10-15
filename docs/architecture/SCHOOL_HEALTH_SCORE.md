# Deterministic School Health Score

## Purpose

The School Health Score is an **optional, conventional, read-only operational indicator** for one selected school. It extends the deterministic [School Command Center](SCHOOL_COMMAND_CENTER.md); it does not replace normal CRM, attendance, renewal, Action Engine approval, workbench, reporting, or billing workflows.

It works when all AI and external providers are unavailable. It makes **no prediction**, makes no churn or cancellation certainty claim, reports no cash revenue, and never recommends or authorizes a consequential change.

> **Operational indicator only.** A displayed value is not a forecast, cancellation/churn certainty, cash-revenue measure, or recommendation for consequential changes.

## Authority and scope

`GET /v1/organizations/:organizationId/schools/:schoolId/health-score` accepts only known organization and school UUIDs as selectors. The fixed `hon.read_school_health_score(text, uuid, uuid)` SQL projection independently verifies:

1. exactly one active direct `HUMAN_USER` for the verified application subject;
2. the selected active organization and school;
3. an effective direct school-level `reporting.view` grant; and
4. one active Essential, Core, or Complete entitlement.

The `STABLE SECURITY DEFINER` projection has the fixed `pg_catalog, hon` search path, is owned by a trusted migration owner, revokes `PUBLIC` execution, and grants only `EXECUTE` to `hon_runtime`. It does not read caller identity/scope GUCs, create a new runtime table grant, or reuse HQ or parent/family access.

## Formula version and weights

The first fixed formula is **`SCHOOL_HEALTH_SCORE_V1`**. Each available category has a clamped integer subscore in `[0, 100]`. The overall score exists **only if every category is sufficient**:

```text
overall = round(
  attendanceEngagement × 35% +
  pipelineTrial × 25% +
  retention × 25% +
  operations × 15%
)
```

| Category | Weight | UTC half-open window | Sufficient sample | Fixed subscore semantics |
|---|---:|---|---|---|
| Attendance engagement | 35% | `[generatedAt − 28 days, generatedAt)` | At least 4 completed class sessions and 20 recorded observations linked to those sessions | `round(100 × (PRESENT + LATE + MAKEUP observations) / recorded observations)` |
| Pipeline / trial recording | 25% | `[generatedAt − 56 days, generatedAt)` | At least 5 CRM leads created and 3 trial appointments started | `round(100 × terminal trial outcomes recorded / trial appointments)`; terminal means `COMPLETED`, `NO_SHOW`, or `CANCELLED` |
| Term / renewal observability | 25% | `[generatedAt − 90 days, generatedAt)` | At least 5 meaningful membership terms ended and 3 human renewal reviews recorded | `min(100, round(100 × renewal reviews recorded / membership terms ended))` |
| Operations workload | 15% | `[generatedAt − 28 days, generatedAt)` | At least one current pending approval or nonterminal work item created in the window | `max(0, 100 − 10 × pending approvals − 5 × outstanding work items)` |

All timestamps use a single projection `generatedAt` rounded to milliseconds and all source filters use explicit UTC half-open ranges. A score is never persisted, derived store-side, or supplied by a model.

## Source semantics and evidence

Only aggregate counts return. The API validates the exact schema, fixed formula version/weights/windows, sample gates, reason codes, category scores, and weighted overall composition; it does not trust arbitrary SQL display text.

| Category | Aggregate-only sources | Returned evidence |
|---|---|---|
| Attendance engagement | `class_sessions` with `COMPLETED` status joined to `attendance_records` | completed-session, recorded-observation, and engaged-observation counts |
| Pipeline / trial recording | `crm_leads` created in-window and `crm_appointments` of type `TRIAL` started in-window | lead, trial-appointment, and terminal-outcome-recorded counts |
| Term / renewal observability | meaningful ended `memberships` and `membership_renewal_reviews` created in-window | term-ended and review-recorded counts |
| Operations workload | current `AWAITING_APPROVAL` `action_requests` and current nonterminal `work_items`, both created in-window | pending-approval and outstanding-work counts |

The score returns no names, contacts, notes, raw invoices, payment data, action payloads, work detail, private evidence, provider/model data, directory IDs, or free text from rows.

## Insufficient data

A category that lacks its defined source sample is `INSUFFICIENT_DATA` with fixed code-owned reasons. It has **no category score**. If any category is insufficient, `overall.status` is `INSUFFICIENT_DATA`, `overall.score` is omitted, and structured category reasons are returned. The UI explains these states rather than fabricating zero, health, or risk claims.

| Reason code | Meaning |
|---|---|
| `MIN_COMPLETED_SESSIONS` | Fewer than 4 completed sessions in the attendance window |
| `MIN_RECORDED_ATTENDANCE_OBSERVATIONS` | Fewer than 20 observations linked to completed sessions |
| `MIN_RECENT_LEADS` | Fewer than 5 recent CRM leads |
| `MIN_RECENT_TRIAL_APPOINTMENTS` | Fewer than 3 recent trial appointments |
| `MIN_MEMBERSHIP_TERMS_ENDED` | Fewer than 5 meaningful membership terms ended |
| `MIN_RENEWAL_REVIEWS_RECORDED` | Fewer than 3 human renewal reviews recorded |
| `NO_RECENT_OPERATIONS_WORKLOAD_SAMPLE` | No current pending approval or nonterminal work item was created in the operations window |

## UI and presentation constraints

`/staff/health-score` is authenticated, dynamic, no-index, and uses one conventional same-origin `GET` route. It has clear empty, scope, access, error, sufficient, and insufficient-data states. It shows formula/version/weights/evidence and plain-language source limitations. Safe display panels may be hidden/restored in browser-local storage only; preferences cannot affect data, scope, authorization, tier, score, or authority.

The existing Big-Button, Modern, and Classic modes are presentation-only constraints. This slice creates no new mode, tier, or authority path.

## Explicit non-goals

This slice does **not**:

- predict enrollment, retention, churn, cancellation, conversion, financial outcomes, or school performance;
- characterize a terminal trial status as conversion, enrollment, satisfaction, or lead quality;
- characterize a membership term or renewal review as retained, renewed, cancelled, or at risk;
- treat invoices or payment state as cash revenue, collection, MRR, or settlement;
- create, update, approve, assign, execute, or queue any CRM, attendance, membership, billing, Action Engine, work, audit, outbox, or provider state;
- invoke AI, a provider, automation, or an Action Engine tool; or
- expose raw operational records, PII, action/work payloads, payment data, private evidence, provider/model data, directory data, or row text.

## Verification

`pnpm db:test-health-score` verifies function posture, trusted owner, exact runtime-only execution, no client execution, forged-GUC denial, preserved context, and zero audit/outbox/action/work/AI effects against real runtime credentials. Focused API and browser tests prove guard/selector behavior, output allowlisting, deterministic formula/window/reason validation, inaccessible identity/scope/tier failures, insufficient-data behavior, and no POST/mutation/action/provider imports.
