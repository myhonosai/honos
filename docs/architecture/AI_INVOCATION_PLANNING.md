# Durable AI Invocation Plans — Decision Only

## Delivered boundary

Migrations **0054–0056** add immutable, school-scoped **planning snapshots**, not AI execution. `AiInvocationPlanService.plan(context, workItemId, input)` is an **internal DI service**. No write, generic execute, provider, or prompt endpoint is exposed. It accepts only a direct server-derived `HUMAN_USER` / `HUMAN_UI` context with no delegator or Action Request ID.

The sole HTTP surface is:

`GET /v1/organizations/{organizationId}/schools/{schoolId}/ai/invocation-plans/{planId}`

It uses `HonIdentityGuard`, resolves the verified identity with the exact **`ai.invocation.plan`** permission, verifies the path matches the resolved organization/school, and repeats live permission/Complete checks inside the transaction. Missing or cross-school records are 404; an unauthorized path is 403. It returns only the sanitized snapshot, never HQ configuration or credential references.

The exact action-catalog entry is Complete-only, permission `ai.invocation.plan`, risk `MODERATE`, platform authority floor **`RESTRICTED`**. It is **not** a Tool Gateway adapter: no Action Engine proposal, approval, execution, tool registration or action mutation is introduced. Routing/fallback cannot change its authority floor, task risk, actor, agent definition or tenant scope.

## First planning slice

This deliberately supports **TEXT / TOKEN estimates only**. All eight static HON agent keys are presentation identifiers, not assigned AI principals or new authority. Eian's key confers no family access; this is a staff-human boundary, not a Parent App invocation API.

| Task class | Required durable `work_type` | Derived risk |
|---|---|---|
| `SUMMARIZE` | `AI_SUMMARIZE` | `LOW` |
| `ANALYZE` | `AI_ANALYZE` | `MODERATE` |

Only `READY` or `THINKING` items are eligible. The caller supplies the exact expected state and positive version. Sensitive, financial, publication, tool-execution, media, unknown task/work types and every other work state are rejected. **No work state, version, assignment, payload or result is changed by planning.**

`PlanAiInvocationInput` is a closed metadata object:

| Field | Constraint |
|---|---|
| `expectedVersion` | integer 1–2,147,483,646 |
| `expectedState` | `READY` or `THINKING` |
| `agentKey` | approved static HON team key |
| `modality` | `TEXT` |
| `taskClass` | `SUMMARIZE` or `ANALYZE` |
| `inputBudget` | upper-bound tokens, 1–128,000 |
| `outputBudget` | upper-bound tokens, 1–16,000 |
| `maxProviderCostMicrounits` | integer USD micro-units, 0–1,000,000 |

Both pure domain validation and SQL reject **unknown fields** rather than silently discarding them. There are no prompt/message/input-content/output-content/metadata fields, client tier/risk assertions, routing/model/provider overrides, tools/permissions/authority fields, credential references, endpoints or secret fields. Raw content is neither accepted nor included in the request hash. Identifiers and the planning idempotency key are UUIDs; a raw string cannot hide a prompt/secret in the key.

## Privilege and selection boundary

`hon_runtime` has **SELECT only** on `hon.ai_invocation_plans`; no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER. Forced RLS has one SELECT policy requiring both tenant IDs; missing context sees no rows. The table has no JSON/content/credential columns and a composite FK to the durable work item. Selected catalog/provider/model/policy IDs and versions are sanitized historical metadata, not live configuration relations. Status is constrained to **`PLANNED` only**. An immutability trigger also rejects UPDATE/DELETE, even by a privileged owner; rollback-only tests require no destructive cleanup of plans.

Runtime EXECUTE is granted only on two new fixed SECURITY DEFINER functions:

- `require_ai_invocation_plan_access()` checks transaction-local tenant context, active organization/school ownership, real active human principal, exact live school permission and active effective Complete entitlement. It enables the safe read without granting identity/config directory access.
- `plan_ai_invocation(workId, metadata, key, requestId, correlationId)` independently repeats that gate, explicitly scopes/locks the durable item, validates metadata, evaluates approved HQ routing/catalog state and atomically appends a successful plan with evidence/replay.

The invoker service first installs context through `withTenantTransaction`, checks live access, and locks the item under **forced RLS** without loading its content. The definer uses explicit organization/school predicates rather than relying on its privileged ownership to enforce tenant isolation. Both functions pin `search_path = pg_catalog, hon`; there is no dynamic SQL. Their reviewed migration owner uses the same privileged global-read posture as the existing HQ resolver; runtime receives neither membership nor BYPASSRLS. Internal validation/summary/trigger functions are not runtime/PUBLIC executable.

The planner reads approved HQ state internally but returns only **choice / no-choice**:

1. Require exactly one active, effective, same-school `TEXT` policy; absent/ambiguous policies fail closed. Tenants cannot nominate a policy or discover other-school configuration.
2. Evaluate registered candidates in HQ ordinal order. Catalog entries must be active/effective, TEXT-capable and TEXT-modal, with TOKEN billing. Complete satisfies every currently registered policy/catalog tier floor; no client tier assertion is used.
3. Select only **HEALTHY** connections. DISABLED, CONFIGURED, DEGRADED and UNAVAILABLE are excluded, **even when HQ preview permits degraded selection**. No health probe, credential dereferencing or provider reachability verification occurs; state remains HQ-attested.
4. Compute `unit_cost_micros × (inputBudget + outputBudget)` using numeric/integer arithmetic. Respect the smaller of caller maximum and HQ policy ceiling, plus the code-owned maximum. A healthy approved fallback must pass the same constraints; there is no fallback invocation.
5. Estimate customer credits as `ceil((inputBudget + outputBudget) / 1000)`. Reject when actual org-wide current UTC-month ledger usage plus this estimate exceeds Complete's 12,000 included credits. The response exposes neither other-school ledger detail nor remaining balance. This is a **planning estimate contract**, not final pricing or metering.

Every outcome states **`authority: UNCHANGED`** and **`execution: NOT_PERFORMED`**. A no-choice returns only `NO_ELIGIBLE_ROUTE` or `CUSTOMER_BUDGET_EXCEEDED` and `plan: null`, with no new persistence/evidence/charge. Failed choice attempts are not idempotency reservations: a later retry may reevaluate live state.

## Successful replay and atomic evidence

Successful plan/replay is scoped to organization, school, principal and UUID idempotency key. A server-side SHA-256 hash binds command, scope, durable item ID and the complete sanitized metadata object; JSON field ordering, request IDs and correlation IDs do not change it. Work payload/result, prompts and secrets are never hashed or copied. Changed metadata with the same key is 409. The durable item lock plus a transaction advisory lock and the existing unique idempotency record prevent duplicate committed effects.

A successful transaction writes **exactly one plan + audit + outbox + completed idempotency result**. The audit action is `ai.invocation.plan`, entity `AI_INVOCATION_PLAN`, source HUMAN_UI, result SUCCEEDED **for plan persistence only**. The named event is **`ai.invocation.planned`**, schema version 1, aggregate version 1. Evidence contains plan/work IDs, expected work version, request hash and estimates, explicitly `NOT_PERFORMED`/`UNCHANGED`—not HQ config, credential references or content. Evidence failure rolls everything back. No consumer/worker is activated or added for this event.

Migration 0056 hardens replay to reconstruct the response exclusively from the immutable same-school/work/hash plan and its original human-actor audit, rather than echoing arbitrary JSON from the existing general-purpose runtime-writable idempotency table. Corrupt/mismatched replay bindings fail closed.

A matching successful replay revalidates current permission/Complete entitlement and locks the same scoped durable item, but returns the historical snapshot without requiring the work's current version/state or current provider health to remain unchanged. It appends no new evidence. **Replay is never authorization to execute a stale plan.** Fresh keys must pass the current version/state and live selection checks. Independent fresh plans are not balance reservations and may collectively exceed a future execution budget.

## Explicit non-capabilities / next dependency

No SDK, provider HTTP, new environment key/secret, credential resolution, model/media call, worker, outbox consumer, automatic retry, tool invocation, ledger write, credit consumption/reservation, billing mutation, Action Engine mutation, work transition to Working, generated output, or provider-success claim is added.

Future execution requires a separately reviewed boundary: revalidate current scope/permission/entitlement/risk/policy/catalog/health; establish authoritative pricing and budget reservation; resolve credentials out of band; register code-owned adapters; apply Action Engine/tool/approval authority independently; meter actual costs/credits; handle UNKNOWN/reconciliation/circuits; and only then introduce execution workers/media custody. Conventional HON remains independent of AI availability.

## Deployment and verification

Apply migrations with the protected migration connection: `pnpm db:migrate`. Do not edit previously applied migrations or grant runtime direct HQ tables to make selection work. The canonical [Supabase grants](../../infra/postgres/010_supabase_hon_runtime.sql), [SQL verifier](../../infra/postgres/011_verify_supabase_hon_runtime.sql) and automated RLS verifier include exact plan SELECT/function grants and forbidden HQ/config/helper access.

Run `pnpm check`, `pnpm test`, `pnpm build`, `pnpm db:check`, `pnpm db:verify-rls`, **`pnpm db:test-ai-plans`**, and the existing database validation suite. Domain tests cover strict metadata and exact action/tier authority. The dedicated PostgreSQL test exercises compiled service/read controller, real runtime-role RLS and definer calls, cross-school/org denial, prompt/secret injection, health/catalog/policy/budget no-choice/fallback, expected state/version, immutable records, deterministic successful replay, live revocation, evidence rollback and zero execution effects. Provider fixtures and all generated evidence are kept inside a **rolled-back transaction**, never committed as live configuration.
