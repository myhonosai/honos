# U5 class-session roster read

`GET /v1/organizations/:organizationId/schools/:schoolId/schedule/sessions/:sessionId/roster?limit=&cursor=`

This read is read-only. It lists every student who has a booking on, or attendance recorded for, one exact class session of the verified school. Walk-ins have attendance and no booking. A cancelled booking stays on the list with its status. Each row carries only that session's booking and attendance. A student's records from other sessions never appear on it.

## Authority

- The controller resolves the verified session identity's scope with `resolveAuthorizedScope(subject, schoolId, 'attendance.record')`. The route's organization and school must equal that scope. URL values are not authority.
- Inside the read transaction, `hon.lock_attendance_actor(subject, 'attendance.record')` re-decides everything live. That is the same gate the exact attendance lookup uses. It checks the human-UI boundary (HUMAN_USER and HUMAN_UI, no action request), an ACTIVE organization and school, the grant, and an ACTIVE ESSENTIAL, CORE or COMPLETE entitlement. A refusal is a 403 ATTENDANCE_FORBIDDEN. The live check runs on every page, so a permission removed or a suspension between pages refuses the next page.
- `schedule.session.read` and `people.read` alone are not enough. A roster names students and shows their attendance, so it uses the attendance staff permission.
- The roster never reads `hon.class_sessions`. Runtime has no SELECT on that table: 0147 makes the named projection the only session read boundary, and `class-sessions-read-security.mjs` asserts it. Rows come only from `class_bookings` and `attendance_records` of the exact session, filtered by the verified organization and school under forced RLS. An unknown session id, or another school's, therefore returns an empty roster, not a 404. Session facts (name, times, capacity) come from the class-session reads.
- The response carries `Cache-Control: private, no-store`. The read writes no audit, outbox or idempotency rows.

## Order and paging

- Rows are ordered by `family_name, given_name, student_profile_id` ascending.
- `limit` runs from 1 to 100 and defaults to 50. `meta.nextCursor` is null on the last page.
- The cursor is the signed list cursor from `CRM_LIST_PAGINATION.md`, with list `schedule.session.roster`, the school, and the filter `{ sessionId }`. A cursor issued for another session, another school or another list is refused with 400 INVALID_CURSOR.
- Names can change, so the cursor carries `[studentProfileId, person version]` and no names. The next page looks up the anchor live. If the anchor student is no longer on this roster, or the person was edited (the version moved), the read returns 400 INVALID_CURSOR and the client restarts from page one.

## Response

```json
{
  "data": [{
    "studentProfileId": "…", "personId": "…", "givenName": "…", "familyName": "…", "studentStatus": "ACTIVE",
    "booking": { "id": "…", "kind": "REGULAR", "status": "BOOKED", "source": "STAFF", "bookedAt": "…", "cancelledAt": null, "version": 1 },
    "attendance": { "id": "…", "status": "PRESENT", "category": "REGULAR_PARTICIPANT", "recordedAt": "…", "version": 1 }
  }],
  "meta": { "requestId": "…", "correlationId": "…", "limit": 50, "nextCursor": null }
}
```

`booking` or `attendance` is null when that record does not exist. The types are in `@hon/contracts` (`class-session-roster.ts`).

## Proof

`packages/database/scripts/test-class-session-roster-integrity.mjs` (in `.github/scripts/run-db-proofs.sh`, on the crm-lead-close fixture). It runs the socket-free target guard negatives first and connects only to a guarded disposable target. The fixture grants its runtime role SELECT on `hon.class_sessions`, so the proof revokes that grant for its run, asserts that the revoke holds, and restores it in a `finally`. The read is therefore tested under the production ACL. The pre-fix service, which read `class_sessions` directly, fails this proof with a 403 on every read. It then drives signed HTTP through the real Nest app. The fixture has 76 roster students, including 6 walk-ins, one cancelled booking, 30 students with the same name, and 4 long Korean names. Four of them also hold records in a second session, and both that session and another school hold students who must not appear.

The proof checks every student once in order at limits 100, 50, 9 and 1, with the exact booking and attendance per row. It checks the cursor refusals: tampered, retargeted, over-long, and an edited anchor. It checks that another school's session or an unknown id returns an empty roster. It checks that a reader without `attendance.record` gets a 403. It checks that page two is refused after permission removal and after school, organization or entitlement suspension. It confirms zero effects.

Ablations of the compiled service that the proof catches:
- Dropping the live lock.
- Dropping the anchor version check.
- Dropping the session filter on the booking or attendance join.
- Dropping it from the roster membership.
