# Human promotion-decision workbench

## Delivered boundary

`/staff/testing/promotion-decisions` is a **dynamic, noindex/nofollow direct-human staff page** beneath the existing verified-session `/staff` layout. It starts **blank and idle** with only already-known organization, school and testing-candidate UUIDs; a positive expected candidate version; a final `PROMOTED`, `DEFERRED` or `NOT_PROMOTED` status; and a required, trimmed rationale of at most 2000 characters. It has no query prefill, saved state, automatic I/O, candidate/rank/enrollment/staff/family directory, list/search/read, readiness calculation or scorecard action.

All selectors and the entered expected version establish syntax only. They are not authority, verified current facts or a client-side concurrency check. The existing API remains the authority for direct-human identity, live `testing.promotion.decide` scope, RLS tenant scope, terminal candidate, current enrollment, target rank, prerequisites and idempotency.

The page uses only the existing canonical candidate decision route:

```text
POST /api/v1/organizations/:organizationId/schools/:schoolId/testing/candidates/:candidateId/promotion-decision
```

The canonical `DecidePromotionInput`, API DTO and promotion-decision service accept this exact expected-version field. No migration, permission, grant, RLS policy, Action Engine adapter, consumer or executor was changed.

## Final human decision, not automation

> **PROMOTED is an explicit final human instructor decision — never an AI, scorecard or automatic action.**

The browser submits no rank selector or rank-change command. After the canonical server has independently validated the candidate and its dependencies, only the existing server `PROMOTED` decision can perform its existing canonical enrollment rank update. `DEFERRED` and `NOT_PROMOTED` do not create an alternate workflow.

This workbench does **not** issue external certificates, send parent notices/messages, create parent/family access, record attendance, alter billing/payment, invoke a provider, AI, Action Engine or automation, or activate an effect/outbox consumer. It does not create testing outcomes, certificate delivery, readiness/grade computations, roster/capacity placement or any downstream command.

## Exact confirmation and bounded transport

The form requires a separately checked confirmation for the exact UUIDs, expected version, status and rationale. Any edit clears confirmation, receipt and retry. Only the valid confirmed handler allocates one `crypto.randomUUID()` v4 idempotency key. Render/effects, validation, preparation and retry do not allocate keys.

The closed browser body contains exactly:

```json
{
  "expectedVersion": 3,
  "status": "PROMOTED",
  "rationale": "The instructor's final rationale"
}
```

Organization, school and candidate UUIDs occur only in the exact relative path. There are no actor/source, authority, delegation, action request, rank, enrollment, certificate, parent, payment or automation fields. The adapter freezes and revalidates the complete prepared path/body/key before I/O.

Its only request is a relative `POST` with `credentials: "same-origin"`, `mode: "same-origin"`, `cache: "no-store"`, `redirect: "error"`, `referrerPolicy: "no-referrer"`, JSON Accept/Content-Type, `Idempotency-Key`, and the required `X-HON-Human-Command: testing` guard marker. There is no generic client, extra header, navigation, browser persistence, polling, read endpoint, auto-action or automatic retry.

## Closed receipt and uncertainty

The adapter accepts only nonredirect JSON at most 20,000 characters with exact `{data,meta}` and `{requestId,correlationId,replayed}` shapes. A first canonical decision is `201` with `replayed: false`; an idempotent replay is `200` with `replayed: true`. It verifies response IDs, status, exactly matching rationale, RFC3339 timestamps and the immutable inserted decision version `1`; malformed, mismatched, private/unexpected or nonmonotonic receipt data never renders partial or optimistic success.

The canonical wire summary currently contains `instructorPrincipalId` and rationale. The strict wire parser verifies both necessary matching fields but the public receipt projection strips them: it renders only decision/candidate/enrollment/optional prior-rank/target-rank IDs, status, version and timestamps. It never renders actor, rationale, authority, audit or outbox data.

Only network/redirect/unverifiable response failures and the exact closed `409 IDEMPOTENCY_IN_PROGRESS` response retain the one frozen in-memory command for a separately pressed **Retry exact unchanged promotion decision** action. A retry sends identical path/body/key and does not allocate another key. Definite rejection retains nothing. `401/403`, including a retry, clears every ID, version, decision, rationale, confirmation, receipt and retry. Editing, discarding or reload also clears retained retry state; none is cancellation.

## Verified canonical expected-version boundary

`DecidePromotionInput` and `DecidePromotionDto` both require `expectedVersion`. The DTO applies strict positive-integer validation and the existing global `ValidationPipe` continues to reject omitted, invalid and extra JSON fields. Service normalization independently requires a safe positive whole number, then binds `candidateId`, `expectedVersion`, normalized status and normalized rationale into the idempotency fingerprint. No client-supplied actor, authority, source, scope, enrollment or rank is accepted.

Inside the already tenant-bound, direct-human transaction, the service locks and loads the candidate, then compares its live version with `expectedVersion` **before** enrollment/rank reads, decision lookup, idempotency reservation, promotion, audit or outbox writes. A mismatch returns `409 { code: "VERSION_CONFLICT" }` and rolls back with no such dependent mutation. A matching command retains the canonical terminal-result/coherency checks, enrollment lock and conditional `PROMOTED` rank update, insert-only decision, audit, inert outbox and completed idempotency snapshot.

A matching exact retry is still replayed as the immutable `200` decision snapshot while the candidate remains at the same expected version. Changing expected version changes the fingerprint and cannot reuse that idempotency key; if the candidate is already stale, the version denial occurs before any idempotency mutation. The browser-entered value remains an untrusted concurrency precondition, never a grant of authority or proof of current state.

## Validation evidence and scope

| Validation | Actual result |
| --- | --- |
| Focused promotion-decision Nest HTTP/service edge suite | **4 tests passed**: required/invalid/extra body validation, version-bound fingerprint/replay, stale pre-write denial and direct-human source boundary |
| Browser workbench regression, including promotion-decision HTTP/route/UI tests | **102 files / 547 tests passed** |
| `@hon/api` check and build | Passed |
| Full `@hon/api` test | **368 tests passed** |
| Root `pnpm test`, `pnpm check`, and `pnpm build` | Passed |
| Final `git diff --check` plus untracked focused-test whitespace audit | Passed |

Tests use local mocks only. They are not a signed-browser mutation, live PostgreSQL/RLS, remote provider/payment or deployment proof. No remote database/provider/payment call, migration application, deploy, commit or push is part of this implementation.
