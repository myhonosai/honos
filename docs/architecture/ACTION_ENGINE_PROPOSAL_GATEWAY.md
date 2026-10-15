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

The next dependency is a registered ordinary-domain-service executor for each supported action. That executor must reload and revalidate the approved request immediately before execution. A separate reviewed worker capability will handle post-commit outbox publication; the tenant request role has append-only access to event evidence.
