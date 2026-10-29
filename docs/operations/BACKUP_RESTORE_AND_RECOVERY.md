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
pg_dump --dbname "$DATABASE_URL" --schema=hon --format=custom --no-password \
  --file "hon-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Encrypt before it leaves the machine, e.g. age/gpg, then upload to off-site storage.
```

`pg_dump` must be the same major version as the server (PostgreSQL 16 or newer client).

## 3. Restore into an isolated environment (verification drill)

Automated proof: `packages/database/scripts/test-restore-drill.mjs` runs in CI as part of `.github/scripts/run-db-proofs.sh`. On a disposable fixture it:

1. writes a synthetic tenant, then fingerprints every `hon` table (row count + content hash), the migration ledger, effective ACLs of every relation and function, RLS/FORCE flags, policies, triggers, and the schema and database ACLs;
2. runs `pg_dump -Fc`;
3. **drops the database** (simulated total loss);
4. runs `pg_restore --create`;
5. requires identical fingerprints, then re-runs `verify-rls.mjs`, `test-platform-least-privilege.mjs` and `migration-status.mjs --require-current` on the restored database.

Local result 2026-10-28: 277 tables, 181 migrations, everything identical, all verifiers pass, 4.3 s on the fixture.

Production-shaped drill (owner-authorized, recommended monthly and before launch):

1. Create an **isolated** target: Supabase *restore to a new project*, or a throwaway PostgreSQL 16. Never restore over production.
2. On a fresh target, first create the roles: run `infra/postgres/010_supabase_hon_runtime.sql` and `012_supabase_hon_outbox_worker.sql` with new passwords.
3. `pg_restore --dbname "$TARGET_URL" --exit-on-error hon-YYYY….dump` (do not pass `--no-owner` or `--no-acl`: owners and grants carry the security model).
4. Verify, all against the target:
   - `pnpm db:status --require-current` → `PASS`
   - `pnpm db:verify-rls` → passes (forced RLS, least privilege, client roles)
   - `infra/postgres/011_verify_supabase_hon_runtime.sql` in a read-only session
   - row counts of the key tenant tables match the source at dump time (organizations, schools, people, memberships, invoices)
   - point a **staging** API at the target and check that `GET /v1/health/ready` returns 200
5. Record the result in the sign-off table (§7). Then delete the target and its credentials.

## 4. Failed database migration

Migrations are forward-only. Every file is one `BEGIN … COMMIT` transaction, enforced by `pnpm db:check`. The runner:

- refuses to start while another runner holds the advisory lock (`Another HON migration run holds the migration lock`);
- applies each pending file in order, then records it in `hon.schema_migrations`;
- stops at the first error.

| Situation | Effect | Recovery |
|---|---|---|
| A migration's SQL fails | That file's transaction rolls back. Earlier files stay applied and recorded. | Fix forward with a **new** migration file. Never edit an applied file: `pnpm db:check` fails if a checksum-locked file changes. Redeploy the previous app build if the new code needs the failed migration. |
| The process dies between a file's `COMMIT` and its ledger insert (rare) | Objects exist, but the ledger lacks the file. A re-run fails on "already exists". | Owner-reviewed manual step: confirm the file's objects exist as written, then `INSERT INTO hon.schema_migrations(filename) VALUES ('<file>')` as the migration owner. Re-run `pnpm db:status`. |
| Lock refused | Another run is active (or a crashed session still holds it). | Wait. Check `pg_stat_activity` for `application_name`/state, and only terminate a session you have confirmed is dead. |
| `db:status` shows **unknown applied** or **superseded CRM** history | The database was migrated by a different build. | Stop. Do not migrate or deploy. Needs an environment-specific reviewed baseline (see `docs/architecture/CRM_ADULT_DRAFT_MAIN_INTEGRATION.md`). |
| `db:status` shows **out-of-order pending** (for example reserved 0179/0180 landing after 0189) | The file runs after newer ones. | Its PR must state that it is order-independent before it is deployed. |
| Data damaged by a bad migration | | Restore to a new project at the point in time before the migration (PITR), or from the pre-migration logical dump. Verify (§3). Cut over (§5). |

**Before every production migration:** run `pnpm db:check` on the exact release checkout (fails if any checksum-locked migration file changed), take a layer-C dump, run `pnpm db:status` and review its output, and record the latest applied file. `db:migrate` itself trusts the filename ledger and does not re-verify file contents, so this preflight is mandatory.

## 5. Failed deployment rollback

There is no hosting configuration in the repository yet, so this is the procedure for whatever platform the owner chooses.

1. Each release is an immutable build of one git SHA. Record the SHA, the `db:status` result and the time.
2. Order: **migrate first, then deploy the app.** Every migration must stay compatible with the *previous* app build (additive, expand/contract), so you can roll the app back without rolling the database back.
3. Health gate: the new instance must return 200 on `GET /v1/health/ready` before it takes traffic. The platform must keep old instances until then.
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

| Check | Evidence | Result | Who / date |
|---|---|---|---|
| Disposable restore drill (CI) | `test-restore-drill.mjs` in run-db-proofs | PASS locally and in CI (manual dispatch) 2026-10-28 | Claude |
| Supabase plan, backup retention and PITR status recorded | Dashboard screenshot | NOT VERIFIED | Owner |
| Production logical dump taken and encrypted off-site | File name + checksum | NOT VERIFIED | Owner |
| Isolated restore of a production backup + §3 checks | Command output | NOT VERIFIED | Owner + Claude |
| Measured RTO / RPO | Timestamps | NOT VERIFIED | Owner |
| Rollback rehearsal on staging (deploy N+1, roll back to N) | Health checks | NOT VERIFIED (no hosting yet) | Owner |
