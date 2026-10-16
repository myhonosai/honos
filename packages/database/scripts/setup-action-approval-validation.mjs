import { randomBytes } from 'node:crypto';
import { chmod, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

const target = process.env.HON_ACTION_APPROVAL_VALIDATION_TARGET;
const envFile = process.env.HON_ACTION_APPROVAL_ENV_FILE;
const database = 'hon_approval_validation';
const owner = 'hon_approval_owner';
const runtime = 'hon_approval_runtime';
const marker = 'HON disposable action approval validation';
const setupSelectors = new Set(['HON_ACTION_APPROVAL_VALIDATION_TARGET', 'HON_ACTION_APPROVAL_ENV_FILE']);
const riskyEnvironment = Object.keys(process.env).filter((key) => !setupSelectors.has(key) && (/^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE_AI|GOOGLE_GENERATIVE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)_(?:.*(?:API_)?KEY|.*TOKEN|.*SECRET|.*PASSWORD|.*PAID.*|.*APPROV.*|.*LIVE.*|.*EXECUT.*|.*ENABLED.*)$/i.test(key)
  || /^(?:HON_)?(?:ACTION_ENGINE|ACTION|PROVIDER|PAYMENT|PAYMENTS|COMMUNICATION|MESSAGING|MESSAGE|DELIVERY|PUBLISH|CONSUMER|WORKER)_(?:.*(?:API_)?KEY|.*TOKEN|.*SECRET|.*PASSWORD|.*PAID.*|.*APPROV.*|.*LIVE.*|.*EXECUT.*|.*ENABLED.*)$/i.test(key)));

if (target !== `postgresql://localhost:5432/${database}`) {
  throw new Error(`Explicit localhost:5432/${database} target required; all other targets are refused.`);
}
if (riskyEnvironment.length) {
  throw new Error(`Action approval local validation refuses recognized provider/payment/messaging credentials, paid/live gates, or execution switches (${riskyEnvironment.join(', ')}).`);
}
if (!envFile || !envFile.startsWith('/home/ubuntu/jobs/')) {
  throw new Error('A private job-directory credential file is required.');
}

const normalizedEnvFile = resolve(envFile);
if (normalizedEnvFile !== envFile || basename(normalizedEnvFile) !== basename(envFile)) {
  throw new Error('Credential file path must be normalized and may not traverse directories.');
}
const jobsRoot = await realpath('/home/ubuntu/jobs');
let envDirectory;
try {
  envDirectory = await realpath(dirname(normalizedEnvFile));
} catch {
  throw new Error('Credential-file parent directory must already exist beneath the private job root.');
}
if (!envDirectory.startsWith(`${jobsRoot}/`)) {
  throw new Error('Credential-file parent directory must resolve beneath the private job root.');
}
const resolvedEnvFile = `${envDirectory}/${basename(normalizedEnvFile)}`;
if (resolvedEnvFile !== normalizedEnvFile) {
  throw new Error('Credential-file path must not traverse a symlinked directory.');
}
try {
  await lstat(resolvedEnvFile);
  throw new Error('Credential-file output must be a fresh, non-symlink private file.');
} catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code !== 'ENOENT') throw error;
}

const safeProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/home/ubuntu',
  LANG: process.env.LANG ?? 'C.UTF-8',
};
function psql(sql, db = 'postgres') {
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-p', '5432', '-d', db], { input: sql, encoding: 'utf8', env: safeProcessEnv });
  if (result.status !== 0) throw new Error('Local administrator setup failed (credentials redacted).');
}

psql(`DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${database}' AND (pg_get_userbyid(datdba)<>'${owner}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM '${marker}')) THEN RAISE EXCEPTION 'Unrecognized database'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${owner}','${runtime}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM '${marker}') THEN RAISE EXCEPTION 'Unrecognized roles'; END IF;
END $$;
DROP DATABASE IF EXISTS ${database} WITH (FORCE);
DROP ROLE IF EXISTS ${runtime};
DROP ROLE IF EXISTS ${owner};`);

const ownerPassword = randomBytes(36).toString('base64url');
const runtimePassword = randomBytes(36).toString('base64url');
psql(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
GRANT ${runtime} TO ${owner} WITH INHERIT FALSE, SET TRUE;
COMMENT ON ROLE ${owner} IS '${marker}';
COMMENT ON ROLE ${runtime} IS '${marker}';
CREATE DATABASE ${database} OWNER ${owner};
COMMENT ON DATABASE ${database} IS '${marker}';
REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${database} TO ${owner},${runtime};`);

const urls = {
  DATABASE_URL: `postgresql://${owner}:${ownerPassword}@localhost:5432/${database}`,
  HON_RUNTIME_DATABASE_URL: `postgresql://${runtime}:${runtimePassword}@localhost:5432/${database}`,
};
let credentialFileCreated = false;
try {
  const handle = await open(resolvedEnvFile, 'wx', 0o600);
  try {
    await handle.writeFile(Object.entries(urls).map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(resolvedEnvFile, 0o600);
  const metadata = await lstat(resolvedEnvFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error('Credential-file ownership or permissions are unsafe.');
  }
  credentialFileCreated = true;

  const migrated = spawnSync(process.execPath, [new URL('./migrate.mjs', import.meta.url).pathname], { env: { ...safeProcessEnv, ...urls }, encoding: 'utf8' });
  if (migrated.status !== 0) {
    throw new Error(`Disposable migration failed: ${migrated.stderr.replaceAll(ownerPassword, '[REDACTED]').replaceAll(runtimePassword, '[REDACTED]')}`);
  }
  console.log(migrated.stdout.trim());

  const canonical = (await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8'))
    .replaceAll('hon_runtime', runtime)
    .replaceAll('FOR ROLE postgres', `FOR ROLE ${owner}`)
    .replaceAll('DATABASE postgres', `DATABASE ${database}`);
  psql(canonical, database);
  psql(canonical, database);
  console.log('Disposable localhost Action Engine approval database created; migrations and re-runnable canonical least-privilege grants applied. Generated credentials remain only in the fresh private mode-0600 job env file.');
} catch (error) {
  if (credentialFileCreated) await unlink(resolvedEnvFile).catch(() => undefined);
  throw error;
}
