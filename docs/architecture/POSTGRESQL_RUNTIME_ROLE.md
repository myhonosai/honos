# HON PostgreSQL Runtime Role Boundary

## Purpose

HON uses two deliberately separate PostgreSQL connection classes:

| Connection class | Uses | Required posture |
|---|---|---|
| **Migration/admin connection** | Applying reviewed migrations, establishing schemas/extensions, emergency database administration | Privileged only for migration/deployment operations; never used by the API process or worker processes. |
| **Runtime connection** | HON API, worker/outbox dispatcher, scheduled work, tenant-scoped reads and writes | `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`; the only connection eligible for normal application processes. |

The platform secret `DATABASE_URL` is therefore migration-only. `HON_RUNTIME_DATABASE_URL` is the required application runtime secret. A service must fail readiness rather than fall back to `DATABASE_URL`.

## Runtime role requirements

The runtime role receives only the schema and table/sequence/function privileges required by HON. It does not own HON tables, cannot alter RLS policy, cannot create roles/databases/extensions, and cannot bypass RLS. School-bound reads and business commands run through `withTenantTransaction`, which invokes `set_config(..., true)` and `hon.require_tenant_context()` inside a transaction. Separately audited identity/control-plane resolvers and the read-only organization operations projection use only their fixed SECURITY DEFINER functions; they never widen tenant RLS or expose directories to normal runtime.

The normal tenant runtime role has **SELECT/INSERT only** on `hon.audit_events` and `hon.outbox_events`; matching RLS policies allow only scoped reads and appends. It cannot update or delete audit evidence or outbox history. A later independently reviewed dispatcher capability will claim/publish delivery state without broadening the tenant request role.

> A runtime connection that is superuser or has `BYPASSRLS` is a deployment blocker. It can defeat the tenant-isolation design even when table RLS is enabled and forced.

## Provisioning sequence

1. The migration connection applies the latest committed migrations.
2. A DBA or deployment secret manager creates a distinct login role and generates its password outside source control.
3. The DBA grants only necessary `USAGE`, table DML, sequence, and execute privileges to that role.
4. The application stores the resulting PostgreSQL URL only as `HON_RUNTIME_DATABASE_URL` in protected deployment configuration.
5. The security-boundary test verifies the role is non-superuser/non-`BYPASSRLS`, scoped reads hide another tenant's data, composite tenant foreign keys reject cross-tenant relationships, and transaction context clears after completion.

## Why the API cannot use the migration URL

The Action Engine’s safety chain depends on PostgreSQL enforcing the same school scope that the API calculated. A privileged connection could inspect or mutate rows outside that scope and turn a coding error, compromised tool, or provider adapter defect into a cross-tenant incident. Keeping the migration connection out of runtime is therefore a hard architecture rule, not a deployment preference.

## Supabase development database

For the Supabase development database, execute `infra/postgres/010_supabase_hon_runtime.sql` through the Supabase SQL Editor, then run `infra/postgres/011_verify_supabase_hon_runtime.sql`. The complete password-handling, Session Pooler, grant, and verification procedure is in `SUPABASE_RUNTIME_ROLE_SETUP.md`. The application uses the Session Pooler URL only through the protected `HON_RUNTIME_DATABASE_URL` value; the migration URL remains out of application runtime.

## AI planning minimum

`hon.ai_invocation_plans` has forced tenant SELECT RLS and SELECT-only runtime privileges; the immutable plan table is never directly writable by runtime. `plan_ai_invocation(uuid,jsonb,uuid,uuid,uuid)` and `require_ai_invocation_plan_access()` are the only new fixed SECURITY DEFINER EXECUTE grants. They repeat live human/exact permission/active Complete gates; the planner manually scopes the locked durable item and consumes HQ approval metadata internally, returning a sanitized choice/no-choice. Internal validators/summary/trigger functions and every HQ provider/config table remain inaccessible. No actual AI-ledger writes or outbox consumer capability is added. Run `pnpm db:test-ai-plans` and `pnpm db:verify-rls`; see [AI Invocation Planning](AI_INVOCATION_PLANNING.md).

## Core multi-location read minimum

Migration 0058 grants only `hon.read_organization_operations_summary(text,uuid,timestamptz,timestamptz)` EXECUTE to runtime, with PUBLIC revoked and a fixed safe search path. It resolves the verified active human, effective `reporting.view` school grants and active Core/Complete entitlement in a single statement snapshot, returning only those schools' aggregates. No new runtime table grants, directory/HQ access, RLS changes or writes are introduced. Canonical verifiers check STABLE/definer/owner posture and owner/runtime-only ACL. Run `pnpm db:test-operations-summary`; see [Core Multi-location Operations Summary](CORE_MULTI_LOCATION_OPERATIONS_SUMMARY.md).
