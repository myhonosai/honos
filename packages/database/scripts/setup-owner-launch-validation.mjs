import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { createExclusiveValidationEnv } from './secure-validation-env.mjs';
import { refuseOwnerLaunchExternalEnvironment } from './owner-launch-local-guard.mjs';

refuseOwnerLaunchExternalEnvironment();
if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Clear inherited database URLs before disposable owner_launch setup.');
const target = process.env.HON_OWNER_LAUNCH_VALIDATION_TARGET;
const envFile = process.env.HON_OWNER_LAUNCH_ENV_FILE;
const database = 'hon_owner_launch_validation', owner = 'hon_owner_launch_owner', runtime = 'hon_owner_launch_runtime';
const marker = 'HON disposable owner_launch validation';
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
if (!envDirectoryStat.isDirectory() || envDirectoryStat.isSymbolicLink() || envDirectoryStat.uid !== process.getuid()) throw new Error('Credential-file parent directory is unsafe.');
try { await lstat(resolvedEnvFile); throw new Error('Credential-file output must be a fresh, non-symlink private file.'); } catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error; }
const safeProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/home/ubuntu', LANG: process.env.LANG ?? 'C.UTF-8' };
function psql(sql, db = 'postgres') {
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-p', '5432', '-d', db], { input: sql, encoding: 'utf8', env: safeProcessEnv });
  if (result.status !== 0) throw new Error('Local administrator setup failed (credentials redacted).');
}
psql(`DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${database}' AND (pg_get_userbyid(datdba)<>'${owner}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM '${marker}')) THEN RAISE EXCEPTION 'Unrecognized database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${owner}','${runtime}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM '${marker}') THEN RAISE EXCEPTION 'Unrecognized roles'; END IF;
END $$;
DROP DATABASE IF EXISTS ${database} WITH (FORCE);
DROP ROLE IF EXISTS ${runtime}; DROP ROLE IF EXISTS ${owner};`);
const ownerPassword = randomBytes(36).toString('base64url'), runtimePassword = randomBytes(36).toString('base64url');
psql(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
GRANT ${runtime} TO ${owner} WITH INHERIT FALSE, SET TRUE;
ALTER ROLE ${owner} SET log_parameter_max_length=0; ALTER ROLE ${owner} SET log_parameter_max_length_on_error=0;
COMMENT ON ROLE ${owner} IS '${marker}'; COMMENT ON ROLE ${runtime} IS '${marker}';
CREATE DATABASE ${database} OWNER ${owner}; COMMENT ON DATABASE ${database} IS '${marker}';
REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${owner},${runtime};`);
const urls = { DATABASE_URL: `postgresql://${owner}:${ownerPassword}@localhost:5432/${database}`, HON_RUNTIME_DATABASE_URL: `postgresql://${runtime}:${runtimePassword}@localhost:5432/${database}` };
createExclusiveValidationEnv({ directory: envDirectory, filename: basename(resolvedEnvFile), directoryStat: envDirectoryStat, content: Object.entries(urls).map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n', environment: safeProcessEnv });
const migrate = spawnSync(process.execPath, [new URL('./migrate.mjs', import.meta.url).pathname], { env: { ...safeProcessEnv, ...urls }, encoding: 'utf8' });
if (migrate.status !== 0) throw new Error(`Disposable migration failed: ${migrate.stderr.replaceAll(ownerPassword, '[REDACTED]').replaceAll(runtimePassword, '[REDACTED]')}`);
console.log(migrate.stdout.trim());
// Some historical migrations conditionally grant to the globally named
// development role `hon_runtime`. This disposable fixture validates a distinct
// runtime alias, so remove only that legacy role's database-local rights before
// applying the canonical alias grant. This never touches another database.
psql(`DO $$ DECLARE object_identity text; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  REVOKE ALL ON DATABASE ${database} FROM hon_runtime;
  REVOKE ALL ON SCHEMA hon FROM hon_runtime;
  FOR object_identity IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM hon_runtime', object_identity);
  END LOOP;
  FOR object_identity IN SELECT c.oid::regclass::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND c.relkind IN('r','p','S','v','m','f') LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s FROM hon_runtime', object_identity);
  END LOOP;
  FOR object_identity IN SELECT format('%I.%I',n.nspname,t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='hon' AND t.typelem=0 AND t.typtype IN('b','d','e') LOOP
   EXECUTE format('REVOKE ALL ON TYPE %s FROM hon_runtime', object_identity);
  END LOOP;
 END IF;
END $$;`, database);
const canonical = (await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8')).replaceAll('hon_runtime', runtime).replaceAll('FOR ROLE postgres', `FOR ROLE ${owner}`).replaceAll('DATABASE postgres', `DATABASE ${database}`);
psql(canonical, database); psql(canonical, database);
console.log('Disposable localhost owner_launch database created; migrations and canonical least-privilege grants applied. Generated credentials remain only in the fresh private mode-0600 job env file.');
