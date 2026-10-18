import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { createExclusiveValidationEnv } from './secure-validation-env.mjs';
import { flexibleBillingAccountsFixture, refuseFlexibleBillingAccountsExternalEnvironment } from './flexible-billing-accounts-local-guard.mjs';

refuseFlexibleBillingAccountsExternalEnvironment();
if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Clear inherited database URLs before disposable flexible billing-account setup.');
const { database, owner, runtime, descriptorKey } = flexibleBillingAccountsFixture;
const target = process.env.HON_FLEXIBLE_BILLING_ACCOUNTS_VALIDATION_TARGET;
const envFile = process.env[descriptorKey];
const marker = 'HON disposable flexible billing accounts validation';
if (target !== `postgresql://localhost:5432/${database}`) throw new Error(`Explicit localhost:5432/${database} target required; all other targets refused.`);
if (!envFile || !envFile.startsWith('/home/ubuntu/jobs/')) throw new Error('A private job-directory credential file is required.');
const normalizedEnvFile = resolve(envFile);
if (normalizedEnvFile !== envFile || basename(normalizedEnvFile) !== basename(envFile)) throw new Error('Credential file path must be normalized and may not traverse directories.');
const jobsRoot = await realpath('/home/ubuntu/jobs');
let envDirectory;
try { envDirectory = await realpath(dirname(normalizedEnvFile)); } catch { throw new Error('Credential-file parent directory must already exist beneath the private job root.'); }
if (!envDirectory.startsWith(`${jobsRoot}/`)) throw new Error('Credential-file parent directory must resolve beneath the private job root.');
const resolvedEnvFile = `${envDirectory}/${basename(normalizedEnvFile)}`;
if (resolvedEnvFile !== normalizedEnvFile) throw new Error('Credential-file path must not traverse a symlinked directory.');
const envDirectoryStat = await lstat(envDirectory);
if (!envDirectoryStat.isDirectory() || envDirectoryStat.isSymbolicLink() || envDirectoryStat.uid !== process.getuid() || (envDirectoryStat.mode & 0o777) !== 0o700) throw new Error('Credential-file parent directory must be owned mode 0700.');
try { await lstat(resolvedEnvFile); throw new Error('Credential-file output must be a fresh, non-symlink private file.'); } catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error; }
const safeProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/home/ubuntu', LANG: process.env.LANG ?? 'C.UTF-8' };
function psql(sql, db = 'postgres') {
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-p', '5432', '-d', db], { input: sql, encoding: 'utf8', env: safeProcessEnv });
  if (result.status !== 0) throw new Error('Local administrator setup failed (credentials redacted).');
}
function migrate(environment) {
  const result = spawnSync(process.execPath, [new URL('./migrate.mjs', import.meta.url).pathname], { env: environment, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Disposable migration failed (credentials redacted).');
  if (result.stdout.trim()) console.log(result.stdout.trim());
}

psql(`DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${database}' AND (pg_get_userbyid(datdba)<>'${owner}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM '${marker}')) THEN RAISE EXCEPTION 'Unrecognized database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${owner}','${runtime}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM '${marker}') THEN RAISE EXCEPTION 'Unrecognized roles'; END IF;
END $$;
DROP DATABASE IF EXISTS ${database} WITH (FORCE); DROP ROLE IF EXISTS ${runtime}; DROP ROLE IF EXISTS ${owner};`);
const ownerPassword = randomBytes(36).toString('base64url');
const runtimePassword = randomBytes(36).toString('base64url');
psql(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
GRANT ${runtime} TO ${owner} WITH INHERIT FALSE, SET TRUE;
COMMENT ON ROLE ${owner} IS '${marker}'; COMMENT ON ROLE ${runtime} IS '${marker}';
CREATE DATABASE ${database} OWNER ${owner}; COMMENT ON DATABASE ${database} IS '${marker}';
REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${owner},${runtime};`);
const urls = {
  DATABASE_URL: `postgresql://${owner}:${ownerPassword}@localhost:5432/${database}`,
  HON_RUNTIME_DATABASE_URL: `postgresql://${runtime}:${runtimePassword}@localhost:5432/${database}`,
};
const descriptorContent = [
  `export DATABASE_URL='${urls.DATABASE_URL}'`,
  `export HON_RUNTIME_DATABASE_URL='${urls.HON_RUNTIME_DATABASE_URL}'`,
  `export ${descriptorKey}='${resolvedEnvFile}'`,
  '',
].join('\n');
createExclusiveValidationEnv({ directory: envDirectory, filename: basename(resolvedEnvFile), directoryStat: envDirectoryStat, content: descriptorContent, environment: safeProcessEnv });
const migrationEnvironment = { ...safeProcessEnv, ...urls, [descriptorKey]: resolvedEnvFile };
migrate({ ...migrationEnvironment, HON_MIGRATION_STOP_AFTER: '0151_current_school_crm_intake_stages_read.sql' });

// These rows deliberately predate 0152. Two records tie on timestamp so the
// migration's `(created_at, id)` ordering—not insertion order—also has evidence.
psql(`INSERT INTO hon.organizations(id,legal_name,display_name) VALUES
 ('00000000-0000-4000-8000-000000000101','PRIVATE_BACKFILL_ORG','PRIVATE_BACKFILL_ORG');
INSERT INTO hon.schools(id,organization_id,name,slug) VALUES
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000101','PRIVATE_BACKFILL_SCHOOL','private-backfill-school');
INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES
 ('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102','Historic','Payer');
INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id,currency,created_at) VALUES
 ('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000103','USD','2020-01-01T00:00:00Z'),
 ('00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000103','USD','2020-01-01T00:00:00Z'),
 ('00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000103','EUR','2021-01-01T00:00:00Z');`, database);
migrate(migrationEnvironment);

const canonical = (await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8'))
  .replaceAll('hon_runtime', runtime).replaceAll('FOR ROLE postgres', `FOR ROLE ${owner}`).replaceAll('DATABASE postgres', `DATABASE ${database}`);
psql(canonical, database);
// The canonical baseline deliberately revokes every function grant; restore
// only 0152's fixed direct-human authority check, never IAM table access.
psql(`REVOKE ALL ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid),
  hon.lock_current_direct_human_billing_accounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid),
  hon.lock_current_direct_human_billing_accounts(uuid) FROM ${runtime};
GRANT EXECUTE ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid),
  hon.lock_current_direct_human_billing_accounts(uuid) TO ${runtime};`, database);
console.log('Disposable localhost flexible billing-account database created; migrations through 0152, deterministic legacy backfill, forced-RLS runtime reconciliation, and private mode-0600 credentials are ready.');
