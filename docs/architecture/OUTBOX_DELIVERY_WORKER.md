# HON Durable Outbox Delivery Worker

## Boundary

`hon_runtime` remains append-only for `audit_events` and `outbox_events`. It cannot update, delete, or directly enumerate platform-wide outbox work. A future worker uses a separate `hon_outbox_worker` login, which is **not** a superuser, has **no** `BYPASSRLS`, does not inherit roles, and receives no direct table, sequence, schema-administration, migration, role, or database-management privileges.

The worker may only execute two fixed security-definer functions:

1. `hon.claim_outbox_delivery_batch(limit, leaseSeconds)` atomically claims up to 100 due `PENDING`/`FAILED` events with row locks and individual leases, inserts an attempt record, increments the attempt count, and returns the immutable event envelope.
2. `hon.record_outbox_delivery_result(eventId, leaseToken, outcome, failureDetails, retryAfterSeconds)` records a final result only for its current lease.

## Failure semantics

- `PUBLISHED` is the only success result.
- `RETRYABLE_FAILURE` returns the event to `FAILED` for a bounded delayed retry.
- `UNKNOWN` becomes `DEAD_LETTER` with `UNKNOWN_DELIVERY_OUTCOME` evidence; it is **not** retried automatically because a provider may have accepted the original event. An operator/approved reconciliation workflow must use the original event identifier before a later retry.
- An expired `PUBLISHING` lease is not automatically reclaimed. It represents an unknown delivery boundary and requires reconciliation rather than a potentially duplicate external effect.

The implementation preserves the original versioned event ID, aggregate version, correlation ID, causation ID, attempt history, and failure evidence. It runs only after the source command has committed, so no provider call can occur inside the authoritative business transaction.

## Supabase provisioning

Use [012_supabase_hon_outbox_worker.sql](../../infra/postgres/012_supabase_hon_outbox_worker.sql) after the migrations have completed. Construct a Session Pooler URI with the Supabase pooler host/port and the `hon_outbox_worker` username and generated base64url password. Store it only as `HON_OUTBOX_WORKER_DATABASE_URL`; do not reuse `DATABASE_URL` or `HON_RUNTIME_DATABASE_URL`.
