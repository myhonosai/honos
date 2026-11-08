# B-CRM-4 — CRM lead list and people directory pagination

Status: proposed (draft PR). No migration, no grant change, no new permission.

## Problem

`GET /v1/organizations/:org/schools/:school/crm/leads` and `GET /v1/organizations/:org/schools/:school/people` returned
at most 50 rows (leads: `limit` 1–100, default 50; people: always 50) with no way to reach older leads or later
directory entries. The lead order also had no unique tiebreaker, so rows sharing `created_at` had no stable order.

## Contract (backward compatible)

Both reads keep `data` as the same array of the same row shape. Their `meta` gains two fields:

| field | meaning |
|---|---|
| `meta.limit` | the page size used (1–100, default 50) |
| `meta.nextCursor` | opaque string for the next page, or `null` on the last page |

New optional query parameters: `cursor` (both), `limit` (people; leads already had it). To read the next page, repeat
the same request (same school, same `status` or `query`) with `cursor=<meta.nextCursor>`. `nextCursor` is returned
only when at least one more row existed at read time, so an exact multiple of the limit does not produce an empty page.
Rows created after the first page that sort before the cursor appear on a fresh first page, not later pages.

Orders:

- Leads: `created_at DESC, id DESC` (newest first; previously `created_at DESC` only).
- People: `family_name, given_name, created_at, id` ascending (previously without `id`).

Errors: `400 INVALID_CURSOR` when the cursor is malformed, edited or client-minted, from another school, from the other
list, or from a different `status` / `query`, or (people) when the last person of the previous page was edited or
removed since that page was read. Clients should drop the cursor and reload the first page. All existing authority,
suspension and paid-access refusals are unchanged and are evaluated on every page.

## Security boundary

- Cursor format: `base64url(JSON {v:1, k:[...]}) . base64url(HMAC-SHA256)`, at most 512 characters. The HMAC covers
  the format version, list, exact school, filter and every position key. Its key is HKDF-SHA256 of the API's own
  session-signing secret (`HON_SESSION_JWT_SECRET`, which the startup gate requires in production and staging and
  every API instance shares), domain-separated (salt `hon-list-cursor`, info `hon.list-cursor.v1`) so it can never
  verify a session. Without a valid session secret (local tests) a per-process random key is used. Rotating the
  session secret only makes open cursors reload page one. Instants are also checked as real calendar times.
- Lead positions are the immutable `(created_at, id)`. A people position is the last person's `(id, version)` only:
  the read takes that person's live sort keys from the row, and refuses if the version changed. So no name or search
  text travels in a URL, access log or cursor, and the cursor size is fixed whatever the name length or script
  (Korean names of 120 or 400 characters page normally).
- A cursor is not authority: every page re-resolves the principal's live school permission (`crm.lead.read` / `people.read`), runs
  inside the tenant transaction with forced RLS, and filters by the exact organization and school.
- Cursor timestamps are exact microsecond UTC text rendered in SQL (`to_char(... AT TIME ZONE 'UTC')`), never a
  JavaScript `Date`, so rows sharing a millisecond are neither repeated nor skipped (same failure class as #130).
- Internal sort columns (`cursorAt`, `sortFamily`, `sortGiven`) are stripped from the response.
- Reads have no effects (no audit, outbox or idempotency rows).

## Evidence

- `packages/database/scripts/test-crm-list-pagination-integrity.mjs` (registered in `run-db-proofs.sh` on the
  `crm-lead-close` fixture). It runs over signed-session HTTP through `HonIdentityGuard`, the global `ValidationPipe`
  and `HonExceptionFilter`, and is guarded by `crm-close-proof-target.mjs`. That guard checks the exact URLs as text
  and with node-postgres's parser, refuses PG* and provider variables, and verifies the database, role, loopback peer
  and setup marker after connecting. Its socket-free negatives (`test-crm-close-proof-target.mjs`) run first.
  - Fixture: 130 leads and 147 people in school A, including 12 Korean-named people with 120- and 400-character names,
    plus 12 of each in school B.
  - Page sizes 100/50/7/1 (leads) and 100/50/7 (people) each return every row exactly once in SQL order. The Korean
    rows page one at a time.
  - Refused: filter, school and list rebinding; 9 tampered or client-minted cursors (including valid-shaped timestamp
    and id edits and impossible dates); over-long cursors; an edited anchor.
  - Page two is refused after the permission is removed and after school, organization or entitlement suspension.
  - Zero effects.
  - Ablations, each making the proof fail: no lead id tiebreaker, no people id tiebreaker, no anchor version check, no
    signature check.
- `apps/api/test/list-cursor.test.cjs`: binding, valid-shaped tampering, key rotation, calendar validation and size
  bound.

## Not in this slice

The web client still requests the first page only (`crm-leads-http.ts` caps verification at 50 rows); a "load more"
control belongs to the UI thread. The people directory still has no paid-access check of its own (pre-existing; the
person record read and edit do). Search text is still matched with `ILIKE` without escaping `%`/`_` (pre-existing).
