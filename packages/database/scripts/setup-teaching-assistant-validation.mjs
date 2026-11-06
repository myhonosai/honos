import pg from 'pg';
import { execFileSync } from 'node:child_process';

const owner = new URL(process.env.DATABASE_URL ?? '');
const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const database = 'hon_teaching_ai_validation';
const ownerRole = 'hon_teaching_ai_owner';
const runtimeRole = 'hon_teaching_ai_runtime';
const marker = 'HON disposable Claire teaching assistant validation';
const providerEnvironment = Object.keys(process.env).filter((key) => /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE_AI|GOOGLE_GENERATIVE)_(?:.*(?:API_)?KEY|.*TOKEN|.*SECRET|.*PASSWORD|.*PAID.*|.*APPROV.*|.*LIVE.*|.*EXECUT.*)$/i.test(key));

if (
  process.env.HON_TEACHING_AI_RESET !== 'LOCAL_DISPOSABLE_ONLY'
  || owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== `/${database}` || owner.username !== ownerRole
  || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== runtimeRole
) throw new Error('Explicit LOCAL_DISPOSABLE_ONLY reset and exact localhost Claire owner/runtime aliases are required. No remote or other database is permitted.');
if (providerEnvironment.length) throw new Error(`Claire local validation refuses provider credentials, paid-call gates, or execution switches (${providerEnvironment.join(', ')}).`);

const psql = (sql, db = 'postgres') => execFileSync('sudo', ['-u', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db], { input: sql, encoding: 'utf8' });
psql(`DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${ownerRole}' AND rolcanlogin AND NOT rolsuper AND rolbypassrls AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
     OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${runtimeRole}' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) THEN
    RAISE EXCEPTION 'Preprovisioned local BYPASSRLS migration owner and restricted non-inheriting runtime roles are required.';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${database}' AND (pg_get_userbyid(datdba)<>'${ownerRole}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM '${marker}')) THEN
    RAISE EXCEPTION 'The fixed Claire validation database name is occupied by an unrecognized database; refusing to reset it.';
  END IF;
END $$;
DROP DATABASE IF EXISTS ${database} WITH (FORCE);
CREATE DATABASE ${database} OWNER ${ownerRole};
COMMENT ON DATABASE ${database} IS '${marker}';
REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${database} TO ${ownerRole},${runtimeRole};`);

execFileSync(process.execPath, [new URL('./migrate.mjs', import.meta.url).pathname], { env: process.env, stdio: 'inherit' });
const client = new pg.Client({ connectionString: owner.toString(), ssl: false });
await client.connect();
try {
  await client.query(`GRANT USAGE ON SCHEMA hon TO ${runtimeRole}`);
  await client.query(`GRANT EXECUTE ON FUNCTION hon.list_my_teaching_invocations(text) TO ${runtimeRole}`);
  await client.query(`GRANT EXECUTE ON FUNCTION hon.list_teaching_assistant_curricula(text) TO ${runtimeRole}`);
} finally { await client.end(); }
console.log('Reset only marked hon_teaching_ai_validation on localhost using local postgres for database lifecycle and the restricted runtime for no capability beyond migration-defined fixed functions. No provider credential, gate, canonical default-privilege change, or remote target was accepted.');
