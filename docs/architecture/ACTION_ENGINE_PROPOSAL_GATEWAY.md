# HON Typed Action Engine Proposal Gateway

## Current server-side boundary

`ActionEngineService.propose()` is the only new entry point for creating a durable Action Engine proposal. It is an internal **typed tool gateway**, not a generic public mutation endpoint and not a provider executor.

A caller must first resolve the authenticated principal against the **exact permission declared by the registered action**. The gateway then:

1. Rejects an unregistered action code.
2. Resolves the active organization entitlement and action-specific tier floor through the registered action catalog.
3. Loads the effective school policy version from the tenant-scoped database transaction.
4. Selects the most restrictive authority from platform floor and school policy.
5. Rejects `RESTRICTED` actions rather than queuing them.
6. Canonicalizes and hashes the already action-specific validated payload.
7. Atomically writes the action request, append-only audit event, and transactional outbox event.
8. Uses an idempotency key bound to organization, school, requestor, action code, and payload hash.
9. Marks `CONFIRM` proposals `AWAITING_APPROVAL` with a 30-minute expiry; `AUTO` proposals are `APPROVED` but **not automatically executed** until a registered ordinary-domain-service executor exists.

## Explicit non-capabilities

The proposal gateway cannot execute raw SQL, call arbitrary internal URLs, access provider secrets, invent authority, weaken platform floors, or invoke an unregistered action. It does not execute an external provider or normal domain command. That separation prevents a proposal from being misrepresented as a completed operation.

## Approval boundary

`ActionEngineService.decide()` now reloads the stored tenant-scoped action request under lock, binds the original requestor, qualified reviewer, payload hash, active policy version, and expiry, rejects self-approval, records an append-only decision/audit/outbox event, and changes only the durable request state to `APPROVED` or `DENIED`. It does **not** execute the action.

The conventional human-review route is intentionally narrow: `GET /v1/organizations/{organizationId}/schools/{schoolId}/action-requests/{actionRequestId}` returns the exact stored proposal only to a user with `action.approve` in that school, and `POST .../decision` accepts only `APPROVED` or `DENIED`. It is not a generic action-creation API. The reviewer sees the normalized payload, payload hash, authority mode, policy version, expiry, and requestor before deciding.

An executor may begin only through the internal `beginExecution()` boundary. It locks the exact `APPROVED` proposal and revalidates the registered action, active entitlement, current policy/version, authority mode, permission binding, and confirmation expiry before changing state to `EXECUTING`. A matching typed ordinary-domain-service adapter then executes the normal command and records `SUCCEEDED`, `FAILED`, or `UNKNOWN` through `recordExecutionOutcome()`, with separate append-only audit/outbox evidence. `UNKNOWN` is terminal until reconciliation, never success or an implicit retry.

Human review is itself consequential. `POST .../decision` requires an `Idempotency-Key`; its decision fingerprint binds action request ID, decision, and reason. The Action Engine atomically reserves/replays the reviewer-scoped result with the approval row, action state, audit event, and outbox event. Immediately before accepting the decision and immediately before execution, the fixed `principal_has_school_permission` resolver checks the live active role grant inside the transaction. A revoked requestor or reviewer permission therefore fails closed even if the proposal was valid earlier.

`CrmLeadActionTool` is the first internal typed adapter. It validates a model-produced CRM lead payload against the same `CreateLeadDto` contract used by the conventional API; creates a governed `crm.lead.create` proposal; waits when Confirm policy applies; otherwise enters the execution boundary; invokes the normal `LeadService.create()` command with the Action Request ID; and records a verified lead result. There is intentionally no public generic Action Engine “execute this payload” endpoint.

The next dependency is a registered ordinary-domain-service executor for each supported action. A separate reviewed worker capability will handle post-commit outbox publication; the tenant request role has append-only access to event evidence.

## Invocation planning is not an executable action

The exact `ai.invocation.plan` catalog metadata is Complete-only and `RESTRICTED`; both human and AI proposal-gateway calls are rejected before an Action Request is written, even if school/agent/dynamic-risk settings ask for AUTO. The dedicated internal human-UI metadata planner is not an Action Engine caller or registered tool adapter. Its `PLANNED` record, successful persistence audit and `ai.invocation.planned` outbox event confer no provider/tool/approval authority. See [AI Invocation Planning](AI_INVOCATION_PLANNING.md).
