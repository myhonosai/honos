import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { createExclusiveValidationEnv } from './secure-validation-env.mjs';
import { refuseClassSessionsReadExternalEnvironment } from './class-sessions-read-local-guard.mjs';

refuseClassSessionsReadExternalEnvironment();
if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Clear inherited database URLs before disposable Class Sessions setup.');
const target = process.env.HON_CLASS_SESSIONS_READ_VALIDATION_TARGET;
const envFile = process.env.HON_CLASS_SESSIONS_READ_ENV_FILE;
const database = 'hon_class_sessions_read_validation', owner = 'hon_class_sessions_read_owner', runtime = 'hon_class_sessions_read_runtime';
const marker = 'HON disposable class sessions read validation';
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
function psql(sql, db = 'postgres') { const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-p', '5432', '-d', db], { input: sql, encoding: 'utf8', env: safeProcessEnv }); if (result.status !== 0) throw new Error('Local administrator setup failed (credentials redacted).'); }
psql(`DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${database}' AND (pg_get_userbyid(datdba)<>'${owner}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM '${marker}')) THEN RAISE EXCEPTION 'Unrecognized database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${owner}','${runtime}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM '${marker}') THEN RAISE EXCEPTION 'Unrecognized roles'; END IF;
END $$;
DROP DATABASE IF EXISTS ${database} WITH (FORCE); DROP ROLE IF EXISTS ${runtime}; DROP ROLE IF EXISTS ${owner};`);
const ownerPassword = randomBytes(36).toString('base64url'), runtimePassword = randomBytes(36).toString('base64url');
psql(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
GRANT ${runtime} TO ${owner} WITH INHERIT FALSE, SET TRUE;
COMMENT ON ROLE ${owner} IS '${marker}'; COMMENT ON ROLE ${runtime} IS '${marker}';
CREATE DATABASE ${database} OWNER ${owner}; COMMENT ON DATABASE ${database} IS '${marker}';
REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${owner},${runtime};`);
const urls = { DATABASE_URL: `postgresql://${owner}:${ownerPassword}@localhost:5432/${database}`, HON_RUNTIME_DATABASE_URL: `postgresql://${runtime}:${runtimePassword}@localhost:5432/${database}` };
createExclusiveValidationEnv({ directory: envDirectory, filename: basename(resolvedEnvFile), directoryStat: envDirectoryStat, content: Object.entries(urls).map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n', environment: safeProcessEnv });
const migrate = spawnSync(process.execPath, [new URL('./migrate.mjs', import.meta.url).pathname], { env: { ...safeProcessEnv, ...urls }, encoding: 'utf8' });
if (migrate.status !== 0) throw new Error(`Disposable migration failed: ${migrate.stderr.replaceAll(ownerPassword, '[REDACTED]').replaceAll(runtimePassword, '[REDACTED]')}`);
console.log(migrate.stdout.trim());
const canonical = (await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8')).replaceAll('hon_runtime', runtime).replaceAll('FOR ROLE postgres', `FOR ROLE ${owner}`).replaceAll('DATABASE postgres', `DATABASE ${database}`);
psql(canonical, database); psql(canonical, database);
// The generic canonical reconciliation intentionally knows no future narrow
// projection functions. Reassert only 0147's exact function-only boundary.
psql(`ALTER TABLE hon.class_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.class_sessions FORCE ROW LEVEL SECURITY;
REVOKE SELECT ON hon.class_sessions FROM PUBLIC,${runtime};
REVOKE ALL ON FUNCTION hon.require_current_school_class_sessions_read_actor(text) FROM PUBLIC,${runtime};
REVOKE ALL ON FUNCTION hon.read_current_school_class_sessions(text) FROM PUBLIC,${runtime};
GRANT EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) TO ${runtime};`, database);
console.log('Disposable localhost Class Sessions read database created; migrations and canonical least-privilege grants applied. Credentials remain only in the fresh private mode-0600 job env file.');
