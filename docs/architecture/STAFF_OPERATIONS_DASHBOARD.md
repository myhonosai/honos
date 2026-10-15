# Staff operations dashboard

## Scope and authority

`/staff/dashboard` is a **protected, no-index, conventional staff page**. The server page verifies the HON session and redirects unauthenticated requests to `/auth/login`. Its browser read is fixed to the existing same-origin route:

```text
GET /v1/organizations/:organizationId/schools/:schoolId/reports/operations
```

The supplied organization and school UUIDs are selectors only. The existing `HonIdentityGuard` and `OperationsReportController` resolve the active verified human through `hon.resolve_authorized_scope(..., 'reporting.view')`; client tier, principal, and selected IDs are not authority. A foreign organization, other school, HQ-only identity, parent/family identity, or human without the exact school `reporting.view` grant receives the existing forbidden result and the browser clears the dashboard.

The dashboard introduces **no database migration, projection, endpoint, permission, mutable field, runtime table grant, worker, provider call, AI request, voice operation, Action Engine request, communication, or external side effect**.

## Approved display data

The browser strictly reconstructs the existing `OperationalSnapshot` DTO and rejects extra fields. It displays only:

| Dashboard area | Existing safe data | Semantics |
|---|---|---|
| Attendance & classes | `classSessions.inRange`, `attendance.inRangeByStatus` | Sessions whose `starts_at` is in the bounded report window; attendance outcomes for those sessions. |
| Leads | `leads.byStatus` | Current school lead status counts, not period-created leads or conversion history. |
| Membership | `memberships.byState` | Current membership state counts. |
| Invoice status | `invoices.inRangeByStatus` | Current status of invoices created in the bounded report window. Counts are not revenue, collections, or payment outcomes. |

No names, contacts, staff/principal IDs, student IDs, raw notes, appointment records, payment methods, payment attempts, provider data, invoice amounts, evidence blobs, or row-level records are displayed or accepted by the client validator.

## Deliberate gaps

The existing report contains no trial aggregate and no revenue-plan summary, so those cards explicitly say **unavailable** and link only to the actual safe staff workflows. Follow-up, renewal review, action-approval, and human-work APIs expose bounded queue pages rather than a dashboard-wide aggregate count; the dashboard intentionally does not enumerate those queue records merely to infer a number. Their cards state **not counted here** and link to their respective managed workbenches.

A verified zero is shown as zero. An initial, access-denied, malformed, or unavailable response never falls back to sample content.

## Validation

`apps/web/test/staff-dashboard-ui.test.tsx` checks the fixed same-origin GET path, credential/no-store behavior, DTO allowlisting and PII/private-field rejection, denial clearing/error handling, protected/no-index route metadata, real workflow links, and absence of mutation/automation execution imports. Existing `operations-summary` API tests cover report guard binding and response allowlisting; database security suites continue to verify `reporting.view` live-scope behavior.
