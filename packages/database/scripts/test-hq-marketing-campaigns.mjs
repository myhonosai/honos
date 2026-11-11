import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// M1 HQ marketing campaigns (0252) integrity proof, TEST MODE, disposable database only. It proves: only a current HQ owner,
// or an HQ operator holding hq.marketing.manage, writes HQ campaigns, and hq.marketing.read only reads (support grants,
// billing operators, lapsed owners, school owners and unknown subjects are refused); the runtime can execute only the five
// entry points and has no table privilege; create/update/status are idempotent by actor and key and refuse key reuse; codes
// are unique; updates and status moves need the current version; only the allowed status moves happen and ARCHIVED is final;
// an unchanged update is refused; history is immutable and complete; the list filters, pages and summarizes exactly; reads
// write nothing; no school campaign row is touched; a person revoked meanwhile gets nothing.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|ZERNIO|META|GOOGLE|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {HqMarketingService}=await import('../../../apps/api/dist/hq-marketing/hq-marketing.service.js');
const {encodeHqMarketingCursor}=await import('@hon/contracts');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),marketing=new HqMarketingService(billing);
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID();
const ORG=randomUUID(),S=randomUUID(),ROLE=randomUUID();
const humans=Object.fromEntries(['owner','exowner','marketer','reader','supportOp','billingOp','schoolOwner','stranger']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqmk-${k}-${randomUUID()}`,name:`Fixture ${k}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const tables=['hq_marketing_requests','hq_marketing_campaign_versions','hq_marketing_campaigns'];
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
  const ids=(await admin.query('SELECT id FROM hon.hq_marketing_campaigns WHERE created_by=ANY($1::uuid[])',[ps])).rows.map(r=>r.id);
  await admin.query('DELETE FROM hon.hq_marketing_requests WHERE campaign_id=ANY($1::uuid[])',[ids]);
  await admin.query('DELETE FROM hon.hq_marketing_campaign_versions WHERE campaign_id=ANY($1::uuid[])',[ids]);
  await admin.query('DELETE FROM hon.hq_marketing_campaigns WHERE id=ANY($1::uuid[])',[ids]);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  await admin.query('DELETE FROM hon.organizations WHERE id=$1',[ORG]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const counts=async()=>row(`SELECT (SELECT count(*) FROM hon.hq_marketing_campaigns)::int c,(SELECT count(*) FROM hon.hq_marketing_campaign_versions)::int v,
 (SELECT count(*) FROM hon.hq_marketing_requests)::int r,(SELECT count(*) FROM hon.marketing_campaigns)::int school`);
const plan=(patch={})=>({name:'Spring founder push',goal:'Book 20 owner demos from Google search.',audience:'NEW_SCHOOLS',offerLabel:'Founder 50',
 channel:'GOOGLE_ADS',startsOn:'2027-03-01',endsOn:'2027-03-31',plannedBudgetMinor:250000,...patch});
const createInput=(patch={})=>({code:'SPRING-GOOGLE',...plan(),...patch});

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['create_hq_marketing_campaign(text,jsonb,uuid)',true],['update_hq_marketing_campaign(text,uuid,jsonb,uuid)',true],
  ['set_hq_marketing_campaign_status(text,uuid,jsonb,uuid)',true],['read_hq_marketing_campaigns(text,text,timestamptz,uuid,integer)',true],
  ['read_hq_marketing_campaign(text,uuid)',true],['require_hq_marketing_actor(text,boolean)',false],['hq_marketing_principal_eligible(uuid,boolean)',false],
  ['hq_marketing_claim(uuid,uuid,text,text)',false],['hq_marketing_lock(uuid,integer)',false],['hq_marketing_plan(jsonb)',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 for(const t of tables)for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])
  assert.equal((await restricted.query('SELECT has_table_privilege(current_user,$1,$2) a',['hon.'+t,priv])).rows[0].a,false,`${t} ${priv}`);
 for(const t of tables)assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass",['hon.'+t]),{r:true,f:true},t);
 await cleanup();
 assert.equal((await counts()).c,0,'the disposable database holds no other HQ campaigns');

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[h.user,h.subject,`${h.user}@example.test`,h.name]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[h.id,h.user,h.name]);}
 for(const[who,role,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['marketer','HON_HQ_OPERATOR',['hq.marketing.manage'],null],
  ['reader','HON_HQ_OPERATOR',['hq.marketing.read'],null],['supportOp','HON_HQ_SUPPORT',['hq.marketing.manage','hq.support.manage'],null],['billingOp','HON_HQ_OPERATOR',['hq.billing.manage','hq.dashboard.view'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),role,perms]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQMK Fixture Dojo','HQMK Fixture Dojo','ACTIVE',clock_timestamp())",[ORG]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQMK Main',$1::text,'UTC')",[S,ORG]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[ORG,S,P('schoolOwner'),ROLE]);
 await admin.query('COMMIT');
 const start=await counts();

 // ---------- 1. authority ----------
 for(const who of ['exowner','supportOp','billingOp','schoolOwner','stranger']){
  await deny(marketing.list(H(who),{}),403,'SAAS_FORBIDDEN');
  await deny(marketing.create(H(who),createInput(),K()),403,'SAAS_FORBIDDEN');
 }
 await deny(marketing.list('hqmk-unknown-'+randomUUID(),{}),403,'SAAS_FORBIDDEN');
 await deny(marketing.read(H('stranger'),randomUUID()),403,'SAAS_FORBIDDEN');
 await deny(marketing.read(H('owner'),randomUUID()),404,'SAAS_UNAVAILABLE');
 // A read-only marketer reads but never writes.
 const empty=await marketing.list(H('reader'),{});
 assert.deepEqual([empty.campaigns,empty.viewer.canManage,empty.summary],[[],false,{DRAFT:0,ACTIVE:0,PAUSED:0,ARCHIVED:0,plannedBudgetOpenMinor:0}]);
 await deny(marketing.create(H('reader'),createInput(),K()),403,'SAAS_FORBIDDEN');
 assert.equal((await marketing.list(H('marketer'),{})).viewer.canManage,true);
 assert.deepEqual(await counts(),start,'refusals wrote nothing');

 // ---------- 2. create ----------
 for(const bad of [createInput({code:'lower'}),createInput({code:'X'}),createInput({name:'ab'}),createInput({goal:' padded '}),createInput({channel:'TIKTOK'}),
  createInput({audience:'FAMILIES'}),createInput({startsOn:'2027-02-30'}),createInput({endsOn:'2027-02-28'}),createInput({endsOn:'2029-04-01'}),
  createInput({plannedBudgetMinor:-1}),createInput({plannedBudgetMinor:1.5}),createInput({plannedBudgetMinor:10000000001}),{...createInput(),status:'ACTIVE'},
  (({goal,...r})=>r)(createInput())])
  await deny(marketing.create(H('owner'),bad,K()),400,'INVALID_SAAS_INPUT');
 for(const bad of [{...createInput(),extra:1},createInput({startsOn:'2027-02-30'}),createInput({plannedBudgetMinor:'250000'}),createInput({code:'bad code'})])
  await sqlDeny(restricted.query('SELECT hon.create_hq_marketing_campaign($1,$2::jsonb,$3)',[H('owner'),JSON.stringify(bad),K()]),'22023');
 const k1=K();
 const created=await marketing.create(H('marketer'),createInput(),k1);
 assert.deepEqual([created.operation,created.replayed],['CREATE',false]);
 const c1=created.campaign;
 assert.deepEqual({...c1,campaignId:null,createdAt:null,updatedAt:null},{campaignId:null,code:'SPRING-GOOGLE',...plan(),status:'DRAFT',currency:'USD',
  createdBy:{principalId:P('marketer'),displayName:'Fixture marketer'},createdAt:null,updatedAt:null,version:1});
 const replay=await marketing.create(H('marketer'),createInput(),k1);
 assert.equal(replay.replayed,true); assert.deepEqual(replay.campaign,c1,'replay returns the first receipt');
 await deny(marketing.create(H('marketer'),createInput({plannedBudgetMinor:1}),k1),409,'IDEMPOTENCY_KEY_REUSED');
 await deny(marketing.create(H('owner'),createInput(),K()),422,'HQ_CAMPAIGN_CODE_TAKEN');
 const c2=(await marketing.create(H('owner'),createInput({code:'META-TRIALS',channel:'META_ADS',audience:'TRIAL_SCHOOLS',plannedBudgetMinor:0}),k1)).campaign;
 assert.equal(c2.channel,'META_ADS');
 assert.deepEqual(await counts(),{...start,c:2,v:2,r:2});

 // ---------- 3. update ----------
 await deny(marketing.update(H('owner'),c1.campaignId,{expectedVersion:2,...plan({name:'Stale'})},K()),409,'SAAS_VERSION_CONFLICT');
 await deny(marketing.update(H('owner'),c1.campaignId,{expectedVersion:1,...plan()},K()),422,'HQ_CAMPAIGN_NO_CHANGE');
 await deny(marketing.update(H('owner'),c1.campaignId,{expectedVersion:1,code:'NEW-CODE',...plan()},K()),400,'INVALID_SAAS_INPUT');
 await deny(marketing.update(H('owner'),randomUUID(),{expectedVersion:1,...plan({name:'Missing'})},K()),404,'SAAS_UNAVAILABLE');
 await deny(marketing.update(H('reader'),c1.campaignId,{expectedVersion:1,...plan({name:'Reader edit'})},K()),403,'SAAS_FORBIDDEN');
 const ku=K();
 const u1=await marketing.update(H('owner'),c1.campaignId,{expectedVersion:1,...plan({plannedBudgetMinor:300000,endsOn:'2027-04-15'})},ku);
 assert.deepEqual([u1.operation,u1.campaign.version,u1.campaign.plannedBudgetMinor,u1.campaign.endsOn,u1.campaign.code,u1.campaign.status],['UPDATE',2,300000,'2027-04-15','SPRING-GOOGLE','DRAFT']);
 assert.deepEqual((await marketing.update(H('owner'),c1.campaignId,{expectedVersion:1,...plan({plannedBudgetMinor:300000,endsOn:'2027-04-15'})},ku)).campaign,u1.campaign,'update replay');

 // ---------- 4. status ----------
 await deny(marketing.status(H('owner'),c1.campaignId,{expectedVersion:2,status:'PAUSED'},K()),422,'HQ_CAMPAIGN_STATUS_NOT_ALLOWED');
 await deny(marketing.status(H('owner'),c1.campaignId,{expectedVersion:2,status:'DRAFT'},K()),400,'INVALID_SAAS_INPUT');
 await deny(marketing.status(H('owner'),c1.campaignId,{expectedVersion:1,status:'ACTIVE'},K()),409,'SAAS_VERSION_CONFLICT');
 const a=await marketing.status(H('marketer'),c1.campaignId,{expectedVersion:2,status:'ACTIVE'},K());
 const p=await marketing.status(H('marketer'),c1.campaignId,{expectedVersion:3,status:'PAUSED'},K());
 const a2=await marketing.status(H('owner'),c1.campaignId,{expectedVersion:4,status:'ACTIVE'},K());
 assert.deepEqual([a.campaign.status,p.campaign.status,a2.campaign.status,a2.campaign.version],['ACTIVE','PAUSED','ACTIVE',5]);
 await deny(marketing.status(H('owner'),c1.campaignId,{expectedVersion:5,status:'ACTIVE'},K()),422,'HQ_CAMPAIGN_STATUS_NOT_ALLOWED');
 const arch=await marketing.status(H('owner'),c2.campaignId,{expectedVersion:1,status:'ARCHIVED'},K());
 assert.equal(arch.campaign.status,'ARCHIVED');
 await deny(marketing.status(H('owner'),c2.campaignId,{expectedVersion:2,status:'ACTIVE'},K()),422,'HQ_CAMPAIGN_ARCHIVED');
 await deny(marketing.update(H('owner'),c2.campaignId,{expectedVersion:2,...plan({name:'After archive'})},K()),422,'HQ_CAMPAIGN_ARCHIVED');

 // ---------- 5. detail and history ----------
 const d=await marketing.read(H('reader'),c1.campaignId);
 assert.deepEqual(d.versions.map(v=>[v.version,v.kind,v.snapshot.status]),[[1,'CREATED','DRAFT'],[2,'UPDATED','DRAFT'],[3,'STATUS','ACTIVE'],[4,'STATUS','PAUSED'],[5,'STATUS','ACTIVE']]);
 assert.deepEqual(d.versions.map(v=>v.actor.principalId),[P('marketer'),P('owner'),P('marketer'),P('marketer'),P('owner')]);
 assert.deepEqual([d.versions[0].snapshot.plannedBudgetMinor,d.versions[1].snapshot.plannedBudgetMinor],[250000,300000]);
 assert.deepEqual([d.viewer.principalId,d.viewer.canManage],[P('reader'),false]);
 assert(!JSON.stringify(d).includes('@example.test'),'no email');
 for(const h of Object.values(humans))assert(!JSON.stringify(d).includes(h.subject),'no subject');

 // ---------- 6. immutability ----------
 await sqlDeny(admin.query("UPDATE hon.hq_marketing_campaign_versions SET kind='UPDATED' WHERE campaign_id=$1",[c1.campaignId]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_marketing_campaign_versions WHERE campaign_id=$1',[c1.campaignId]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_marketing_campaigns WHERE id=$1',[c1.campaignId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_marketing_campaigns SET code='CHANGED',version=version+1 WHERE id=$1",[c1.campaignId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_marketing_campaigns SET name='No bump' WHERE id=$1",[c1.campaignId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_marketing_campaigns SET status='DRAFT',version=version+1 WHERE id=$1",[c2.campaignId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_marketing_requests SET response='{}' WHERE campaign_id=$1",[c1.campaignId]),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.hq_marketing_campaign_versions'),'42501');

 // ---------- 7. list: filters, paging, summary; reads write nothing ----------
 for(let i=0;i<4;i++)await marketing.create(H('marketer'),createInput({code:`PAGE-${i}`,channel:'EMAIL',plannedBudgetMinor:1000*i}),K());
 const before=await counts();
 const walk=async(q,limit)=>{const out=[];let cursor;let page;do{page=await marketing.list(H('reader'),{...q,limit:String(limit),...(cursor?{cursor:encodeHqMarketingCursor(cursor)}:{})});out.push(...page.campaigns);cursor=page.nextCursor;}while(cursor);return {out,page};};
 const all=await walk({},100),ones=await walk({},1);
 assert.equal(all.out.length,6); assert.deepEqual(ones.out.map(c=>c.campaignId),all.out.map(c=>c.campaignId),'limit 1 walks the same order');
 assert.equal(all.out[0].code,'PAGE-3','newest first');
 assert.deepEqual(all.page.summary,{DRAFT:4,ACTIVE:1,PAUSED:0,ARCHIVED:1,plannedBudgetOpenMinor:300000+0+1000+2000+3000});
 assert.deepEqual((await walk({status:'ARCHIVED'},2)).out.map(c=>c.campaignId),[c2.campaignId]);
 const open=await walk({status:'OPEN'},2);
 assert.equal(open.out.length,5); assert(!open.out.some(c=>c.campaignId===c2.campaignId));
 assert.deepEqual((await walk({status:'ACTIVE'},5)).out.map(c=>c.campaignId),[c1.campaignId]);
 for(const bad of [{limit:'0'},{limit:'101'},{status:'DONE'},{cursor:'bad'},{schoolId:S}])await deny(marketing.list(H('owner'),bad),400,'INVALID_SAAS_INPUT');
 assert.deepEqual(await counts(),before,'reads write nothing');
 assert.equal(before.school,start.school,'no school campaign row was written');

 // ---------- 8. a person revoked meanwhile gets nothing ----------
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('marketer')]);
 await deny(marketing.list(H('marketer'),{}),403,'SAAS_FORBIDDEN');
 await deny(marketing.status(H('marketer'),c1.campaignId,{expectedVersion:5,status:'PAUSED'},K()),403,'SAAS_FORBIDDEN');
 assert.deepEqual(await counts(),before);
 console.log('HQ marketing campaigns proof passed (posture, authority incl. read-only, create/update/status, idempotency, unique code, version, transitions, archived is final, immutable history, list paging/filter/summary, no school rows, revocation).');
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);}
}
