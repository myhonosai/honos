import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { createExclusiveValidationEnv } from './secure-validation-env.mjs';
import pg from 'pg';
const database='hon_champions_validation', owner='hon_champions_owner', runtime='hon_champions_runtime', marker='HON disposable Champions Club validation';
if (process.env.HON_CHAMPIONS_VALIDATION_TARGET !== `postgresql://localhost:5432/${database}`) throw new Error('Explicit exact disposable localhost target required.');
const allowed=new Set(['HON_CHAMPIONS_VALIDATION_TARGET','HON_CHAMPIONS_ENV_FILE']);
if(Object.keys(process.env).some(key=>!allowed.has(key)&&/^(?:DATABASE_URL|HON_RUNTIME_DATABASE_URL|OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key))) throw new Error('No existing database/provider credentials or execution switches permitted.');
const envFile=process.env.HON_CHAMPIONS_ENV_FILE;
if(!envFile||resolve(envFile)!==envFile||!envFile.startsWith('/home/ubuntu/jobs/')) throw new Error('Fresh private job env file required.');
const directory=await realpath(dirname(envFile)),jobs=await realpath('/home/ubuntu/jobs');
if(!directory.startsWith(jobs+'/')||directory!==dirname(envFile)) throw new Error('Unsafe credential directory.');
const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw new Error('Unsafe credential directory owner.');
try {await lstat(envFile);throw new Error('Credential output already exists.');}catch(error){if(error.code!=='ENOENT')throw error;}
const safe={PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??'/home/ubuntu',LANG:'C.UTF-8',PAGER:'cat'};
function psql(sql,db='postgres') {
 const result=spawnSync('sudo',['-u','postgres','psql','-X','-q','-P','pager=off','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-p','5432','-d',db],{input:sql,encoding:'utf8',env:safe});
 if(result.status!==0)throw new Error('Local setup failed; database credentials redacted.');
}
psql(`DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${database}' AND (pg_get_userbyid(datdba)<>'${owner}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM '${marker}')) THEN RAISE EXCEPTION 'Unrecognized database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${owner}','${runtime}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM '${marker}') THEN RAISE EXCEPTION 'Unrecognized roles'; END IF;
 END $$;
 DROP DATABASE IF EXISTS ${database} WITH (FORCE); DROP ROLE IF EXISTS ${runtime}; DROP ROLE IF EXISTS ${owner};`);
const ownerPassword=randomBytes(36).toString('base64url'),runtimePassword=randomBytes(36).toString('base64url');
psql(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
 CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
 GRANT ${runtime} TO ${owner} WITH INHERIT FALSE, SET TRUE;
 COMMENT ON ROLE ${owner} IS '${marker}'; COMMENT ON ROLE ${runtime} IS '${marker}';
 CREATE DATABASE ${database} OWNER ${owner}; COMMENT ON DATABASE ${database} IS '${marker}';
 REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${owner},${runtime};`);
const urls={DATABASE_URL:`postgresql://${owner}:${ownerPassword}@localhost:5432/${database}`,HON_RUNTIME_DATABASE_URL:`postgresql://${runtime}:${runtimePassword}@localhost:5432/${database}`};
createExclusiveValidationEnv({directory,filename:basename(envFile),directoryStat:stat,content:Object.entries(urls).map(([key,value])=>`export ${key}='${value}'`).join('\n')+'\n',environment:safe});
const client=new pg.Client({connectionString:urls.DATABASE_URL,ssl:false});
await client.connect();
try {
 const migrations=new URL('../migrations/',import.meta.url);
 await client.query('CREATE SCHEMA hon; CREATE TABLE hon.schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const filename of (await readdir(migrations)).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort()) {
  let sql=(await readFile(new URL(filename,migrations),'utf8')).replaceAll('hon_runtime',runtime);
  // Setup owner intentionally cannot change server logging; privileged canonical
  // reconciliation below applies the final logging and least-privilege posture.
  sql=sql.replace(/^\s*ALTER ROLE hon_[a-z0-9_]+_runtime SET log_parameter_max_length(?:_on_error)? = 0;\n/gm,'');
  await client.query(sql);
  await client.query('INSERT INTO hon.schema_migrations(filename) VALUES($1)',[filename]);
 }
} finally { await client.end(); }
const canonical=(await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime',runtime).replaceAll('FOR ROLE postgres',`FOR ROLE ${owner}`).replaceAll('DATABASE postgres',`DATABASE ${database}`);
psql(canonical,database);psql(canonical,database);
// The school-account authority envelope (0191 hon.lock_school_account_authority) takes SHARE ROW EXCLUSIVE ... NOWAIT on
// these tables by design. An autovacuum/autoanalyze worker holds SHARE UPDATE EXCLUSIVE, so on a freshly seeded disposable
// database it can turn a sequential, uncontended proof command into ACCOUNT_BUSY (55P03) at random. Proofs exercise busy
// deliberately with their own blockers; background maintenance is switched off for these tables in this fixture only.
psql(`ALTER TABLE hon.organizations SET (autovacuum_enabled=false); ALTER TABLE hon.schools SET (autovacuum_enabled=false);
 ALTER TABLE hon.users SET (autovacuum_enabled=false); ALTER TABLE hon.principals SET (autovacuum_enabled=false);
 ALTER TABLE hon.principal_role_grants SET (autovacuum_enabled=false); ALTER TABLE hon.hq_operator_grants SET (autovacuum_enabled=false);
 ALTER TABLE hon.family_access_grants SET (autovacuum_enabled=false); ALTER TABLE hon.roles SET (autovacuum_enabled=false);
 ALTER TABLE hon.role_permissions SET (autovacuum_enabled=false);`,database);
console.log('PASS: dedicated marked localhost Champions Club database migrated; canonical least-privilege grants applied twice. Credentials remain only in the fresh private job env file.');
