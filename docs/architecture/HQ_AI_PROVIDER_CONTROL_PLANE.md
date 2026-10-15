# HON HQ AI Provider Control Plane

## Scope and non-goals

This foundation registers **configuration only** for the reviewed future providers **OPENROUTER**, **DIRECT_LLM_API**, **HEYGEN**, and **HIGGSFIELD**. It adds no SDK, provider key/environment variable, HTTP client, provider health probe, LLM invocation, media generation, execution worker, or secret-store integration. Endpoints will belong to reviewed code-owned adapters; neither HQ nor schools can configure a base URL.

The catalog is approval metadata, not a claim that a named model exists or is reachable. HQ explicitly attests connection state; `CONFIGURED` is not treated as `HEALTHY`. Nothing is seeded as a live provider/model. No test fixture is retained.

## Ownership and immutable migrations

New additive migrations `0052` and `0053` leave prior migrations unchanged. Every new `hon.hq_ai_*` table enables and **forces RLS**, with **no RLS policy** and no PUBLIC/runtime table privilege:

- `hq_ai_provider_connections`: closed provider IDs, non-secret display name, connection state, opaque reference, version.
- `hq_ai_model_catalog`: approved catalog UUID, stable provider/model identity and billable unit, capabilities, modalities, integer USD micro-unit price, minimum tier, activation and effective window.
- `hq_ai_routing_policies` / `hq_ai_routing_candidates`: composite organization/school ownership, capability, minimum tier, ceiling, explicit degraded allowance, and up to eight unique FK-constrained catalog IDs in ordinal order.
- `hq_ai_control_requests`, `hq_ai_control_audit`, `hq_ai_control_outbox`: idempotency results and append-only HQ evidence. No update/delete API or delivery worker exists for evidence.

Ordinary runtime cannot SELECT, INSERT, UPDATE, DELETE, TRUNCATE, reference, or trigger these tables. Setting tenant/HQ GUCs cannot confer HQ access. The only runtime grants are EXECUTE on three fixed functions: `hq_ai_control_plane_read`, `hq_ai_control_plane_write`, and `hq_ai_routing_registry`. Internal validation/projection helpers are INVOKER, not runtime/PUBLIC executable.

These fixed SECURITY DEFINER functions have `search_path = pg_catalog, hon`, use no dynamic SQL, and re-resolve the active verified **HUMAN_USER** against HQ grants on every call. The reviewed privileged migration owner must have the same forced-RLS global-identity read posture as the existing HQ resolver; migration `0053` fails closed otherwise. This privilege is **never** given to `hon_runtime`. A future dedicated HQ function owner must be reviewed and provisioned independently; do not weaken RLS to make a migration run.

A school OWNER (even with every school permission), AI employee, expired/inactive HQ principal, or caller-submitted authority cannot use this boundary. The current registry resolver is **HQ-only preview**; no school config endpoint or tenant-accessible config projection is introduced. Future school execution must consume only the HQ-approved policy for its verified school and return a redacted decision through a separately reviewed resolver—not gain HQ table/config access.

## Credential handling

Only `credentialSecretRef: null` or `hon-secret:<lowercase UUID v4>` is accepted. This is an opaque identifier convention, **not** a secret, vault path, URL, environment variable, or dereference capability. Non-disabled connections require a reference. The API and SQL boundary both reject unknown fields, raw key/token/password/JWT-shaped references, recognizable secret-shaped labels/model IDs, arbitrary providers/URLs, duplicate IDs/capabilities, invalid integers, and invalid effective windows.

Narrow field grammars plus secret-shaped-value checks are defense in depth, not universal DLP. Do not paste credentials anywhere in configuration. A future secret store must be provisioned out of band; this foundation never reads, resolves, or validates the contents of a reference.

Read snapshots omit the reference **even for HQ** and expose only `credentialConfigured`. Audit snapshots remove references; the idempotency table stores a server-generated SHA-256 fingerprint and minimal response, not request bodies. Outbox payload contains only kind, record ID, and version. Global HQ evidence is deliberately separate from school-readable operational audit/outbox.

## API

All routes use the existing `HonIdentityGuard` and live HQ scope resolution, with authorization repeated inside the database boundary:

| Method and route | HQ permission | Semantics |
|---|---|---|
| `GET /v1/hq/ai-providers/configuration` | `hq.ai.providers.read` | Redacted provider/catalog/policy snapshot |
| `POST /v1/hq/ai-providers/connections` | `hq.ai.providers.manage` | Full validated provider record |
| `POST /v1/hq/ai-providers/catalog` | `hq.ai.providers.manage` | Full validated catalog record |
| `POST /v1/hq/ai-providers/routing-policies` | `hq.ai.providers.manage` | Full validated tenant routing policy |
| `POST /v1/hq/ai-providers/route-preview` | `hq.ai.providers.read` | Read-only validation and deterministic selection |

Owners inherit HQ permissions through the existing HQ resolver; operators need the explicit HQ codes. No school permission grants these codes. Write bodies are the shared `Ai*Write` contracts and require an `Idempotency-Key` UUID header and `expectedVersion` (`0` to create). Mutation returns `{recordId, version, replayed}`. Replays authenticate again and append nothing; reuse with changed input or a stale version returns 409. Validated mutations, redacted audit, named outbox event, and idempotency result are one atomic database operation. Low-volume HQ writes use one transaction advisory lock to prevent approval-check races across connections.

Catalog provider/model ID and cost unit are immutable after approval; register a new UUID to change identity/unit. Policy tenant scope and capability are immutable; register a new policy to change them. Catalog/policy deactivation and future/expired effective windows are selectable state, not deletion. Connection states are DISABLED, CONFIGURED, HEALTHY, DEGRADED, UNAVAILABLE. Provider status changes do not enqueue execution.

## Deterministic router contract

`decideAiRoute(request, registry)` is a pure function with no I/O. `HqAiProviderService.preview` loads the **registered policy and live organization entitlement** from the HQ-only database resolver; the body cannot supply tier, provider/model/fallback configuration, credentials, tools, permissions, or Action Engine authority.

- Verify exact input/registry shapes, closed enums, unique registered IDs, same organization/school, active policy, and effective window (`from <= asOf < until`).
- Enforce active live entitlement and **both** policy and catalog minimum tier.
- Iterate only the policy's registered catalog IDs in its exact order. Skip inactive/future/expired entries, wrong capability/modality/billable unit, disabled/configured/unavailable connections, absent configured references, and degraded connections unless explicitly allowed.
- Calculate `unitCostMicros × estimatedUnits` with integer arithmetic; use the smaller of request budget and HQ policy ceiling. Candidates with a greater cost are excluded. Budget is a per-decision ceiling, **not** a reserved balance or customer credit charge. Future metering/reservation/reconciliation is separate.
- Return chosen catalog/provider/model IDs, estimated cost/unit, health, policy version, chosen reason, effective budget, and eligible fallback candidates in order. Denial never invents a provider or discovers a different policy.
- Every outcome states **`authority: UNCHANGED`** and **`execution: NOT_PERFORMED`**. `TOOL_EXECUTION` is only a model capability descriptor, never a tool grant. Fallback obeys the identical scope/capability/modality/tier/budget checks and cannot bypass the Tool Gateway or Action Engine.

A selection is a snapshot decision, not a durable execution authorization: future execution must revalidate current policy/catalog/health, reserve actual economics, and independently enforce live permissions, authority, approval, and scope before any provider/tool call. There is no automatic retry or fallback invocation here.

## Verification

- `pnpm test`: shared/domain/web suite, including strict field/secret rejection and pure router tests.
- `pnpm db:test-ai-providers`: compiled controller/service plus real PostgreSQL runtime-role execution, forced RLS/no grants, human HQ gates, SQL validation, idempotency/versioning/evidence, health/tier/budget/fallback invariants and no network/provider effects.
- `pnpm db:verify-rls`: all HQ tables included in mandatory posture verification.

Integration fixtures, provider updates, and evidence are isolated in a **rolled-back transaction**. Managed migration owners may need a transaction-only membership *to the administrator* to SET ROLE hon_runtime; this gives runtime no extra privileges and is rolled back. Test administration requires that grant capability. No existing provider configuration is committed or overwritten by tests.

## Deferred activation work

Reviewed secret-store custody/rotation, code-owned endpoint adapters, observed health/error classification, provider/model capability verification, tenant decision-only authorization resolver, budget reservation/customer-credit accounting, safe execution/revalidation/UNKNOWN handling, retry/circuit policy, media delivery/storage, and execution workers remain unimplemented. Conventional HON remains independent of provider availability.
