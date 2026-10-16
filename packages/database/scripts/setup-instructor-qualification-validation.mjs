import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const target = process.env.HON_INSTRUCTOR_QUALIFICATION_VALIDATION_TARGET;
const envFile = process.env.HON_INSTRUCTOR_QUALIFICATION_ENV_FILE;
const database = 'hon_instructor_qualification_validation';
const owner = 'hon_instructor_qualification_owner';
const runtime = 'hon_instructor_qualification_runtime';
const marker = 'HON disposable instructor qualification validation';
const providerEnvironment = Object.keys(process.env).filter((key) => /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE_AI|GOOGLE_GENERATIVE)_(?:.*(?:API_)?KEY|.*TOKEN|.*SECRET|.*PASSWORD|.*PAID.*|.*APPROV.*|.*LIVE.*|.*EXECUT.*)$/i.test(key));

if (target !== `postgresql://localhost:5432/${database}`) {
  throw new Error(`Explicit localhost:5432/${database} target required; all other targets are refused.`);
}
if (!envFile?.startsWith('/home/ubuntu/jobs/') || envFile.includes('..')) {
  throw new Error('A private job-directory credential file is required.');
}
if (providerEnvironment.length) {
  throw new Error(`Instructor qualification local validation refuses provider credentials, paid-call gates, or execution switches (${providerEnvironment.join(', ')}).`);
}

function psql(sql, db = 'postgres') {
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db], { input: sql, encoding: 'utf8' });
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
await mkdir(new URL('.', `file://${envFile}`).pathname, { recursive: true });
await writeFile(envFile, Object.entries(urls).map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n', { mode: 0o600 });

const migrated = spawnSync(process.execPath, [new URL('./migrate.mjs', import.meta.url).pathname], { env: { ...process.env, ...urls }, encoding: 'utf8' });
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
console.log('Disposable localhost instructor qualification database created; migrations and re-runnable canonical least-privilege grants applied. Generated credentials remain only in the private job env file.');
