import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
const target=process.env.HON_MARKETING_AI_VALIDATION_TARGET;
if(target!=='postgresql://localhost:5432/hon_marketing_ai_validation') throw new Error('Explicit localhost:5432/hon_marketing_ai_validation target required; all other targets refused.');
const envFile=process.env.HON_MARKETING_AI_ENV_FILE;
if(!envFile?.startsWith('/home/ubuntu/jobs/') || envFile.includes('..')) throw new Error('Private job-directory credential file required.');
const db='hon_marketing_ai_validation',owner='hon_marketing_ai_owner',runtime='hon_marketing_ai_runtime';
const psql=(sql,database='postgres')=>{const r=spawnSync('sudo',['-u','postgres','psql','-X','-q','-v','ON_ERROR_STOP=1','-d',database],{input:sql,encoding:'utf8'});if(r.status!==0)throw new Error('Local administrator setup failed (credentials redacted).');};
// Fixed names only. Refuse to overwrite databases/roles not bearing this fixture marker.
psql(`DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${db}' AND (pg_get_userbyid(datdba)<>'${owner}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM 'HON disposable marketing AI validation')) THEN RAISE EXCEPTION 'Unrecognized database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${owner}','${runtime}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM 'HON disposable marketing AI validation') THEN RAISE EXCEPTION 'Unrecognized roles'; END IF;
END $$;
DROP DATABASE IF EXISTS ${db} WITH (FORCE);
DROP ROLE IF EXISTS ${runtime}; DROP ROLE IF EXISTS ${owner};`);
const ownerPass=randomBytes(36).toString('base64url'),runtimePass=randomBytes(36).toString('base64url');
psql(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPass}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePass}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
GRANT ${runtime} TO ${owner} WITH INHERIT FALSE, SET TRUE;
COMMENT ON ROLE ${owner} IS 'HON disposable marketing AI validation'; COMMENT ON ROLE ${runtime} IS 'HON disposable marketing AI validation';
CREATE DATABASE ${db} OWNER ${owner}; COMMENT ON DATABASE ${db} IS 'HON disposable marketing AI validation';
REVOKE ALL ON DATABASE ${db} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db} TO ${owner},${runtime};`);
const urls={DATABASE_URL:`postgresql://${owner}:${ownerPass}@localhost:5432/${db}`,HON_RUNTIME_DATABASE_URL:`postgresql://${runtime}:${runtimePass}@localhost:5432/${db}`};
await mkdir(new URL('.',`file://${envFile}`).pathname,{recursive:true});
await writeFile(envFile,Object.entries(urls).map(([k,v])=>`export ${k}='${v}'`).join('\n')+'\n',{mode:0o600});
const migrate=spawnSync(process.execPath,[new URL('./migrate.mjs',import.meta.url).pathname],{env:{...process.env,...urls},encoding:'utf8'});
if(migrate.status!==0) throw new Error(`Disposable migration failed: ${migrate.stderr.replaceAll(ownerPass,'[REDACTED]').replaceAll(runtimePass,'[REDACTED]')}`);
console.log(migrate.stdout.trim());
const client=new pg.Client({connectionString:urls.DATABASE_URL,ssl:false});await client.connect();
try{
 const canonical=(await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime',runtime).replaceAll('FOR ROLE postgres','FOR ROLE '+owner).replaceAll('DATABASE postgres','DATABASE '+db);
 psql(canonical,db);psql(canonical,db);
 console.log('Disposable localhost database created; all migrations and re-runnable canonical 010 applied. Credentials saved privately, never printed.');
}finally{await client.end();}
