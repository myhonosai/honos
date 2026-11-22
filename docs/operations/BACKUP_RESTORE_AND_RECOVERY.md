# Backup, restore, migration recovery and rollback

Status: **procedures and a disposable-database drill are proven; production backups and restores are NOT verified.** No live database was accessed. Every production step below needs explicit owner authorization at the time.

## 1. Backup layers

| Layer | What | Who | Status |
|---|---|---|---|
| A. Supabase daily backups | Pro: last 7 days, Team: 14, Enterprise: up to 30. Free plan has none. | Supabase | Plan and retention for the HON project NOT VERIFIED |
| B. Supabase PITR (add-on) | Second-level recovery, WAL every ~2 min (worst-case RPO about 2 min). 7/14/28 days ≈ $100/$200/$400 per month, needs at least Small compute. Enabling PITR replaces daily backups. | Owner decision (paid) | Not enabled as far as we know |
| C. HON logical export | `pg_dump -Fc` of the database to encrypted off-site storage, at least daily before launch and before every migration. Covers provider/account loss and gives a file you can test-restore anywhere. | Owner/ops | Procedure proven on a disposable DB (§3) |

Supabase facts above are from its backups and SSL documentation and its "restore to a new project" post (Dec 2024, public alpha), read on 2026-10-28. Recheck them before you rely on them.

Important provider limits:
- Daily backups **do not store passwords for custom roles.** After any provider restore, reset `hon_runtime` and `hon_outbox_worker` passwords (`infra/postgres/010_*`), then update `HON_RUNTIME_DATABASE_URL`.
- Storage API objects are not in database backups. HON stores no Storage API objects today. Re-check this if that changes.
- A dashboard restore makes the project inaccessible while it runs. **Restore to a new project** (paid plans, physical backups) creates an independent project. Use it for drills and for any recovery where you are unsure.

**Recommended targets (owner decision):** RPO ≤ 24 h before the first paying school, then PITR for RPO ≤ 5 min once schools depend on it daily. RTO ≤ 4 h. Keep layer C off-site with 30-day retention.

## 2. Logical backup (layer C)

Run from a trusted machine or job, never from the API process. Use the **direct** connection string and the migration owner, or a dedicated read-only role with SELECT on every `hon` object.

```bash
# PGSSLMODE/PGSSLROOTCERT make pg_dump verify the server like HON does.
export PGSSLMODE=verify-full PGSSLROOTCERT=/secure/prod-ca-2021.crt
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
pg_dump --dbname "$DATABASE_URL" --schema=hon --format=custom --no-password --file "hon-$stamp.dump"
# The dump holds schema hon only. Record what it depends on but does not contain, next to the dump:
psql "$DATABASE_URL" -X -At -c "SELECT extname, extnamespace::regnamespace, extversion FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1" > "hon-$stamp.extensions.txt"
# Encrypt both before they leave the machine, e.g. age/gpg, then upload to off-site storage.
```

`pg_dump` must be the same major version as the server (PostgreSQL 16 or newer client).

What a `--schema=hon` dump does **not** carry, so a fresh target must get it first (§3):
- the extensions HON uses (`pgcrypto`, `citext`). Their objects live outside `hon` (for example `public.citext`), so the restore fails without them;
- the four login roles (`hon_runtime`, `hon_outbox_worker`, `hon_communication_worker`, `hon_automation_worker`), their database `CONNECT`, `search_path` and logging settings. The dump carries every grant **to** them, so the restore fails while they are missing.

## 3. Restore into an isolated environment (verification drill)

Two automated proofs run in CI as part of `.github/scripts/run-db-proofs.sh`:

- `packages/database/scripts/test-restore-drill.mjs` (same-cluster loss). On a disposable fixture it writes a synthetic tenant, fingerprints every `hon` table (row count + content hash), the migration ledger, effective ACLs of every relation and function, RLS/FORCE flags, policies, triggers and the schema and database ACLs, runs `pg_dump -Fc`, **drops the database**, runs `pg_restore --create`, requires identical fingerprints, then re-runs `verify-rls.mjs`, `test-platform-least-privilege.mjs` and `migration-status.mjs --require-current`.
- `packages/database/scripts/test-restore-fresh-target-drill.mjs` (**fresh target**, the steps below, launch-readiness review [23]). It creates two private throwaway clusters. The source gets every migration, then the canonical `010`/`012`/`013`/`014` provisioning with the real role names and a synthetic organization. It dumps with the exact §2 command. On the brand-new target it first shows that the old order fails (`010` before the restore; a restore before the extensions or the roles), each time leaving the target untouched. Then it runs steps 2 to 5 below and requires identical data, ledger, effective relation/function/type/database ACLs, RLS, policies, triggers, extensions and login-role attributes, both right after the restore and after the `010` reconcile. `011` must pass in a read-only session, the runtime must log in with its **new** password (the source password is refused) and still has no direct table read.

Production-shaped drill or real recovery (owner-authorized, recommended monthly and before launch):

1. Create an **isolated** target: Supabase *restore to a new project*, or a throwaway PostgreSQL 16. Never restore over production. (A Supabase "restore to a new project" is a physical copy that already has the roles and extensions: skip steps 2 to 4 and only reset the role passwords, see §1. The steps below are for restoring a layer-C dump.)
2. Create the source's extensions in the same schemas, from `hon-….extensions.txt`, for example:
   ```sql
   CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;  -- use the schema the file names (Supabase: often "extensions")
   CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
   ```
3. Create the roles: run `infra/postgres/009_restore_target_roles.sql` as the target administrator with four **new** passwords. It refuses a target that already has schema `hon` or any HON login role. Do **not** run `010`/`012`/`013`/`014` yet: they reconcile grants on `hon` objects that do not exist yet, and `012`–`014` refuse an existing role.
4. Restore in one transaction, keeping owners and grants (do not pass `--no-owner` or `--no-acl`):
   ```bash
   pg_restore --dbname "$TARGET_URL" --exit-on-error --single-transaction --no-password hon-YYYY….dump
   ```
   A failure rolls back completely, so fix the cause (usually step 2 or 3) and run it again.
5. Reconcile and verify, all against the target:
   - run `infra/postgres/010_supabase_hon_runtime.sql` (with the new runtime password in its placeholder; on an existing role it only reconciles grants). On a correct restore it changes nothing;
   - `infra/postgres/011_verify_supabase_hon_runtime.sql` in a read-only session → no error;
   - `pnpm db:status --require-current` → `PASS`
   - `pnpm db:verify-rls` → passes (forced RLS, least privilege, client roles)
   - row counts of the key tenant tables match the source at dump time (organizations, schools, people, memberships, invoices)
   - point a **staging** API at the target and check that `GET /v1/health/ready` returns 200
6. Record the result in the sign-off table (§7). Then delete the target and its credentials.

## 4. Failed database migration

Migrations are forward-only. Every file is one `BEGIN … COMMIT` transaction, enforced by `pnpm db:check`. The runner:

- refuses to start while another runner holds the advisory lock (`Another HON migration run holds the migration lock`);
- applies each pending file in order and records it in `hon.schema_migrations` **inside that file's own transaction** (the in-memory text drops only the file's final `COMMIT;`, writes the ledger row, then commits both; the file bytes are unchanged);
- stops at the first error.

| Situation | Effect | Recovery |
|---|---|---|
| A migration's SQL fails | That file's transaction rolls back. Earlier files stay applied and recorded. | Fix forward with a **new** migration file. Never edit an applied file: `pnpm db:check` fails if a checksum-locked file changes. Redeploy the previous app build if the new code needs the failed migration. |
| The process dies while a file is applying | The file's changes and its ledger row commit together, so either both exist or neither does. A re-run applies the file again from the start. | Re-run `pnpm db:migrate`, then `pnpm db:status`. No manual ledger step. (Older runners committed the file before the ledger insert; a database migrated by one of them can still show that gap, and needs the owner-reviewed manual step: confirm the objects exist as written, then insert the ledger row as the migration owner.) |
| Lock refused | Another run is active (or a crashed session still holds it). | Wait. Check `pg_stat_activity` for `application_name`/state, and only terminate a session you have confirmed is dead. |
| `db:status` shows **unknown applied** or **superseded CRM** history | The database was migrated by a different build. | Stop. Do not migrate or deploy. Needs an environment-specific reviewed baseline (see `docs/architecture/CRM_ADULT_DRAFT_MAIN_INTEGRATION.md`). |
| `db:status` shows **out-of-order pending** (for example reserved 0179/0180 landing after 0189) | The file runs after newer ones. | Its PR must state that it is order-independent before it is deployed. |
| Data damaged by a bad migration | | Restore to a new project at the point in time before the migration (PITR), or from the pre-migration logical dump. Verify (§3). Cut over (§5). |

**Before every production migration:** run `pnpm db:check` on the exact release checkout (fails if any checksum-locked migration file changed), take a layer-C dump, run `pnpm db:status` and review its output, and record the latest applied file. `db:migrate` itself trusts the filename ledger and does not re-verify file contents, so this preflight is mandatory.

## 5. Failed deployment rollback

Hosting is Render + Supabase Pro (`render.yaml`, `docs/operations/RENDER_DEPLOYMENT.md`, decided 2026-11-09); the steps below are platform-neutral and apply there.

1. Each release is an immutable build of one git SHA. Record the SHA, the `db:status` result and the time.
2. Order: **migrate first, then deploy the app.** Every migration must stay compatible with the *previous* app build (additive, expand/contract), so you can roll the app back without rolling the database back.
3. Health gate: the new instance must return 200 on `GET /v1/health/ready` before it takes traffic. The platform must keep old instances until then. On Render the gate is the web health check `GET /api/readiness`, which asks the private API's `/v1/health/ready` (Render has no HTTP health check for private services). So a new web instance takes traffic only while the API and its database are ready, and during an API or database outage Render reports `hon-web` unhealthy too.
4. Roll back the app by redeploying the previous SHA. That needs no database action, by rule 2.
5. Roll back the database only by restoring (§4 last row) and only with owner approval, because restoring discards writes made after the restore point.
6. Configuration rollback: the TLS and startup gate changes are configuration-only. Redeploy the previous SHA if a new gate refuses to start. The refusal message names the failing code.

### Application / database version compatibility

| App build needs | Database has | Result |
|---|---|---|
| migrations ≤ N | N | Supported. |
| migrations ≤ N | N+k (newer, additive) | Supported by the expand/contract rule (this makes rollback possible). |
| migrations ≤ N | < N | **Not supported.** `db:status --require-current` must pass before deploying. |

## 6. Incident response

1. **Detect:** an alert fires (see `MONITORING_AND_ALERTING.md`) or a user reports a support reference (`hon-…` diagnostic id or web digest).
2. **Triage (15 min):** search logs for the diagnostic id or digest. Classify: SEV1 = data exposure, cross-tenant access, payment integrity, or full outage. SEV2 = a major feature down. SEV3 = degraded.
3. **Contain:** for suspected data exposure, revoke the credential involved (rotate the `hon_runtime` password or session secret), and apply the Supabase containment steps in `/mnt/project-files/supabase-audit/REMEDIATION_PLAN.md` P0 if relevant. For a bad release, roll back (§5).
4. **Preserve evidence:** export the relevant logs, `db:status` and `pg_stat_activity`, read-only. Do not "clean up" before you have them.
5. **Communicate:** the owner decides on customer and regulatory notification. Do not post details in public channels.
6. **Recover and verify:** use §3/§5 checks. `verify-rls` must pass after any database recovery.
7. **Review within 5 business days:** timeline, root cause, a regression test that would have caught it, and follow-ups.

## 7. Recovery verification and sign-off

### Canonical-main integration record (PR #89)

PR #89 is reconciled with main `92bba0359c5e0dceeb0565b0b1e892828b1481c1`, containing merged A2P 0190 and school-owner invitation 0191. The source-side `migration-checksums.json` now pins all **183** canonical files. The existing `verify-migrations.mjs --record-new` mechanism appended only those two previously unrecorded entries; all 181 earlier pins and every SQL byte remain unchanged. Reserved 0179/0180 remain absent. This is derived repository evidence, not a change to a database migration ledger or approval to apply SQL.

The commercial staging manifest remains the merged main's independently generated 183-file chain (11 targets through 0191). The restore drill fingerprints the actual table inventory and full filename ledger, including the private invitation tables and A2P scope; historical 277-table/181-migration results above are not fresh combined-head evidence. New CI results and exact commit belong in the PR report. Draft-safe workflow paths include shared TLS/runtime/telemetry changes so the existing invitation browser/API proofs and commercial rehearsals run without changing PR readiness.

The mandatory release-checkout `db:check` and reviewed `db:status` preflight remain necessary: the migrator still uses the filename-only applied ledger. Real Supabase CA/pooler verification, production backup/restore, approved environment/logging configuration and reader-first verified-email rollout remain separate deployment gates. No retained database, credential, provider, account, financial, trial or AI activation is performed by this source integration.

| Check | Evidence | Result | Who / date |
|---|---|---|---|
| Disposable restore drill (CI) | `test-restore-drill.mjs` in run-db-proofs | PASS locally and in CI (manual dispatch) 2026-10-28 | Claude |
| Fresh-target restore drill (CI) | `test-restore-fresh-target-drill.mjs` in run-db-proofs | PASS locally 2026-11-22 (581 tables, 381 migrations, about 20 s) | Claude |
| Supabase plan, backup retention and PITR status recorded | Dashboard screenshot | NOT VERIFIED | Owner |
| Production logical dump taken and encrypted off-site | File name + checksum | NOT VERIFIED | Owner |
| Isolated restore of a production backup + §3 checks | Command output | NOT VERIFIED | Owner + Claude |
| Measured RTO / RPO | Timestamps | NOT VERIFIED | Owner |
| Rollback rehearsal on staging (deploy N+1, roll back to N) | Health checks | NOT VERIFIED (no hosting yet) | Owner |
