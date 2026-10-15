# Supabase Development Runtime Role Setup

Generate a password **locally** before opening the Supabase SQL Editor. Run the following on a trusted workstation and store the output immediately in your password manager:

```bash
node -e "console.log(require('node:crypto').randomBytes(36).toString('base64url'))"
```

The base64url output avoids quote characters, so it can be pasted directly into the `PASSWORD` literal in [010_supabase_hon_runtime.sql](../../infra/postgres/010_supabase_hon_runtime.sql). Do not commit the generated value, paste it into chat, or use the project’s privileged `postgres` password for HON runtime. Because any SQL Editor query containing a password can be retained in query history, execute the role-creation statement as a one-off, do not save the query with the password, and rotate the role password if the browser/device or query-history access is ever in doubt.

Run [010_supabase_hon_runtime.sql](../../infra/postgres/010_supabase_hon_runtime.sql) once in the Supabase SQL Editor. It creates `hon_runtime` with `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, and `NOREPLICATION`; removes explicit membership in known privileged roles; grants only `CONNECT`, `hon` schema usage, named minimum table rights on currently migrated tenant-operational tables (including **SELECT only** on `hon.ai_usage_ledger` for aggregate economics reads and on `invoices`/`payment_attempts` for aggregate operational-status counts), sequence usage, and the three tenant-context helper functions. It deliberately does not grant schema creation, DDL, extension installation, replication, broad function execution, access to the migration history table, global identity/IAM directory tables, or automatic rights on future objects. A later audited scope-resolver boundary will map verified identities to school scope without giving normal API/worker data-plane connections unrestricted identity-directory reads.

The current migration set includes that audited scope-resolver boundary: `hon.resolve_authorized_scope(external_subject, school_id, permission_code)`. It is a fixed-schema, fixed-query `SECURITY DEFINER` function with public execution revoked. The API validates a Manus session identity first, then calls this function through `hon_runtime`; the function derives principal, organization, school, active role grant, and required permission from HON IAM records. The route body can never choose an actor, organization, permission, or principal.

Supabase’s Session Pooler is the correct shared-pooler choice for an IPv4-only persistent backend and supports prepared statements. In the Supabase **Connect** dialog, choose **Session pooler** and use the exact host and port it provides (currently the Session Pooler form uses port `5432`). For a custom role, Supabase documents the pooled username as `hon_runtime.<project-ref>` rather than just `hon_runtime`; copy the complete supplied connection string instead of composing a hostname yourself. Insert the locally generated password, percent-encoding it only if your secret contains reserved URL characters. Base64url output normally avoids that issue. [2]

Set that copied Session Pooler URL through the pending protected `HON_RUNTIME_DATABASE_URL` input. Do not use `DATABASE_URL`: in this project it is migration-only. The application will use `pg.Pool` with explicit transactions; each tenant request calls PostgreSQL `set_config(..., true)` within its transaction, which prevents school context from surviving a pooled-connection checkout.

Then run [011_verify_supabase_hon_runtime.sql](../../infra/postgres/011_verify_supabase_hon_runtime.sql) in the SQL Editor. It proves the role flags, absence of explicit role memberships, expected grants (including SELECT-only AI-ledger, invoice, and payment-attempt access), forced RLS, and an empty read without tenant context. Finally, after the protected runtime URL is saved, run the project commands below from the HON workspace:

```bash
pnpm db:test-security
pnpm db:test-ai-usage
pnpm db:test-operations-report
```

Those integration checks use the actual runtime URL. They create temporary school scopes, prove the runtime role cannot read another school’s person, AI-usage ledger record, or operations-report inputs; prove the composite tenant foreign key rejects a cross-school relationship; verify SELECT-only AI-ledger, invoice, and payment-attempt access; verify aggregate operational-report accuracy; and verify tenant context clears at the transaction boundary. They leave no test records behind.

PostgreSQL role grants and RLS are complementary: table grants permit a role to attempt a statement, while each RLS policy constrains which rows it can access. Supabase recommends enabling RLS on exposed tables and notes that a table with RLS enabled but no policy denies all requests. HON applies forced RLS to its operational `hon` tables and establishes tenant context only inside an explicit transaction. [1] [3]

**References**

[1]: https://supabase.com/docs/guides/database/postgres/roles "Supabase Postgres Roles"
[2]: https://supabase.com/docs/guides/database/connecting-to-postgres "Supabase Connect to your database"
[3]: https://supabase.com/docs/guides/database/postgres/row-level-security "Supabase Row Level Security"
