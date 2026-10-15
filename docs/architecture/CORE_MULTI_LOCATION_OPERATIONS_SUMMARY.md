# Core multi-location operations summary

## API and authority

`GET /v1/organizations/:organizationId/operations/summary?from=…&to=…` is a **verified human, read-only, aggregate-only** API. It returns `data.operationsSummary` and the standard request/correlation metadata. It requires an **ACTIVE, currently effective Core or Complete entitlement in PostgreSQL**. Essential, missing, suspended, future and expired entitlements fail closed with HTTP 403 / `TIER_ENTITLEMENT_REQUIRED`; the route or client tier is never authority.

Only ACTIVE schools in an ACTIVE organization where the current human principal has an effective **`reporting.view` school grant** appear in `schools`. The organization `aggregate` and `schoolCount` cover **exactly those returned schools**, not the entire organization. They disclose neither omitted school IDs nor their count. Each per-school row is `{ schoolId, metrics }`; names, slugs, contacts and directory data are deliberately absent. Duplicate grants cannot double-count a school. An authorized empty school appears with zero counts and an empty currency list. If there are no authorized schools, the request returns generic HTTP 403 / `OPERATIONS_SUMMARY_FORBIDDEN`, including a foreign or unknown route organization.

The existing `HonIdentityGuard` verifies the HON session before the controller supplies its normalized external subject to the database boundary. Subject/principal/tier/school are not query parameters. Global query validation rejects undeclared parameters, including `tier`, `schoolId` and `principalId`. This extends neither HQ nor parent-family authority: those grants alone cannot authorize the projection.

## Narrow database exception

Migration **0058** adds only `hon.read_organization_operations_summary(text, uuid, timestamptz, timestamptz)`, plus bounded-scan indexes. It is a **STABLE SECURITY DEFINER** with fixed `search_path = pg_catalog, hon`, schema-qualified relations and no dynamic SQL. PUBLIC EXECUTE is revoked; the only new runtime privilege is EXECUTE on that fixed function. The controlled migration owner must have RLS-bypass capability to project across forced school RLS; the runtime role must remain non-superuser/non-BYPASSRLS. Canonical provisioning and both deployment verifiers check this boundary and its owner/runtime-only ACL.

Normal runtime still cannot SELECT users, principals, roles, permissions, role grants, organizations/schools, family grants, HQ directories/configuration or CRM activity rows. No school policy is broadened, no new table is introduced, and no runtime table grant is added. All existing source tables retain forced RLS. The function does not bind, clear or trust caller tenant/principal GUCs. It re-resolves a single unambiguous ACTIVE HUMAN_USER principal, joins real organization-owned roles/permissions, and checks effective grant and entitlement intervals with **statement_timestamp()** (not a potentially stale transaction start). The IAM checks, school set, tier and aggregates share one statement snapshot; subsequent calls observe committed revocation without a permission/tier cache.

The trusted runtime/verified-session boundary is the same as the existing school resolver: possession of the database EXECUTE grant alone is not proof of human identity. Never expose this function to a browser, PUBLIC role, external database client or client-supplied subject. The service uses only the restricted runtime credential and fails readiness rather than falling back to the migration connection.

## Exact metrics and time semantics

All schools and the combined aggregate use the same normalized UTC **`[from, to)`** window and database-generated `generatedAt`. Both bounds must be provided together as timezone-qualified ISO instants; default is exactly the trailing **30 × 24 hours**, maximum is **92 × 24 hours**. The database independently rejects NULL, infinite, reversed and overlong bounds. Explicit future windows are allowed for scheduled work; they do not reconstruct past/future entity statuses.

| Output | Exact semantics |
|---|---|
| `studentProfiles.total / active` | Current school-owned student-profile count; active means `status = ACTIVE`, not active membership. |
| `leads.byStatus` | Current OPEN/WON/LOST/ARCHIVED lead counts, not range-created counts or historical conversion. |
| `classSessions.inRange` | Current DRAFT/SCHEDULED/COMPLETED/CANCELLED counts where session `starts_at` is in the window. Existing single-school report semantics are reused; draft is additionally explicit. |
| `classSessions.scheduledDueInRange` | Subset still SCHEDULED whose `starts_at` is in the window and strictly before `generatedAt`; due-to-start/not-completed, not overdue billing. |
| `attendance.inRangeByStatus` | Current attendance entry outcomes for sessions starting in the window, including entries recorded outside the window. Entries, not distinct students. Same semantics as the established school report. |
| `recentActivity.crmActivitiesInRange` | Count of CRM entries with `occurred_at` in the window; no details/actors selected. |
| `recentActivity.attendanceEntriesRecordedInRange` | Count of attendance entries with `recorded_at` in the window, independently of the session start date. |
| `invoices.inRangeByStatus` | Current DRAFT/ISSUED/PAID/VOID/UNCOLLECTIBLE invoice counts, bounded by invoice `created_at` exactly as the school report. |
| `invoices.amountsByCurrency` | SUM of `total_minor` for the same range-created invoices, separated by currency and current status. Missing statuses are zero; only currencies with invoices appear, in sorted order. No mixed-currency sum, exchange rate, provider data, cash/revenue/receivable assertion or raw invoice is returned. |

Counts and monetary totals are nonnegative **safe integer numbers**; the service fails closed rather than rounding an overflow. It explicitly allowlists every response field. Neither projection nor endpoint selects/returns PII, contacts, person/principal/membership IDs, staff directory, raw invoices or provider information.

## No side effects and deliberately deferred scope

The SQL boundary contains no INSERT/UPDATE/DELETE, audit/outbox append, billing mutation, provider call, AI invocation, Action Engine operation, communications, worker or tenant-context side effect. It succeeds inside a READ ONLY transaction. This is the **Core consolidated/comparison KPI read slice**, not centralized permission management, transfers, template distribution, cross-location writes/tasks, full multi-location UI or an analytics warehouse. The existing school-only operations report remains unchanged.

## Validation

- `pnpm check`, `pnpm test`, `pnpm build`, `pnpm db:check`, `pnpm db:migrate`, `pnpm db:verify-rls`.
- `pnpm db:test-operations-summary`: real migration-fixture and restricted runtime connections; Core/Complete allow, every inactive/missing/Essential tier deny, current grant expiry/future/deletion and permission revocation, omitted same-org schools, foreign/unknown org denial, inactive/ambiguous/non-human principals, inactive schools/org, duplicate grants, empty authorized schools, exact half-open windows, due sessions, distinct session-date/recording-date attendance semantics, separate currency totals, no PII/raw/provider output, actual forbidden directory/HQ SELECTs, RLS isolation, forged-GUC independence, READ ONLY success and unchanged execution/operational evidence. It also boots the real Nest route with signed HON sessions to prove missing/invalid session denial, successful guarded HTTP reads, UUID/query injection validation, Essential denial and cross-org rejection.
- API unit tests exercise guard binding, query injection rejection, bounded/default range and UUID normalization, sanitized denials, response allowlisting, duplicate school/scope/tier validation and integer overflow.
- Run the entire existing database security/integrity suite to protect conventional operations, billing, family, provider and decision-only planning boundaries.

Fixtures use committed temporary IDs for real cross-connection API authorization and are removed in `finally`; the runtime never receives fixture privileges. No new environment key, provider credential, automation or runtime grant is required beyond the migration's explicit function EXECUTE.
