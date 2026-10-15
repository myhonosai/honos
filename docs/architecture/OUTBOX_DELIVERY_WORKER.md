# HON Durable Outbox Delivery Worker

## Boundary

`hon_runtime` remains append-only for `audit_events` and `outbox_events`. It cannot update, delete, or directly enumerate platform-wide outbox work. A future worker uses a separate `hon_outbox_worker` login, which is **not** a superuser, has **no** `BYPASSRLS`, does not inherit roles, and receives no direct table, sequence, schema-administration, migration, role, or database-management privileges.

The worker may only execute three fixed security-definer functions:

1. `hon.claim_outbox_delivery_batch(limit, leaseSeconds)` first reconciles expired leases to `UNKNOWN`/`DEAD_LETTER`, then atomically claims only due `PENDING`/`FAILED` events with row locks and individual leases.
2. `hon.reconcile_expired_outbox_leases(limit)` lets a worker or operator-side worker sweep stale leases without re-delivering them.
3. `hon.record_outbox_delivery_result_v2(eventId, leaseToken, outcome, failureDetails, retryAfterSeconds)` returns `{status, accepted}`. The worker must treat `accepted: false` as an unknown/reconciliation condition, never as success.

## Failure semantics

- `PUBLISHED` is the only success result, and it is accepted only before the current lease expires.
- `RETRYABLE_FAILURE` returns the event to `FAILED` for a bounded delayed retry only while the lease is current.
- `UNKNOWN`, a crash-expired lease, or a late worker completion becomes `DEAD_LETTER` with `UNKNOWN_DELIVERY_OUTCOME` evidence. It is **not** retried automatically because a provider may have accepted the original event. An operator/approved reconciliation workflow must use the original event identifier before a later retry.
- A stale worker’s `PUBLISHED` report returns `DEAD_LETTER` and `accepted: false`; it cannot turn a delivery that crossed an unknown boundary into success.

The implementation preserves the original versioned event ID, aggregate version, correlation ID, causation ID, attempt history, and failure evidence. It runs only after the source command has committed, so no provider call can occur inside the authoritative business transaction.

## Supabase provisioning

Use [012_supabase_hon_outbox_worker.sql](../../infra/postgres/012_supabase_hon_outbox_worker.sql) after migration `0029` is applied. Construct a Session Pooler URI with the Supabase pooler host/port and the `hon_outbox_worker` username and generated base64url password. Store it only as `HON_OUTBOX_WORKER_DATABASE_URL`; do not reuse `DATABASE_URL` or `HON_RUNTIME_DATABASE_URL`.
