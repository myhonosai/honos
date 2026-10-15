import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';

const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (process.env.HON_PARENT_JOURNEY_RESET !== 'LOCAL_DISPOSABLE_ONLY' || owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_parent_journey_validation' || owner.username !== 'hon_parent_journey_owner'
  || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_parent_journey_runtime') throw new Error('Exact disposable localhost Journey aliases and LOCAL_DISPOSABLE_ONLY opt-in required. Never remote or another database.');
const maintenance = new URL(owner); maintenance.pathname = '/postgres';
const admin = new pg.Client({ connectionString: maintenance.toString(), ssl: false });
await admin.connect();
try {
  const roles = (await admin.query("SELECT rolname,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname IN('hon_parent_journey_owner','hon_parent_journey_runtime')")).rows;
  const o = roles.find(x => x.rolname === owner.username), r = roles.find(x => x.rolname === runtime.username);
  if (!o?.rolsuper || !r?.rolcanlogin || ['rolsuper', 'rolbypassrls', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication'].some(k => r[k])) throw new Error('Preprovisioned isolated local trusted owner and restricted runtime required. No role posture is changed.');
  await admin.query('DROP DATABASE IF EXISTS hon_parent_journey_validation WITH (FORCE)');
  await admin.query('CREATE DATABASE hon_parent_journey_validation OWNER hon_parent_journey_owner');
} finally { await admin.end(); }
const client = new pg.Client({ connectionString: owner.toString(), ssl: false });
await client.connect();
try {
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort()) {
    await client.query((await readFile(new URL(name, directory), 'utf8')).replaceAll('hon_runtime', 'hon_parent_journey_runtime'));
  }
  await client.query((await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8')).replaceAll('hon_runtime', 'hon_parent_journey_runtime'));
} finally { await client.end(); }
console.log('Reset only hon_parent_journey_validation on localhost; applied all migrations and exact restricted runtime ACLs.');
