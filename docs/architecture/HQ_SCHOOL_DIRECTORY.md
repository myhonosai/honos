# HQ School Management — Bounded Directory

**Status:** implemented as the first HQ School Management slice: a fixed, read-only, minimized directory. It is **not** support access, impersonation, school administration, customer search, or a general HQ data bridge.

## Fixed contract

`GET /api/v1/hq/schools` accepts **no query, path selector, body, organization, school, tier, source, action, delegation, or time field**. Its closed response is:

```ts
{ data: { directory: { schools: HqSchoolDirectoryEntry[] } } }
```

Each entry contains only:

| Field | Meaning |
| --- | --- |
| `schoolId` | Opaque UUID used solely as a stable React key; it is not a selector or authority token. |
| `organizationDisplayName`, `schoolDisplayName` | Customer-facing display labels only. |
| `organizationOperationalStatus`, `schoolOperationalStatus` | Existing operational status (`ACTIVE`, `SUSPENDED`, or `ARCHIVED`). |
| `entitlementTier` | Current active/effective `ESSENTIAL`, `CORE`, or `COMPLETE` tier, or `null` when no current tier is authoritative. |
| `createdAt` | The school creation timestamp in UTC. |

Rows are chronological by school creation timestamp, then opaque school ID. An empty `schools` array is an honest empty result; the UI never inserts examples, cached rows, or inferred account state.

The projection excludes organization/legal identity, contacts, owners, users, staff, students/families, schedule/attendance/curriculum, billing/payment/invoice/account/provider/credential facts, AI usage/cost, support/impersonation, audit/outbox/action evidence, raw rows, and all mutation/execution behavior.

## Authority and runtime boundary

`hon.read_hq_school_directory(text)` is a `STABLE SECURITY DEFINER` function owned by a trusted migration role with `search_path=pg_catalog, hon`. It independently calls the existing `hon.resolve_hq_operator_scope(subject, 'hq.dashboard.view')` and accepts only live `HON_HQ_OWNER` or `HON_HQ_OPERATOR` grants. The resolver itself requires a current active `HUMAN_USER` principal.

`HON_HQ_SUPPORT`, school/organization staff, families, foreign identities, AI/service principals, automation/delegated/action identities, ambiguous or revoked grants, and forged tenant/source/action context fail closed. School authority is not converted into HQ authority.

The source tables (`organizations`, `schools`, and `organization_entitlements`) remain forced-RLS and function-only for `hon_runtime`: **no direct table or column privileges, including `SELECT`, remain**. Conventional tenant commands use only `hon.read_current_organization_entitlement()`, a no-argument, `STABLE SECURITY DEFINER` tier-only read bound to the transaction's current organization; missing, inactive, future, or expired entitlement yields no row. Transaction-time activation and statement-time expiry preserve fail-closed post-wait review checks. The runtime has non-grantable `EXECUTE`, no ownership or `BYPASSRLS`; `PUBLIC`, `anon`, `authenticated`, and `service_role` have neither function execution nor source access. The HQ directory still independently resolves HQ authority and retains its internal source reads. Forward-only migration `0130` removes `0129`'s historical entitlement-table exception without editing applied history; canonical Supabase setup (`010`), verification (`011`), and the JavaScript verifier enforce this function-only boundary.

`RuntimeDatabaseService.readHqSchoolDirectory` executes exactly that fixed parameterized function in `REPEATABLE READ READ ONLY` with local `statement_timeout='5s'`, `lock_timeout='3s'`, and disabled parameter error logging. The service repeats the existing HQ resolver before the database function repeats it again. It maps only redacted `401`, `403`, or `503` states.

The browser uses one fixed same-origin `GET`, with `credentials: 'same-origin'`, `cache: 'no-store'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, and a strict closed response-envelope reconstruction. `/hq/schools` is dynamic and no-index. Big-Button, Modern, and Classic modes change density only, never scope or fields.

## Explicit non-goals

This directory creates no audit/outbox record, provider/AI call, worker action, Action Engine proposal, payment operation, communication, support session, impersonation, or school mutation. It supplies no follow-on detail route.

## Local-only validation

The disposable fixture refuses remote, unmarked, production/live, provider, payment, messaging, external execution, and credential-bearing environments before it writes anything. It never prints generated credentials.

```bash
HON_HQ_SCHOOLS_VALIDATION_TARGET=postgresql://localhost:5432/hon_hq_schools_validation \
HON_HQ_SCHOOLS_ENV_FILE=/home/ubuntu/jobs/<job>/hq-schools-validation.env \
pnpm db:setup-hq-schools

# source only the generated private fixture env; do not print it
pnpm db:test-hq-schools
```

The fixture proves empty behavior, two organization/school ordering and exact minimization, owner/operator access, support/school/family/AI/delegated/action/foreign/revoked/forged-context denial, function metadata/ACL/grant-option posture, forced RLS/private sources, direct runtime source denial, and no table/audit/outbox effects. `pnpm db:verify-rls` additionally checks the shared runtime boundary.
