import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for(const [key,role]of [['DATABASE_URL','hon_campaign_owner'],['HON_RUNTIME_DATABASE_URL','hon_campaign_runtime']]){
 if(!process.env[key])throw new Error('Explicit disposable URLs required.');const u=new URL(process.env[key]);if(u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/hon_campaign_validation'||u.username!==role)throw new Error('Only guarded localhost campaign roles/database allowed.');
}
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false});
const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_campaign_runtime');
const verify=()=>spawnSync(process.execPath,[new URL('./verify-rls.mjs',import.meta.url).pathname],{env:process.env,encoding:'utf8'});
await admin.connect();
try{
 const fresh=verify();assert.equal(fresh.status,0,fresh.stderr);await admin.query(canonical);await admin.query(canonical);
 for(const [name,apply,restore]of [
 ['PUBLIC command EXECUTE','GRANT EXECUTE ON FUNCTION hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC'],
 ['runtime helper EXECUTE','GRANT EXECUTE ON FUNCTION hon.campaign_summary(uuid) TO hon_campaign_runtime','REVOKE EXECUTE ON FUNCTION hon.campaign_summary(uuid) FROM hon_campaign_runtime'],
 ['runtime resolver grant option','GRANT EXECUTE ON FUNCTION hon.resolve_campaign_scope(text,text) TO hon_campaign_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.resolve_campaign_scope(text,text) FROM hon_campaign_runtime'],
 ['runtime private column SELECT','GRANT SELECT(source_facts) ON hon.crm_lead_attributions TO hon_campaign_runtime','REVOKE SELECT(source_facts) ON hon.crm_lead_attributions FROM hon_campaign_runtime'],
 ['PUBLIC private table SELECT','GRANT SELECT ON hon.marketing_campaign_versions TO PUBLIC','REVOKE SELECT ON hon.marketing_campaign_versions FROM PUBLIC'],
 ['unforced attribution RLS','ALTER TABLE hon.crm_lead_attributions NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.crm_lead_attributions FORCE ROW LEVEL SECURITY'],
 ['accidental campaign policy','CREATE POLICY campaign_negative_policy ON hon.marketing_campaign_requests USING(true)','DROP POLICY campaign_negative_policy ON hon.marketing_campaign_requests'],
 ]){await admin.query(apply);try{const probe=verify();assert.notEqual(probe.status,0,`${name}: JS verifier accepted unsafe drift`);await assert.rejects(()=>admin.query(canonical),/Unsafe campaign|RLS|Forbidden runtime/);console.log(`Denied unsafe campaign verifier drift: ${name}`);}finally{await admin.query('ROLLBACK');await admin.query(restore);}}
 const final=verify();assert.equal(final.status,0,final.stderr);await admin.query(canonical);
 assert.equal((await admin.query("SELECT count(*) n FROM pg_trigger WHERE tgrelid IN('hon.marketing_campaigns'::regclass,'hon.marketing_campaign_versions'::regclass,'hon.marketing_campaign_requests'::regclass,'hon.crm_lead_attributions'::regclass,'hon.crm_leads'::regclass) AND tgenabled='D'")).rows[0].n,'0','Cleanup must leave every production trigger enabled.');
 console.log('Campaign canonical 011 and verify-rls passed; seven negative ACL/RLS drift probes denied and restored, exact four runtime entry points/helpers, no lingering fixture trigger relaxations.');
}finally{await admin.query('ROLLBACK');await admin.end();}
