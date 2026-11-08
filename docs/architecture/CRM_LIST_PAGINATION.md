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

Errors: `400 INVALID_CURSOR` when the cursor is malformed, forged, from another school, from the other list, or from a
different `status` / `query`. Clients should drop the cursor and reload the first page. All existing authority,
suspension and paid-access refusals are unchanged and are evaluated on every page.

## Security boundary

- A cursor carries only the previous page's last sort key plus a binding hash of (list, exact school, filter). It is
  not authority: every page re-resolves the principal's live school permission (`crm.lead.read` / `people.read`), runs
  inside the tenant transaction with forced RLS, and filters by the exact organization and school.
- Cursor timestamps are exact microsecond UTC text rendered in SQL (`to_char(... AT TIME ZONE 'UTC')`), never a
  JavaScript `Date`, so rows sharing a millisecond are neither repeated nor skipped (same failure class as #130).
- Internal sort columns (`cursorAt`, `sortFamily`, `sortGiven`) are stripped from the response.
- Reads have no effects (no audit, outbox or idempotency rows).

## Evidence

- `packages/database/scripts/test-crm-list-pagination-integrity.mjs` (`db:test-crm-list-pagination`, registered in
  `run-db-proofs.sh` on the `crm-lead-close` fixture): 130 leads and 135 people in school A plus 12 of each in school B;
  60 leads share one microsecond instant, 40 people share name and `created_at`. Page sizes 100/50/7/1 (leads) and
  100/50/7 (people) each return every row exactly once in the SQL order; WON filter and people search page inside their
  filter; cross-school, cross-list, changed-filter, upper-case-id, millisecond and garbage cursors are refused; zero
  effects. Ablations: removing the id tiebreaker from either keyset makes the proof fail.
- `apps/api/test/list-cursor.test.cjs`: binding, forgery and shape refusals.

## Not in this slice

The web client still requests the first page only (`crm-leads-http.ts` caps verification at 50 rows); a "load more"
control belongs to the UI thread. The people directory still has no paid-access check of its own (pre-existing; the
person record read and edit do). Search text is still matched with `ILIKE` without escaping `%`/`_` (pre-existing).
