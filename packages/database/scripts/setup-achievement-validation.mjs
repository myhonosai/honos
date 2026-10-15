import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (process.env.HON_ACHIEVEMENT_RESET !== 'LOCAL_DISPOSABLE_ONLY' || owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_achievement_validation' || owner.username !== 'hon_achievement_owner'
  || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_achievement_runtime') throw new Error('Explicit LOCAL_DISPOSABLE_ONLY reset and exact localhost achievement aliases required. No remote or other database permitted.');
const maintenance = new URL(owner); maintenance.pathname = '/postgres';
const admin = new pg.Client({ connectionString: maintenance.toString(), ssl: false });
await admin.connect();
try {
  const roles = (await admin.query("SELECT rolname,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname IN('hon_achievement_owner','hon_achievement_runtime')")).rows;
  const o = roles.find(x => x.rolname === owner.username), r = roles.find(x => x.rolname === runtime.username);
  if (!o?.rolsuper || !r?.rolcanlogin || ['rolsuper', 'rolbypassrls', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication'].some(k => r[k])) throw new Error('Preprovisioned local trusted owner and restricted runtime roles required. No role posture will be modified.');
  await admin.query('DROP DATABASE IF EXISTS hon_achievement_validation WITH (FORCE)');
  await admin.query('CREATE DATABASE hon_achievement_validation OWNER hon_achievement_owner');
} finally { await admin.end(); }
execFileSync('node', [new URL('./migrate.mjs', import.meta.url).pathname], { env: process.env, stdio: 'inherit' });
const client = new pg.Client({ connectionString: owner.toString(), ssl: false }); await client.connect();
try {
  // Role is pre-existing and checked above: the canonical CREATE-role recovery is inert.
  const grants = (await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8')).replaceAll('hon_runtime', 'hon_achievement_runtime');
  await client.query(grants);
} finally { await client.end(); }
console.log('Reset only hon_achievement_validation on localhost; migrated and applied canonical restricted ACLs.');
