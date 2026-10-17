# Staff operations dashboard

## Scope and authority

`/staff/dashboard` is a **protected, no-index, conventional staff page**. The server page verifies the HON session and redirects unauthenticated requests to `/auth/login`. On initial mount, its browser makes one selector-free, same-origin, no-store read:

```text
GET /v1/staff/current-reporting-school
```

Only a closed `RESOLVED` result supplies the organization/school for the existing independently authorized report:

```text
GET /v1/organizations/:organizationId/schools/:schoolId/reports/operations
```

The supplied organization and school UUIDs are selectors only. The existing `HonIdentityGuard` and `OperationsReportController` resolve the active verified human through `hon.resolve_authorized_scope(..., 'reporting.view')`; client tier, principal, and selected IDs are not authority. A foreign organization, other school, HQ-only identity, parent/family identity, or human without the exact school `reporting.view` grant receives the existing forbidden result and the browser clears the dashboard.

Migration `0141_current_staff_reporting_scope.sql` adds only the fixed `hon.resolve_current_staff_reporting_scope(p_subject text)` read. The new endpoint uses only the verified `HonIdentityGuard` subject and returns either `{ data: { state: 'RESOLVED', organizationId, schoolId } }` or `{ data: { state: 'MANUAL_ENTRY_REQUIRED' } }`. Nonresolution never includes IDs, candidate lists, counts or reasons. Query/body/selectors, role/tier/delegation/command markers and cross-site reads are refused. The no-store guard runs before authentication; anonymous/invalid sessions remain `401`, forbidden reads `403`, and unavailable/unsafe persistence `503`.

The dashboard adds **no new permission, mutable field, runtime table grant, selected-school preference, worker, provider call, AI request, voice operation, Action Engine request, communication, or external side effect**. Existing OperationsReport authorization remains unchanged and is the final live authorization boundary.

## Exact-one ordinary-school policy

The resolver returns a scope only for one active `HUMAN_USER` joined to the exact external subject's user, with no other active principal, exactly one effective non-revoked live school scope, a live active organization/school, compatible role-management scope, existing `staff_member_eligible` eligibility (0077), and staff-assignable `reporting.view` on an eligible role. The current schema has no separate user or role activation flag: principal activation and effective non-revoked role grants are the existing IAM representation.

An authorized single-school `OWNER` qualifies **only through that same existing staff eligibility and reporting permission**; the role name alone, owner-launch scope, registration receipts or launch permissions are not authorization. Multiple compatible staff roles/grants at the same school remain one scope. Conservatively, a second live school scope prevents auto-default even when it has no reporting permission.

Any HQ operator grant excludes automatic ordinary-staff defaulting, including an expired HQ grant (0077's existing separation pattern). Current family access and any effective non-revoked parent/guardian/student/family/HQ/HON_/platform/system role at any school also exclude it, even without `reporting.view`. Zero/multiple/mixed/unauthorized states all share the identifier-free manual-required response. No generic switcher/list or other-page rollout is implemented.

The manual known-ID form remains available. Query-prefilled fields stay inert and never enter the automatic resolver/report path. The browser renders no report, owner confirmation, or personal Platform View preference until the existing report strictly verifies the exact requested organization and school. Resolver/report errors, extra/malformed fields, mismatches, field edits and stale async results cannot retain verified report/presentation state. React development effect replay shares only the mounted instance's one resolver promise; no school scope is cached across mounts or persisted.

**No selected-school preference is created or saved in this slice.** School choice is derived from server IAM, and every protected report or preference operation independently revalidates its school authority server-side. Existing personal Platform View preference reads/saves remain presentation-only and are gated behind the verified report. A future independently authorized multi-school switcher may persist a selected-school preference only with server-side revalidation; this exact-one default supplies no such contract.

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

Local implementation proof (no remote DB, deployment or provider calls):

- API `pnpm check`, `pnpm build`, and package-relative `node --test test/*.test.cjs`: **295/295 passed**, including the unchanged OperationsReport tests and eight new current-scope tests.
- Web `pnpm check` and `pnpm test`: **70 files / 334 tests passed**. Current-scope transport and dashboard lifecycle tests cover single staff/authorized owner, nonresolution, query inertness, extras/malformed data, resolver failures, report mismatch/denial, stale resolution, effect replay, manual fallback, and no preference before the report.
- `node packages/database/scripts/verify-migrations.mjs`: **141 migrations verified**.
- `node --test packages/database/scripts/test-current-staff-reporting-scope-static.mjs`: **3/3 passed**.
- `node packages/database/scripts/test-current-staff-reporting-scope-local.mjs /home/ubuntu/jobs/job_<id>`: **49 PostgreSQL proofs passed**, applying all 141 actual migrations in a newly initialized, socket-only UTF-8 cluster. Cases include actual single staff/OWNER, unauthorized owner, zero/multiple principals/schools, second non-reporting school, reserved roles, staff+family, live/expired HQ, revoked/future/expired grants, inactive principal/org/school, management-school mismatch, no direct directory access, and rollback-only ACL/definer/search-path/forced-RLS drift rejection. The cluster is stopped after proof; configured database URLs are never read.
- `git diff --check`: passed.

The canonical runtime SQL verifier and JS RLS verifier now include this fixed resolver's exact signature, constrained search path, trusted definer ownership, runtime-only non-grantable EXECUTE, and preserved forced RLS. The migration has **not** been applied to any existing/remote database; runtime deployment remains outside this task.
