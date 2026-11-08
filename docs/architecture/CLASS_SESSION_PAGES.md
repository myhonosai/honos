# Forward-paging class-session list (0221)

`GET /v1/organizations/:organizationId/schools/:schoolId/schedule/sessions/list?from=&limit=&cursor=`

This read lists the verified school's class sessions that start on or after a school-local date, in the published order. The date defaults to the school's local today. Unlike the bounded current-school read (0147/0203), it has no fixed window: a page holds 1 to 100 rows (default 50), and a signed cursor reaches the next page. Each row has exactly the same fields as the bounded read. The list writes nothing.

## Why a database function

0147 makes named projections the only session read boundary for runtime. The canonical `010` grants still give runtime SELECT on `hon.class_sessions` (issue #177), but this read does not rely on that. Migration 0221 adds one read-only SECURITY DEFINER projection, `hon.read_school_class_session_page(subject, p)`. Runtime gets EXECUTE on it and on nothing else new. The 010 grant block, the 011 exact verification (body hash, owner, ACL) and `class-sessions-read-security.mjs` pin it. The security check confirms the access check runs twice, no row is changed or locked, and only `schools` and `class_sessions` are read.

## Authority

- **Controller check:** `resolveAuthorizedScope` must pass for `schedule.session.read` at the route school, and the route's organization and school must equal the verified scope. URL values are not authority.
- **Database decision:** the definer function decides again, independently, with the same private helper as the bounded read, `hon.require_current_school_class_sessions_read_actor`. That helper requires:
  - a direct human (HUMAN_USER, HUMAN_UI, no action request, no delegation) with exactly one active principal;
  - no HQ, family, parent-style or mixed role;
  - `schedule.session.read` live at the current school;
  - an ACTIVE organization and school, and an ACTIVE ESSENTIAL, CORE or COMPLETE entitlement.

  The function repeats the check after building the page, so a page is never returned after access is lost. All checks run on every page.
- **Browser-only transport:** this is the bounded read's guard, extended to accept only `from`, `limit` and `cursor`, each at most once. It requires `X-Hon-Human-Read: class-sessions` and same-origin `Sec-Fetch-*`. It refuses any other `x-hon-*` header and any authority header. The bounded read still accepts no query at all.
- **Refusals:**
  - 403 CLASS_SESSIONS_READ_FORBIDDEN;
  - 403 HUMAN_COMMAND_REQUIRED for a non-human service context;
  - 403 HUMAN_UI_REQUIRED for a transport violation;
  - 400 CLASS_SESSIONS_READ_SELECTORS_NOT_ACCEPTED for an unknown or repeated query key.
- **Response headers:** `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`.

## Order, filter, paging

- **Order:** the 0203 rule. Rows are ordered by published UTC millisecond `startsAt`, then `sessionId`. Sessions that share a published millisecond are ordered by id alone.
- **`from`:** a school-local date, `YYYY-MM-DD`, from 2000 to 2100. The list starts at that date's local midnight in the school timezone. A missing `from` means the school's local today. An impossible date such as 2026-02-30 returns 400 VALIDATION_FAILED.
- **Cursor:** the signed list cursor (`CRM_LIST_PAGINATION.md`), with list `schedule.session.list`. It is bound to the school and the requested `{ from }`. Its key is the last row's published millisecond as a microsecond instant, plus its id.
  - Later pages need no date bound, because every row after the position starts on or after the first page's start. A default-date list therefore keeps paging correctly across a local midnight.
  - A cursor from another school or another `from` is refused with 400 INVALID_CURSOR. So is a tampered or truncated cursor.
- **Status:** every status is listed (DRAFT, SCHEDULED, CANCELLED, COMPLETED), as in the bounded read.

## Response

```json
{
  "data": [{ "sessionId": "…", "name": "…", "startsAt": "2026-11-09T01:00:00.000Z", "endsAt": "…", "roomName": null,
             "capacity": 20, "bookingPolicy": "WALK_IN", "status": "SCHEDULED", "createdAt": "…" }],
  "meta": { "requestId": "…", "correlationId": "…", "limit": 50, "nextCursor": null,
            "schoolTimezone": "America/Los_Angeles", "localToday": "2026-11-08", "fromDate": "2026-11-08" }
}
```

- **Types:** `@hon/contracts` (`class-session-pages.ts`). Rows reuse `verifyCurrentSchoolClassSessionItems`, the bounded read's row and order verifier, with a maximum of 100.
- **Verification:** the API verifies every database page strictly, including that each cursor instant is the published millisecond. It returns 503 for anything it cannot verify.

## Proof

`packages/database/scripts/test-class-session-pages-integrity.mjs` is in `.github/scripts/run-db-proofs.sh`, on the crm-lead-close fixture. It runs the socket-free target guard negatives first and connects only to the guarded disposable target. It revokes the fixture runtime's class_sessions SELECT for the run, then drives signed HTTP through the real Nest app.

**Fixture:** a school timezone whose local clock is far from midnight, and these school-A sessions:
- eight past sessions, one of them 1 microsecond before local midnight;
- one session at local midnight;
- 30 sessions in one published millisecond;
- ten sessions one millisecond apart;
- twelve sessions spread over 300 days;
- four sessions that are cancelled, draft or completed;
- sessions of school B and of another organization, which must not appear.

**What it checks:**
- Every session from local midnight appears once, in order, at limits 100, 50, 7 and 1. Exact facts are computed independently in JavaScript.
- The rows equal the bounded read wherever both list a session.
- `from` dates from 41 days back to 301 days ahead return the right rows.
- The read is limited to the exact school and organization.
- Cursors are bound to the school and the `from` date. Tampered, truncated and over-long cursors are refused.
- Impossible dates, bad limits, and unknown or repeated query keys are refused.
- A reader without the permission, a mixed family role and an unknown subject are refused.
- A direct service call proves the database decides independently of the controller, for a refused actor, a forged school and a non-human context.
- Transport violations are refused.
- Page two is refused after the permission is revoked, or after the school, organization or entitlement is suspended. It works again once access is restored.
- The runtime ACL holds: EXECUTE on the function only, no helper, no table SELECT and no PUBLIC. Reads have zero effects.

**Ablations the proof catches:**
- On the function: the school filter, the keyset comparison, the `from` bound, the id tiebreak, school-local midnight replaced by UTC midnight, the `lim+1` look-ahead, and raw microsecond order instead of the published millisecond.
- On the compiled API: the from-bound cursor, the human-context check, and the guard's single-value query rule.
