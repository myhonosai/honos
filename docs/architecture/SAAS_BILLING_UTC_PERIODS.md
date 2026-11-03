# SaaS billing periods are UTC calendar months (Issue #100, migration 0201)

**Status:** source change, draft PR. Not deployed. No live billing, payment or entitlement change.
**Provisional migration number:** 0201 (numbers after 0192 are provisional until the owner approves merge order; 0193–0200 are used by the open S4 chain and #122).

## Problem (verified)

Six HON SaaS billing functions add calendar months to `timestamptz` values. PostgreSQL does that arithmetic in the **session** `TimeZone`, so the same anchor gave different period boundaries on different connections:

| Anchor (UTC) | Months | UTC session | `America/New_York` session |
|---|---:|---|---|
| 2026-10-31T23:59:59.999Z | +1 | 2026-11-30T23:59:59.999Z | 2026-12-01T00:59:59.999Z (DST end inside the month) |
| 2026-01-31T02:00:00.000Z | +1 | 2026-02-28T02:00:00.000Z | 2026-03-01T02:00:00.000Z (local month-end clamping is a different day) |
| 2026-01-31T02:00:00.000Z | +2 | 2026-03-31T02:00:00.000Z | 2026-03-31T01:00:00.000Z (DST start inside the period) |

The API pool (`apps/api/src/foundation/runtime-pool-options.ts`) never pins `TimeZone`. A session therefore inherits the server, database or role default, a pooler's startup options, `PGOPTIONS`, or any session-level `SET TimeZone` left on a reused pooled connection. CI and the default Supabase posture use UTC, which is why existing proofs passed. Production could not be inspected from this environment; the risk is that any non-UTC default or leaked setting silently shifts billing periods.

Affected functions (latest definitions):

| Function | Defined in | Arithmetic |
|---|---|---|
| `command_saas_subscription` | 0154 | `START_SERVICE` `at + interval '1 month'`; `ADVANCE_PERIOD` `anchor + make_interval(months => n)` |
| `create_saas_invoice_draft` | 0155 | invoice service period from the anchor |
| `saas_provider_invoice` | 0182 | provider invoice period from the anchor (monthly and annual) |
| `saas_apply_renewal` | 0182 | renewal period match and advance |
| `saas_activate_checkout_core` | 0172 | first period end on activation |
| `saas_activate_hon_os_checkout_core` | 0182 | first period end on activation (monthly and annual) |

Already UTC-explicit and unchanged: `saas_allowance_period` (0156), `read_saas_organization_credits_from_hq` (0156), the AI usage month windows and the Champions leaderboard months.

## Approved semantics

A billing period is the **original anchor plus whole UTC calendar months** (12 for annual), clamped to the last day of a shorter month, keeping the anchor's UTC time of day. Offsets always apply to the original anchor, never to an already-clamped period end, so a 31st anchor returns to the 31st after February. This is what UTC sessions, CI and the 0156 allowance periods already did.

## Correction

`0201_saas_billing_utc_calendar_periods.sql` is forward-only and configuration-only: `ALTER FUNCTION … SET TimeZone = 'UTC'` on the six functions. No function body, grant, table or row changes, and no historical migration is edited. PostgreSQL applies the setting on function entry and restores the caller's setting on exit, so:

- the result no longer depends on the session, database, role or pooler time zone;
- the caller's session, including a reused pooled connection, keeps its own setting;
- nested calls (renewal inside webhook ingestion) also run in UTC.

`saas-billing-security.mjs` (run by `verify-rls` and the commercial proofs) now requires exactly `search_path` plus `TimeZone=UTC` on those six functions, and fails if any other SaaS function adds calendar months without the pin (a later `CREATE OR REPLACE` resets function settings, so this catches a silent regression).

## Evidence

`packages/database/scripts/test-saas-billing-utc-periods-integrity.mjs` (in `run-db-proofs.sh`; `pnpm --filter @hon/database db:test-saas-billing-utc-periods`), through the real `RuntimeDatabaseService` and `SaasBillingService` on the disposable Champions fixture:

1. 0201 contains only the six `SET TimeZone` statements; all six are pinned; the security verifier passes.
2. `START_SERVICE` through a fresh pool whose **database default** is a POSIX zone with a DST change inside the coming month: period end is exactly UTC + 1 month.
3. **Production issue reproduced**: with the pin removed from `command_saas_subscription` (disposable DB only), an `ADVANCE_PERIOD` in an `America/New_York` session produces `2026-03-01T02:00Z`–`2026-03-31T01:00Z` instead of `2026-02-28T02:00Z`–`2026-03-31T02:00Z`; the security verifier refuses the unpinned function. After restoring the pin the same call is UTC-correct.
4. ~100 `ADVANCE_PERIOD` commands on four anchors (`2024-01-31T23:59:59.999Z`, leap day `2024-02-29T12:00Z`, US DST day `2025-03-09T07:30Z`, EU DST day `2025-10-26T00:30Z`) up to today, each in a different zone (UTC, New York, Kiritimati +14, Sydney, Los Angeles, Kolkata +5:30, Pago Pago −11, London, St John's −3:30, Lord Howe 30-minute DST, Chatham +12:45), all on **one reused pooled backend** whose leaked session zone is left untouched after every call. Periods and immutable history equal UTC month arithmetic.
5. Six B2 invoice drafts (periods 0, 1, 12, 13, 24, 25) in different zones: service periods and the printed description dates are UTC-correct.
6. Exact request/audit/outbox evidence, nothing billed, no payment evidence or credit allowance, no rows outside the fixture organizations.

The webhook-only functions (`saas_provider_invoice`, `saas_apply_renewal`, both activation cores) are covered by the pin, the verifier and the existing B5/0182/0183/0184 proofs; they have no dedicated month-end webhook scenario in this proof.

## Existing data and deployment

Rows written by a non-UTC session before 0201 keep their stored values (0201 never rewrites history). The next `ADVANCE_PERIOD` or renewal recomputes from the original anchor in UTC. Before deploying, an operator should run this **read-only** query against production and review any rows it returns with the owner before the next period advance (the proof runs the same query):

```sql
SELECT s.id, s.organization_id, s.billing_interval, s.period_index, s.current_period_start, s.current_period_end,
  ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => s.period_index * m.n)) AT TIME ZONE 'UTC' AS utc_period_start,
  ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (s.period_index + 1) * m.n)) AT TIME ZONE 'UTC' AS utc_period_end
FROM hon.saas_subscriptions s
CROSS JOIN LATERAL (SELECT CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END n) m
WHERE s.billing_interval IN ('MONTHLY','ANNUAL') AND s.period_index IS NOT NULL AND s.period_anchor_at IS NOT NULL
  AND (s.current_period_start, s.current_period_end) IS DISTINCT FROM
    (((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => s.period_index * m.n)) AT TIME ZONE 'UTC',
     ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (s.period_index + 1) * m.n)) AT TIME ZONE 'UTC');
```

Also record `SHOW TimeZone` for the runtime role and the database default as deployment evidence. Pinning the pool or role to UTC is optional defense in depth and not required by this change.
