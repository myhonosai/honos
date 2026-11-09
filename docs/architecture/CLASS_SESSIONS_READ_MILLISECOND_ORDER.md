# Class Sessions read: one millisecond ordering rule (migration 0203, provisional number)

## Spec

**Defect (P2, confirmed by Manus, reproduced in PR #129).** `hon.read_current_school_class_sessions` (0147)
sorted and cut the 50-row list by full PostgreSQL microsecond `starts_at`, then `id`. It publishes
`startsAt` truncated to milliseconds, and the closed contract `verifyCurrentSchoolClassSessions`
requires strictly increasing `(published startsAt, sessionId)`. Two sessions inside one published
millisecond whose microsecond order disagrees with their UUID order made the contract reject the
whole list, so the signed staff GET returned HTTP 500. The same mismatch let the 50-row boundary keep
a row that the published rule places 51st.

**Rule.** One deterministic key everywhere: `date_trunc('milliseconds', starts_at AT TIME ZONE 'UTC')`
(the value that is published) then `id` ascending. SQL inner ORDER BY + LIMIT 50, the outer
`jsonb_agg` order, published `startsAt` and the unchanged contract all use it.

**Must not change.** API path, response shape and contract (no Codex change), authorization
(`require_current_school_class_sessions_read_actor` before and after), exact-school isolation,
entitlement checks, window, LIMIT 50, SECURITY DEFINER/VOLATILE/search_path, owner, ACL (the
canonical 010 named EXECUTE grant and 011 verifier from #128), forced RLS. 0147 is not edited.

## Plan

1. Red: `test-class-sessions-read-microsecond-order.mjs` (signed session cookie -> Nest guards ->
   controller -> restricted runtime -> disposable PostgreSQL). On main 8257ad2 it fails with
   `HTTP 500 {"message":"Internal server error"}`.
2. Green: new migration 0203 `CREATE OR REPLACE` of the projection body only, plus a posture
   assertion (definer, volatile, search_path, no PUBLIC EXECUTE on either function).
3. Static/unit pins in `apps/api/test/class-sessions-read.test.cjs`; proof registered in
   `run-db-proofs.sh` and `db:test-class-sessions-read`; migration checksum and commercial staging
   ceiling updated.

## Migration numbering

0194–0202 are provisionally held by the unmerged S4/C1/CW1 chain, so this uses **0203** without
taking one of those numbers. If 0203 reaches main first, a database that applies it before
0194–0202 will list those as out-of-order pending (`migration-status`). 0203 replaces one
read-only projection and touches no S4 object, so it is order-independent with that chain. The owner
may renumber; only the filename, checksum entry, commercial staging manifest and the static test
pin change.

## Residual (not fixed here)

`endsAt` is also truncated. A session whose persisted duration is under one millisecond and inside
one millisecond (`ends_at > starts_at` allows it) would still publish `endsAt == startsAt` and fail
the contract. Fixing it needs a product rule (exclude, or minimum duration), so it is reported, not
changed.
