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
) {
  throw new Error('Explicit LOCAL_DISPOSABLE_ONLY reset and exact localhost Claire owner/runtime aliases are required. No remote or other database is permitted.');
}
if (providerEnvironment.length) {
  throw new Error(`Claire local validation refuses provider credentials, paid-call gates, or execution switches (${providerEnvironment.join(', ')}).`);
}

const maintenance = new URL(owner);
maintenance.pathname = '/postgres';
const admin = new pg.Client({ connectionString: maintenance.toString(), ssl: false });
await admin.connect();
try {
  const roles = (await admin.query(`SELECT rolname, rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
    FROM pg_roles WHERE rolname = ANY($1::text[])`, [[ownerRole, runtimeRole]])).rows;
  const migrationOwner = roles.find((role) => role.rolname === ownerRole);
  const restrictedRuntime = roles.find((role) => role.rolname === runtimeRole);
  if (!migrationOwner?.rolcanlogin || !migrationOwner.rolbypassrls
    || !restrictedRuntime?.rolcanlogin
    || ['rolsuper', 'rolbypassrls', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication'].some((key) => restrictedRuntime[key])) {
    throw new Error('Preprovisioned local BYPASSRLS migration owner and restricted non-inheriting runtime roles are required. This setup never creates, alters, or drops roles.');
  }
  const existing = (await admin.query(`SELECT pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker
    FROM pg_database WHERE datname = $1`, [database])).rows[0];
  if (existing && (existing.owner !== ownerRole || existing.marker !== marker)) {
    throw new Error('The fixed Claire validation database name is occupied by an unrecognized database; refusing to reset it.');
  }
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${ownerRole}`);
  await admin.query(`COMMENT ON DATABASE ${database} IS '${marker}'`);
} finally {
  await admin.end();
}

execFileSync(process.execPath, [new URL('./migrate.mjs', import.meta.url).pathname], { env: process.env, stdio: 'inherit' });
const client = new pg.Client({ connectionString: owner.toString(), ssl: false });
await client.connect();
try {
  await client.query(`GRANT USAGE ON SCHEMA hon TO ${runtimeRole}`);
} finally {
  await client.end();
}
console.log('Reset only marked hon_teaching_ai_validation on localhost and migrated using the guarded runtime-role alias. The restricted runtime receives schema usage plus migration-defined fixed functions only; no provider credential, gate, canonical default-privilege change, or remote target was accepted.');
