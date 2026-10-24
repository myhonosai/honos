import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { createExclusiveValidationEnv } from './secure-validation-env.mjs';
import { refuseCrmAdultMembershipDraftExternalEnvironment } from './crm-adult-membership-draft-local-guard.mjs';

const port = '55435';
const database = 'hon_crm_adult_membership_draft_validation';
const owner = 'hon_crm_adult_membership_draft_owner';
const runtime = 'hon_crm_adult_membership_draft_runtime';
const marker = 'HON disposable CRM adult membership draft validation';
const clusterMarker = 'HON isolated CRM adult membership draft PostgreSQL cluster';
refuseCrmAdultMembershipDraftExternalEnvironment();
if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Clear inherited database URLs before disposable CRM adult membership draft setup.');
const target = process.env.HON_CRM_ADULT_MEMBERSHIP_DRAFT_VALIDATION_TARGET;
const envFile = process.env.HON_CRM_ADULT_MEMBERSHIP_DRAFT_ENV_FILE;
const dataDirectory = process.env.HON_CRM_ADULT_MEMBERSHIP_DRAFT_PGDATA;
if (target !== `postgresql://127.0.0.1:${port}/${database}`) throw new Error(`Explicit 127.0.0.1:${port}/${database} target required; all other targets refused.`);
if (!envFile || !dataDirectory || !envFile.startsWith('/home/ubuntu/jobs/') || !dataDirectory.startsWith('/home/ubuntu/jobs/')) throw new Error('Private job-directory credential-file and PostgreSQL data-directory paths are required.');
const jobsRoot = await realpath('/home/ubuntu/jobs');
async function safeJobPath(path, label, requireMissing) {
  const normalized = resolve(path);
  if (normalized !== path || basename(normalized) !== basename(path)) throw new Error(`${label} path must be normalized and may not traverse directories.`);
  let parent;
  try { parent = await realpath(dirname(normalized)); } catch { throw new Error(`${label} parent must already exist beneath the private job root.`); }
  if (!parent.startsWith(`${jobsRoot}/`)) throw new Error(`${label} parent must resolve beneath the private job root.`);
  const resolved = `${parent}/${basename(normalized)}`;
  if (resolved !== normalized) throw new Error(`${label} path must not traverse a symlinked directory.`);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error(`${label} parent must be owned mode 0700.`);
  if (requireMissing) { try { await lstat(resolved); throw new Error(`${label} must be a fresh non-symlink path.`); } catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error; } }
  return { path: resolved, parentStat: stat };
}
const env = await safeJobPath(envFile, 'Credential file', true);
const cluster = await safeJobPath(dataDirectory, 'PostgreSQL data directory', true);
const safeProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/home/ubuntu', LANG: 'C.UTF-8' };
function command(binary, args, input) {
  const result = spawnSync(binary, args, { input, encoding: 'utf8', env: safeProcessEnv });
  if (result.status !== 0) throw new Error(`Isolated local PostgreSQL setup failed while running ${binary} (output withheld).`);
}
const initdb = process.env.HON_POSTGRES_INITDB ?? '/usr/lib/postgresql/16/bin/initdb';
const pgctl = process.env.HON_POSTGRES_PG_CTL ?? '/usr/lib/postgresql/16/bin/pg_ctl';
command(initdb, ['-D', cluster.path, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--no-locale', '--encoding=UTF8']);
const socketDirectory = `${cluster.path}/socket`;
await mkdir(socketDirectory, { mode: 0o700 });
// pg_ctl otherwise lets the daemon inherit this script's captured output pipe,
// which can keep spawnSync waiting after a successful start. The private log is
// inside the guarded disposable cluster and contains no generated credentials.
const logFile = `${cluster.path}/postgres.log`;
command(pgctl, ['-D', cluster.path, '-l', logFile, '-o', `-F -p ${port} -h 127.0.0.1 -k ${socketDirectory}`, '-w', 'start']);
function psql(sql, db = 'postgres') {
  command('/usr/bin/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', db], sql);
}
psql(`COMMENT ON DATABASE postgres IS '${clusterMarker}';
CREATE ROLE ${owner} LOGIN PASSWORD '${randomBytes(36).toString('base64url')}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;`);
// Generate independent runtime credentials once and leave both values solely in
// the private 0600 environment file. The administrator's migration URL is not
// emitted to stdout or source control.
const ownerPassword = randomBytes(36).toString('base64url');
const runtimePassword = randomBytes(36).toString('base64url');
psql(`ALTER ROLE ${owner} PASSWORD '${ownerPassword}';
CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
GRANT ${runtime} TO ${owner} WITH INHERIT FALSE, SET TRUE;
COMMENT ON ROLE ${owner} IS '${marker}'; COMMENT ON ROLE ${runtime} IS '${marker}';
CREATE DATABASE ${database} OWNER ${owner}; COMMENT ON DATABASE ${database} IS '${marker}';
REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${owner},${runtime};`);
const urls = { DATABASE_URL: `postgresql://${owner}:${ownerPassword}@127.0.0.1:${port}/${database}`, HON_RUNTIME_DATABASE_URL: `postgresql://${runtime}:${runtimePassword}@127.0.0.1:${port}/${database}` };
createExclusiveValidationEnv({ directory: dirname(env.path), filename: basename(env.path), directoryStat: env.parentStat, content: Object.entries(urls).map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n', environment: safeProcessEnv });
const migrate = spawnSync(process.execPath, [new URL('./migrate.mjs', import.meta.url).pathname], { env: { ...safeProcessEnv, ...urls }, encoding: 'utf8' });
if (migrate.status !== 0) throw new Error(`Disposable migration failed: ${migrate.stderr.replaceAll(ownerPassword, '[REDACTED]').replaceAll(runtimePassword, '[REDACTED]')}`);
console.log(migrate.stdout.trim());
const canonical = (await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8')).replaceAll('hon_runtime', runtime).replaceAll('FOR ROLE postgres', `FOR ROLE ${owner}`).replaceAll('DATABASE postgres', `DATABASE ${database}`);
psql(canonical, database); psql(canonical, database);
console.log('Fresh marked isolated CRM adult membership draft PostgreSQL fixture ready; credentials remain in the protected env file.');
