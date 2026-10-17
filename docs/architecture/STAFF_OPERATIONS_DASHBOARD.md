# Staff operations dashboard

## Scope and authority

`/staff/dashboard` is a **protected, no-index, conventional staff page**. The server page verifies the HON session and redirects unauthenticated requests to `/auth/login`. On initial mount, its browser preserves the existing selector-free, same-origin, no-store exact-one read:

```text
GET /v1/staff/current-reporting-school
```

A closed `RESOLVED` result supplies the exact organization/school for the existing independently authorized report. Only an explicit `MANUAL_ENTRY_REQUIRED` result triggers the new subject-only choice read:

```text
GET /v1/staff/reporting-schools
```

This second endpoint returns either a closed `{ data: { state: 'SELECTION_REQUIRED', schools: [{ organizationId, schoolId, organizationName, schoolName }, ...] } }` or the same identifier-free `{ data: { state: 'MANUAL_ENTRY_REQUIRED' } }`. Multiple schools are **never guessed or automatically selected**. The user must choose one and submit before this existing report is read:

```text
GET /v1/organizations/:organizationId/schools/:schoolId/reports/operations
```

The supplied organization and school UUIDs are selectors only. The existing `HonIdentityGuard` and `OperationsReportController` resolve the active verified human through `hon.resolve_authorized_scope(..., 'reporting.view')`; client tier, principal, and selected IDs are not authority. A foreign organization, other school, HQ-only identity, parent/family identity, or human without the exact school `reporting.view` grant receives the existing forbidden result and the browser clears the dashboard.

Migration `0141_current_staff_reporting_scope.sql` and its fixed `hon.resolve_current_staff_reporting_scope(p_subject text)` remain unchanged. Its endpoint still returns only `{ data: { state: 'RESOLVED', organizationId, schoolId } }` or `{ data: { state: 'MANUAL_ENTRY_REQUIRED' } }`. Additive migration `0142_staff_reporting_schools.sql` introduces only `hon.read_staff_reporting_schools(p_subject text)` for the dashboard chooser. Both endpoints use only the verified `HonIdentityGuard` signed-session subject. Nonresolution never includes IDs, a list, a count, or a reason. Query/body/selectors, role/tier/delegation/command headers and cross-site reads are refused. The no-store guard runs before authentication; anonymous/invalid sessions remain `401`, forbidden reads `403`, and unavailable/unsafe persistence `503`.

The new runtime read uses the fixed function in a bounded **READ ONLY** transaction and checks the actual `hon_runtime` role for bypass, superuser, inheritance, role/database creation, replication, and membership hazards. Runtime receives only non-grantable function EXECUTE, not a directory/table grant. The migration removes PUBLIC, known clients, and unexpected default function grantees. The canonical verifier seals the selector's exact signature/body, trusted owner, constrained search path, ACL, role restrictions, directory denial, and preserved forced RLS.

The dashboard adds **no new permission, mutable field, runtime table grant, selected-school preference, worker, provider call, AI request, voice operation, Action Engine request, communication, or external side effect**. Existing OperationsReport authorization remains unchanged and is the final live authorization boundary.

## Exact-one ordinary-school policy

The resolver returns a scope only for one active `HUMAN_USER` joined to the exact external subject's user, with no other active principal, exactly one effective non-revoked live school scope, a live active organization/school, compatible role-management scope, existing `staff_member_eligible` eligibility (0077), and staff-assignable `reporting.view` on an eligible role. The current schema has no separate user or role activation flag: principal activation and effective non-revoked role grants are the existing IAM representation.

An authorized single-school `OWNER` qualifies **only through that same existing staff eligibility and reporting permission**; the role name alone, owner-launch scope, registration receipts or launch permissions are not authorization. Multiple compatible staff roles/grants at the same school remain one scope. Conservatively, a second live school scope prevents auto-default even when it has no reporting permission.

Any HQ operator grant excludes automatic ordinary-staff defaulting, including an expired HQ grant (0077's existing separation pattern). Current family access and any effective non-revoked parent/guardian/student/family/HQ/HON_/platform/system role at any school also exclude it, even without `reporting.view`. The exact-one resolver still gives zero/multiple/mixed/unauthorized states its identifier-free manual-required response. The subsequent chooser does not relax any mixed-identity exclusion and is not used by other pages.

The manual known-ID form remains available when neither read offers a scope, and as an explicit fallback from the chooser. Query-prefilled fields stay inert and never enter the automatic resolver or choice path. The browser renders no report, owner confirmation, or personal Platform View preference until the existing report strictly verifies the exact requested organization and school. Resolver/selector/report errors, extra/malformed fields, mismatches, choice/field edits, fallback changes and stale async results cannot retain verified report/presentation state. React development effect replay shares only the mounted instance's read promises; no school choice is cached across mounts or persisted.

**No selected-school preference is created or saved in this slice.** Choice state exists only in the mounted component and drives an exact report-route read; it is not a policy preference or authority. Every protected report or presentation-preference operation independently revalidates its school authority server-side. Existing Big-Button / Phone, Modern HON, and Classic CRM preferences remain presentation-only and gated behind the verified report. Any future selected-school persistence requires a separate audited contract.

## Bounded ordinary multi-school policy

The chooser requires the same **pure ordinary human** identity and staff/reporting eligibility as the exact-one policy. Every effective non-revoked scope at an active organization/school must independently satisfy existing `staff_member_eligible`, a compatible non-reserved role grant, and staff-assignable `reporting.view`. It counts all live scopes **before** reporting/role-compatibility filtering: any second non-reporting or incompatible scope disqualifies the entire list, not just that option. Additional compatible roles at the same school do not duplicate choices. Active school scopes across organizations may qualify through their own exact grants; no other organization/school is enumerated.

The list has a hard **20-school maximum** in SQL, runtime, endpoint and browser. Only 2–20 wholly eligible scopes produce a list. Zero, exact-one, mixed, unauthorized, or over-cap selector contexts produce the same manual-required state with no list/count/reason; exact-one auto-default remains the separate unchanged initial read. Over-cap never returns a truncated directory.

Only organization/school UUIDs and display labels are returned. Labels use the actual `organizations.display_name` and `schools.name` columns, not invented schema fields or legal/contact names; they are bounded to 120 characters and reject unsafe control/bidi labels. No roles, permissions, principals, students, families, contact data, metrics, entitlement, provider information or explicit counts accompany choices. The strict browser parser reconstructs the closed schema, rejects extras/duplicates/unsafe labels and verifies JSON, no-store, no redirect and the exact same-origin response URL.

The accessible native school chooser begins with an empty prompt and offers human-readable school/organization labels, not daily UUID fields. Choosing an option only clears scoped content/theme and sets transient form state. Explicit submission binds **both** report selectors to that offered option, ignoring prefilled IDs or an invented DOM UUID. Every load revalidates through OperationsReport, and denial/mismatch clears report/theme/choice state. An explicit known-ID fallback remains available; it never grants authority.

## Approved display data

The browser strictly reconstructs the existing `OperationalSnapshot` DTO and rejects extra fields. It displays only:

| Dashboard area | Existing safe data | Semantics |
|---|---|---|
| Attendance & classes | `classSessions.inRange`, `attendance.inRangeByStatus` | Sessions whose `starts_at` is in the bounded report window; attendance outcomes for those sessions. |
| Leads | `leads.byStatus` | Current school lead status counts, not period-created leads or conversion history. |
| Membership | `memberships.byState` | Current membership state counts. |
| Invoice status | `invoices.inRangeByStatus` | Current status of invoices created in the bounded report window. Counts are not revenue, collections, or payment outcomes. |

No people names/contacts, staff/principal IDs, student IDs, raw notes, appointment records, payment methods, payment attempts, provider data, invoice amounts, evidence blobs, or row-level records are admitted to the operational aggregate DTO. The separate school chooser carries only the minimal IDs/display labels described above; existing independently verified owner confirmations retain their separate fixed contract.

## Deliberate gaps

The existing report contains no trial aggregate and no revenue-plan summary, so those cards explicitly say **unavailable** and link only to the actual safe staff workflows. Follow-up, renewal review, action-approval, and human-work APIs expose bounded queue pages rather than a dashboard-wide aggregate count; the dashboard intentionally does not enumerate those queue records merely to infer a number. Their cards state **not counted here** and link to their respective managed workbenches.

A verified zero is shown as zero. An initial, access-denied, malformed, or unavailable response never falls back to sample content.

## Validation

Local implementation proof (no remote DB, deployment or provider calls):

- API `pnpm --filter @hon/api check`, `pnpm --filter @hon/api build`, and package-relative `node --test test/*.test.cjs`: **304/304 passed**, including unchanged exact-one/OperationsReport tests and nine new selector endpoint/runtime tests. Focused endpoint suites: **20/20 passed**.
- Web `pnpm --filter @hon/web check` and `pnpm --filter @hon/web test`: **71 files / 358 tests passed**. Focused current-school/selector/dashboard suites: **4 files / 61 tests passed**. Coverage includes single staff/authorized owner auto-default, pure multi-school choice, no report before explicit submit, exact cross-organization selectors, manual fallback, query inertness, schema/transport failures, denial/mismatch clearing, stale resolver/selector/report/preference results, effect replay, fresh-mount no-persistence and no preference before the report.
- `node packages/database/scripts/verify-migrations.mjs`: **142 migrations verified**.
- `node --test packages/database/scripts/test-current-staff-reporting-scope-static.mjs packages/database/scripts/test-staff-reporting-schools-static.mjs`: **6/6 passed**.
- `node packages/database/scripts/test-current-staff-reporting-scope-local.mjs /home/ubuntu/jobs/job_<id>`: **123 PostgreSQL proofs passed**, applying all 142 actual migrations in a newly initialized, socket-only UTF-8 cluster. Cases include unchanged single staff/OWNER, actual two-school and cross-organization lists, duplicate grants, zero/unauthorized/multiple-principal/mixed/reserved/family/HQ exclusions, second non-reporting/incompatible scopes, effective/revoked/expired/future grants, inactive principal/org/school, staff-assignability, safe labels, exact 20/21 bounds, forged context GUCs, report-resolver denial after revocation, no audit/outbox effects, removal of an unexpected default EXECUTE grantee, no direct directory access, and rollback-only ACL/definer/search-path/forced-RLS/role/overload drift rejection. The cluster is stopped after proof; configured database URLs are never read. Its report-resolver proof supplies only the existing 010 bootstrap EXECUTE grant in the disposable fixture.
- `git diff --check`: passed.

The canonical runtime SQL verifier and JS RLS verifier include both fixed scope boundaries. Migration 0142 has **not** been applied to any existing/remote database; deployment, commits/pushes and selected-school persistence remain outside this task.
