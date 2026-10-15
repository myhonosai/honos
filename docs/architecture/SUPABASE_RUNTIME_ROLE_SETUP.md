# Supabase Development Runtime Role Setup

Generate a password **locally** before opening the Supabase SQL Editor. Run the following on a trusted workstation and store the output immediately in your password manager:

```bash
node -e "console.log(require('node:crypto').randomBytes(36).toString('base64url'))"
```

The base64url output avoids quote characters, so it can be pasted directly into the `PASSWORD` literal in [010_supabase_hon_runtime.sql](../../infra/postgres/010_supabase_hon_runtime.sql). Do not commit the generated value, paste it into chat, or use the project’s privileged `postgres` password for HON runtime. Because any SQL Editor query containing a password can be retained in query history, execute the role-creation statement as a one-off, do not save the query with the password, and rotate the role password if the browser/device or query-history access is ever in doubt.

Run [010_supabase_hon_runtime.sql](../../infra/postgres/010_supabase_hon_runtime.sql) once in the Supabase SQL Editor. It creates `hon_runtime` with `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, and `NOREPLICATION`; removes explicit membership in known privileged roles; grants only `CONNECT`, `hon` schema usage, named minimum table rights on currently migrated tenant-operational tables (including **SELECT only** on `hon.ai_usage_ledger` for aggregate economics reads and on `invoices`/`payment_attempts` for aggregate operational-status counts), sequence usage, and the three tenant-context helper functions. It deliberately does not grant schema creation, DDL, extension installation, replication, broad function execution, access to the migration history table, global identity/IAM directory tables, or automatic rights on future objects. A later audited scope-resolver boundary will map verified identities to school scope without giving normal API/worker data-plane connections unrestricted identity-directory reads.

The current migration set includes that audited scope-resolver boundary: `hon.resolve_authorized_scope(external_subject, school_id, permission_code)`. It is a fixed-schema, fixed-query `SECURITY DEFINER` function with public execution revoked. The API validates a HON-owned normalized session identity first (see [production authentication](PRODUCTION_AUTHENTICATION.md)), then calls this function through `hon_runtime`; the function derives principal, organization, school, active role grant, and required permission from HON IAM records. The route body can never choose an actor, organization, permission, or principal.

Supabase’s Session Pooler is the correct shared-pooler choice for an IPv4-only persistent backend and supports prepared statements. In the Supabase **Connect** dialog, choose **Session pooler** and use the exact host and port it provides (currently the Session Pooler form uses port `5432`). For a custom role, Supabase documents the pooled username as `hon_runtime.<project-ref>` rather than just `hon_runtime`; copy the complete supplied connection string instead of composing a hostname yourself. Insert the locally generated password, percent-encoding it only if your secret contains reserved URL characters. Base64url output normally avoids that issue. [2]

Set that copied Session Pooler URL through the pending protected `HON_RUNTIME_DATABASE_URL` input. Do not use `DATABASE_URL`: in this project it is migration-only. The application will use `pg.Pool` with explicit transactions; each tenant request calls PostgreSQL `set_config(..., true)` within its transaction, which prevents school context from surviving a pooled-connection checkout.

Then run [011_verify_supabase_hon_runtime.sql](../../infra/postgres/011_verify_supabase_hon_runtime.sql) in the SQL Editor. It proves the role flags, absence of explicit role memberships, expected grants (including the reviewed membership SELECT/INSERT/UPDATE lifecycle subset; SELECT-only AI-ledger and payment-attempt access), forced RLS, and an empty read without tenant context. Finally, after the protected runtime URL is saved, run the project commands below from the HON workspace:

```bash
pnpm db:test-security
pnpm db:test-ai-usage
pnpm db:test-operations-report
pnpm db:test-operations-summary
```

Those integration checks use the actual runtime URL. They create temporary school scopes, prove the runtime role cannot read another school’s person, AI-usage ledger record, or operations-report inputs; prove the composite tenant foreign key rejects a cross-school relationship; verify SELECT-only AI-ledger, invoice, and payment-attempt access; verify aggregate operational-report accuracy; and verify tenant context clears at the transaction boundary. They leave no test records behind.

PostgreSQL role grants and RLS are complementary: table grants permit a role to attempt a statement, while each RLS policy constrains which rows it can access. Supabase recommends enabling RLS on exposed tables and notes that a table with RLS enabled but no policy denies all requests. HON applies forced RLS to its operational `hon` tables and establishes tenant context only inside an explicit transaction. [1] [3]

**References**

[1]: https://supabase.com/docs/guides/database/postgres/roles "Supabase Postgres Roles"
[2]: https://supabase.com/docs/guides/database/connecting-to-postgres "Supabase Connect to your database"
[3]: https://supabase.com/docs/guides/database/postgres/row-level-security "Supabase Row Level Security"

## Decision-only AI planning grants (0054–0056)

After applying migrations, existing roles receive exact plan SELECT and fixed planning/access EXECUTE grants from the additive migrations; do not rerun role creation or grant broad HQ configuration access. The canonical runtime SQL and companion verifier include `hon.ai_invocation_plans`, `hon.plan_ai_invocation(uuid,jsonb,uuid,uuid,uuid)` and `hon.require_ai_invocation_plan_access()`. Plan INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, internal helper EXECUTE, direct HQ config/credential table grants, and actual AI-ledger mutations must remain false. Current invoice/membership conventional commands have their separately reviewed INSERT/UPDATE grants; this planner grants no billing rights.

Run `pnpm db:verify-rls` and `pnpm db:test-ai-plans` in addition to the full database suite. Planning integration fixtures and global provider state changes are rollback-only. No new environment key, credential or worker is required. Details: [AI Invocation Planning](AI_INVOCATION_PLANNING.md).

## Core multi-location summary grant (0058)

The additive migration grants only EXECUTE on `hon.read_organization_operations_summary(text,uuid,timestamptz,timestamptz)` to existing runtime roles; do not rerun role creation. PUBLIC/other-grantee execution and direct IAM, organization/school directory, HQ or CRM activity access must stay false. The controlled migration owner must bypass forced RLS; the runtime must not. The canonical SQL/verifiers include these checks. `pnpm db:test-operations-summary` proves live Core/Complete and effective school permission gates, exact authorized-school-only totals, revocation, no PII/raw records and READ ONLY execution. Details: [Core Multi-location Operations Summary](CORE_MULTI_LOCATION_OPERATIONS_SUMMARY.md).

## Human internal document boundary (0062–0064)

Existing deployments receive only EXECUTE on `hon.mutate_document(text,text,text,uuid,jsonb,text,uuid,uuid)` and `hon.read_documents(text,text,text,uuid,integer)` from the additive migrations. The five document tables, including private replay/evidence storage, require **forced deny-all RLS and no runtime/client table privileges**. Internal actor/family/immutability helper EXECUTE and PUBLIC/broad function ACLs remain false; trusted definer owner bypass must be true while runtime bypass is false. Do not rerun runtime role creation or grant document table access.

Configure exact `HON_PUBLIC_ORIGIN` for sensitive browser commands. No new provider key, SDK or worker is needed. Run `pnpm db:verify-rls` and `pnpm db:test-documents` with both protected admin/runtime URLs in addition to the full suite. The integrity test proves actual restricted runtime denial, a separately granted temporary non-bypass direct-RLS probe (rolled back), scoped human/parent authority, immutable publication/evidence, private replay storage, atomic evidence and no external/financial/AI/communication effects. Details and deferred legal/provider decision: [Human Document Acknowledgements](HUMAN_DOCUMENT_ACKNOWLEDGEMENTS.md).

## Conventional staff search (0065–0066)

Apply migrations normally; existing deployments receive only EXECUTE on `hon.search_school(text,uuid,uuid,text,text[],uuid)`. Do not rerun runtime role creation or add directory/HQ/document/secret table privileges. The fixed function requires a trusted RLS-bypass owner, exact active human `search.global` scope and closed display sources; the runtime remains non-superuser/non-bypass. The permission backfill upgrades only existing canonical system OWNER roles, never principal/school grants. This read has no plan upgrade gate and no Parent/Eian or HQ authority inheritance.

Run `pnpm db:test-search` and `pnpm db:verify-rls` with the two protected database URLs. No provider credential, SDK, service or worker is required. Runtime reads are explicit READ ONLY transactions with a 2-second local statement timeout. Configure infrastructure access logs to omit/redact search query strings. Details: [Deterministic Staff Search](DETERMINISTIC_STAFF_SEARCH.md).
