import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { attendanceBackfillFixture, refuseAttendanceBackfillExternalEnvironment } from './attendance-backfill-local-guard.mjs';
import { createExclusiveValidationEnv } from './secure-validation-env.mjs';

refuseAttendanceBackfillExternalEnvironment();
if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Clear inherited database URLs before disposable attendance backfill setup.');
if (process.env.HON_ATTENDANCE_BACKFILL_VALIDATION_TARGET !== attendanceBackfillFixture.target) throw new Error(`Explicit localhost:5432/${attendanceBackfillFixture.database} target required; all other targets are refused.`);
const envFile = process.env.HON_ATTENDANCE_BACKFILL_ENV_FILE;
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
function psql(sql, database = 'postgres') {
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-p', '5432', '-d', database], { input: sql, encoding: 'utf8', env: safeProcessEnv });
  if (result.status !== 0) throw new Error('Local administrator setup failed (credentials redacted).');
}
const { database, owner, runtime, marker } = attendanceBackfillFixture;
psql(`DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${database}' AND (pg_get_userbyid(datdba)<>'${owner}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM '${marker}')) THEN RAISE EXCEPTION 'Unrecognized database'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${owner}','${runtime}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM '${marker}') THEN RAISE EXCEPTION 'Unrecognized roles'; END IF;
END $$;
DROP DATABASE IF EXISTS ${database} WITH (FORCE);
DROP ROLE IF EXISTS ${runtime};
DROP ROLE IF EXISTS ${owner};`);
const ownerPassword = randomBytes(36).toString('base64url'), runtimePassword = randomBytes(36).toString('base64url');
psql(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
GRANT ${runtime} TO ${owner} WITH INHERIT FALSE, SET TRUE;
COMMENT ON ROLE ${owner} IS '${marker}';
COMMENT ON ROLE ${runtime} IS '${marker}';
CREATE DATABASE ${database} OWNER ${owner};
COMMENT ON DATABASE ${database} IS '${marker}';
REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${database} TO ${owner},${runtime};`);
const urls = { DATABASE_URL: `postgresql://${owner}:${ownerPassword}@localhost:5432/${database}`, HON_RUNTIME_DATABASE_URL: `postgresql://${runtime}:${runtimePassword}@localhost:5432/${database}` };
createExclusiveValidationEnv({ directory: envDirectory, filename: basename(resolvedEnvFile), directoryStat: envDirectoryStat, content: Object.entries(urls).map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n', environment: safeProcessEnv });
console.log('Marked disposable localhost attendance-backfill database and restricted roles created. Credentials were saved only in a fresh private mode-0600 job env file and were not printed.');
