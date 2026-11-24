/** Automation workflows and contact tags (AU-1, 0416): real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL.
 *  No provider, message, payment or AI. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point (the sign-up program is opened
 *  to TEST_MODE by this proof's owner connection only); the owner connection stands in for HON OS access by writing the entitlement row. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {validDefinitions,invalidDefinitions,evaluationFollowUp} from './automation-definition-corpus.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|OPENROUTER.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {AutomationWorkflowController,ContactTagController}=require('./dist/automations/automation.controller.js');
const {AutomationService}=require('./dist/automations/automation.service.js');
const guards=require('./dist/automations/automation.guard.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'automation-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS AUTOMATION '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key===null?{}:{'idempotency-key':key})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const person=label=>({externalSubject:'oidc:automation:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:C.SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const complete=w=>q("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day') ON CONFLICT(organization_id) DO UPDATE SET tier='COMPLETE',status='ACTIVE',effective_from=excluded.effective_from,effective_until=NULL",[w.org]);
const base=w=>`organizations/${w.org}/schools/${w.school}/automations`;
const tags=w=>`organizations/${w.org}/schools/${w.school}`;
const post=(w,path,body,command,key=K(),extra={})=>send(path,{identity:w,method:'POST',key,body,command,...extra});
const create=(w,body,key)=>post(w,base(w),body,C.AUTOMATION_CREATE_COMMAND,key);
const counts=async w=>(await q("SELECT (SELECT count(*) FROM hon.automation_workflows WHERE organization_id=$1) w,(SELECT count(*) FROM hon.automation_workflow_versions WHERE organization_id=$1) v,(SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'automation.workflow.%') a,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'automation.workflow.%') o",[w.org]))[0];
const sqlValid=async d=>{try{await admin.query('SAVEPOINT v');const r=(await admin.query('SELECT hon.validate_automation_definition($1::jsonb) k',[JSON.stringify(d)])).rows[0].k;await admin.query('RELEASE SAVEPOINT v');return r;}
 catch(e){await admin.query('ROLLBACK TO SAVEPOINT v');assert.equal(e.message,'AUTOMATION_INVALID',e.message);assert.equal(e.code,'22023');return null;}};
const tsValid=d=>{try{return C.validateAutomationDefinition(d).trigger.kind;}catch(e){assert(e instanceof C.AutomationDefinitionError,e.message);return null;}};

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL (also against the canonical infra grants the fixture applies).
 const tables=['automation_workflows','automation_workflow_versions','automation_commands','contact_tags','contact_tag_events'];
 for(const t of tables){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['create_automation_workflow','save_automation_workflow_version','restore_automation_workflow_version','archive_automation_workflow','read_automation_workflows',
  'read_automation_workflow','read_automation_workflow_version','add_contact_tag','remove_contact_tag','read_school_contact_tags','read_person_contact_tags','lookup_contact_tags',
  // 0423 adds four staff entry points (turn on, pause, run history); its engine functions stay off the runtime.
  'activate_automation_workflow','pause_automation_workflow','read_automation_runs','read_automation_run'];
 const mine=(await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE 'automation\\_%' OR p.proname LIKE '%automation_workflow%' OR p.proname LIKE '%contact\\_tag%' OR p.proname='validate_automation_definition')"));
 assert(mine.length>=40,String(mine.length));
 for(const f of mine)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 pass('forced deny-all RLS on five new tables; runtime executes exactly the twelve 0416 entry points plus four from 0423');

 // 2. One validator in two places: the shared corpus is accepted or refused identically by TypeScript and PostgreSQL.
 await admin.query('BEGIN');
 for(const [label,d] of validDefinitions){const s=await sqlValid(d),t=tsValid(d);assert.equal(s,d.trigger.kind,'sql '+label);assert.equal(t,d.trigger.kind,'ts '+label);}
 for(const [label,d] of invalidDefinitions){assert.equal(await sqlValid(d),null,'sql accepted '+label);assert.equal(tsValid(d),null,'ts accepted '+label);}
 await admin.query('ROLLBACK');
 pass(`${validDefinitions.length} valid and ${invalidDefinitions.length} invalid definitions agree between @hon/contracts and hon.validate_automation_definition`);

 const module=await Test.createTestingModule({controllers:[AutomationWorkflowController,ContactTagController],providers:[AutomationService,...Object.values(guards),HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const w of [a,b])assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code LIKE ANY(ARRAY['automation.workflow.%','contact.tag.%'])",[w.org]))[0].n,'5');

 // 3. HON OS (COMPLETE) access is required for reads and commands.
 let r=await send(base(a),{identity:a});assert.equal(r.status,403);
 r=await create(a,{name:'Evaluation follow-up',definition:evaluationFollowUp});assert.equal(r.status,403);
 await q("UPDATE hon.organization_entitlements SET tier='CORE',status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[a.org]);
 r=await send(base(a),{identity:a});assert.equal(r.status,403);
 await complete(a);await complete(b);
 assert.equal(Number((await counts(a)).w),0);
 pass('without active COMPLETE access (none, then CORE) reads and commands are refused and nothing is written');

 // 4. Create, exact replay, key reuse, validation at the API and in SQL.
 assert.deepEqual(ok(await send(base(a),{identity:a})).workflows,[]);
 const key=K();r=await create(a,{name:'Evaluation follow-up',definition:evaluationFollowUp},key);let d=C.verifyAutomationWorkflowDetail(ok(r));
 assert.equal(r.body.meta.replayed,false);assert.equal(d.workflow.status,'DRAFT');assert.equal(d.workflow.latestVersion,1);assert.equal(d.workflow.activeVersion,null);
 assert.equal(d.workflow.triggerKind,'FORM_LEAD_RECEIVED');assert.equal(d.workflow.stepCount,4);assert.deepEqual(d.latest.definition,evaluationFollowUp);
 assert.equal(d.latest.source,'HUMAN_UI');assert.equal(d.latest.author,'Synthetic alpha');assert.equal(d.versions.length,1);
 r=await create(a,{name:'Evaluation follow-up',definition:evaluationFollowUp},key);assert.deepEqual(ok(r),d);assert.equal(r.body.meta.replayed,true);
 r=await create(a,{name:'Something else',definition:evaluationFollowUp},key);assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');
 for(const [,bad] of invalidDefinitions.slice(0,12)){r=await create(a,{name:'Bad',definition:bad});assert.equal(r.status,400,JSON.stringify(r.body));}
 for(const name of ['',' padded','x'.repeat(101),'tab\tname','{{first_name}}']){r=await create(a,{name,definition:evaluationFollowUp});assert.equal(r.status,400,name);}
 r=await create(a,{name:'Extra',definition:evaluationFollowUp,status:'ACTIVE'});assert.equal(r.status,400);
 // The database refuses on its own when the API is bypassed.
 const bypass=await restricted.query('BEGIN').then(async()=>{
  const req=K();
  await restricted.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_request_id',$3,true)",[a.org,a.school,req]);
  try{await restricted.query('SELECT hon.create_automation_workflow($1,$2::jsonb,$3,$4,$5)',[a.externalSubject,{name:'Loop',definition:invalidDefinitions.find(x=>x[0]==='loop')[1]},K(),req,K()]);return 'accepted';}
  catch(e){return e.message;}finally{await restricted.query('ROLLBACK');}});
 assert.equal(bypass,'AUTOMATION_INVALID');
 let c=await counts(a);assert.deepEqual([c.w,c.v,c.a,c.o].map(Number),[1,1,1,1]);
 const outbox=(await q("SELECT payload::text p FROM hon.outbox_events WHERE organization_id=$1 AND event_type='automation.workflow.created'",[a.org]))[0].p;
 assert(!/thanks for your interest|evaluation/i.test(outbox),outbox);
 pass('a draft is created with version 1 exactly as sent; exact replay; refused key reuse; closed validation in the API and in SQL; identifier-only audit and outbox');

 // 5. Versions: save, stale revision, read a version, restore, archive; nothing ever runs.
 const id=d.workflow.workflowId,changed={...evaluationFollowUp,exitWhen:['OPTED_OUT']};
 r=await post(a,base(a)+'/'+id+'/versions',{expectedRevision:d.workflow.revision,name:'Evaluation follow-up v2',definition:changed},C.AUTOMATION_SAVE_COMMAND);d=ok(r);
 assert.equal(d.workflow.latestVersion,2);assert.equal(d.workflow.revision,2);assert.equal(d.workflow.name,'Evaluation follow-up v2');assert.deepEqual(d.versions.map(v=>v.version),[2,1]);
 r=await post(a,base(a)+'/'+id+'/versions',{expectedRevision:1,name:'Stale',definition:changed},C.AUTOMATION_SAVE_COMMAND);assert.equal(r.status,409);assert.equal(r.body.code,'AUTOMATION_STALE');
 const v1=ok(await send(base(a)+'/'+id+'/versions/1',{identity:a}));assert.deepEqual(v1.definition,evaluationFollowUp);assert.equal(v1.name,'Evaluation follow-up');
 r=await send(base(a)+'/'+id+'/versions/9',{identity:a});assert.equal(r.status,404);
 r=await post(a,base(a)+'/'+id+'/restore',{expectedRevision:2,fromVersion:2},C.AUTOMATION_RESTORE_COMMAND);assert.equal(r.status,404);
 r=await post(a,base(a)+'/'+id+'/restore',{expectedRevision:2,fromVersion:1},C.AUTOMATION_RESTORE_COMMAND);d=ok(r);
 assert.equal(d.workflow.latestVersion,3);assert.equal(d.latest.restoredFromVersion,1);assert.deepEqual(d.latest.definition,evaluationFollowUp);assert.equal(d.workflow.name,'Evaluation follow-up');
 assert.equal(d.workflow.status,'DRAFT');
 r=await post(a,base(a)+'/'+id+'/archive',{expectedRevision:d.workflow.revision},C.AUTOMATION_ARCHIVE_COMMAND);d=ok(r);assert.equal(d.workflow.status,'ARCHIVED');
 r=await post(a,base(a)+'/'+id+'/versions',{expectedRevision:d.workflow.revision,name:'After archive',definition:changed},C.AUTOMATION_SAVE_COMMAND);assert.equal(r.status,409);assert.equal(r.body.code,'AUTOMATION_ARCHIVED');
 // A PAUSED/ACTIVE workflow (set only by the AU-2 engine) cannot be archived as a draft.
 const live=C.verifyAutomationWorkflowDetail(ok(await create(a,{name:'Live one',definition:evaluationFollowUp})));
 await q("UPDATE hon.automation_workflows SET status='ACTIVE',active_version=1,activated_by_principal_id=created_by_principal_id,activated_at=clock_timestamp(),revision=revision+1 WHERE id=$1",[live.workflow.workflowId]);
 r=await post(a,base(a)+'/'+live.workflow.workflowId+'/archive',{expectedRevision:2},C.AUTOMATION_ARCHIVE_COMMAND);assert.equal(r.status,409);assert.equal(r.body.code,'AUTOMATION_NOT_DRAFT');
 r=await post(a,base(a)+'/'+live.workflow.workflowId+'/versions',{expectedRevision:2,name:'Live one',definition:changed},C.AUTOMATION_SAVE_COMMAND);d=ok(r);
 assert.equal(d.workflow.status,'ACTIVE');assert.equal(d.workflow.activeVersion,1);assert.equal(d.workflow.latestVersion,2);
 const list=C.verifyAutomationWorkflowList(ok(await send(base(a),{identity:a})));assert.deepEqual(list.workflows.map(w=>w.status).sort(),['ACTIVE','ARCHIVED']);
 pass('save appends a version; a stale revision, unknown version and archived workflow are refused; restore appends a copy; only a draft archives; editing a running workflow keeps its active version');

 // 6. Isolation and authority.
 r=await send(base(a),{identity:b});assert.equal(r.status,403);
 r=await send(`organizations/${a.org}/schools/${b.school}/automations`,{identity:b});assert.equal(r.status,403);
 r=await send(base(b)+'/'+id,{identity:b});assert.equal(r.status,404);
 r=await post(b,base(b)+'/'+live.workflow.workflowId+'/versions',{expectedRevision:3,name:'Hijack',definition:changed},C.AUTOMATION_SAVE_COMMAND);assert.equal(r.status,404);
 r=await send(base(a),{identity:a,headers:{'x-hon-delegated-by-principal-id':K()}});assert.equal(r.status,403);
 r=await post(a,base(a),{name:'Wrong command',definition:evaluationFollowUp},C.AUTOMATION_SAVE_COMMAND);assert.equal(r.status,403);
 r=await post(a,base(a),{name:'No key',definition:evaluationFollowUp},C.AUTOMATION_CREATE_COMMAND,null);assert.equal(r.status,400);
 r=await send(base(a)+'?school='+b.school,{identity:a});assert.equal(r.status,400);
 r=await send(base(a),{identity:person('stranger')});assert.equal(r.status,403);
 const g=await register('gamma');await complete(g);ok(await send(base(g),{identity:g}));
 const grant=(await q('SELECT owner_grant_id g FROM hon.hon_os_school_registrations WHERE organization_id=$1',[g.org]))[0].g;
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[grant]);
 r=await send(base(g),{identity:g});assert.equal(r.status,403);r=await create(g,{name:'Revoked',definition:evaluationFollowUp});assert.equal(r.status,403);
 assert.equal(Number((await counts(g)).w),0);
 pass('another school, wrong school ids, another school\'s workflow, delegation, wrong browser command, missing key, query selectors, unknown person and a revoked grant are refused');

 // 7. Contact tags: add, replay, case-insensitive no-op, remove, lookup, limits, isolation, history.
 const people=[K(),K(),K()];
 for(const p of people)await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic','Person')",[p,a.org,a.school]);
 const other=K();await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Other','Person')",[other,b.org,b.school]);
 const tagPath=(w,p)=>tags(w)+'/people/'+p+'/tags';
 const tkey=K();r=await post(a,tagPath(a,people[0]),{tag:'Demo Team'},C.CONTACT_TAG_ADD_COMMAND,tkey);let t=C.verifyContactTagChange(ok(r));
 assert.equal(t.changed,true);assert.deepEqual(t.tags.map(x=>[x.tag,x.tagKey,x.addedSource]),[['Demo Team','demo team','HUMAN_UI']]);
 r=await post(a,tagPath(a,people[0]),{tag:'Demo Team'},C.CONTACT_TAG_ADD_COMMAND,tkey);assert.equal(r.body.meta.replayed,true);assert.deepEqual(ok(r),t);
 r=await post(a,tagPath(a,people[0]),{tag:'demo team'},C.CONTACT_TAG_ADD_COMMAND);assert.equal(ok(r).changed,false);
 r=await post(a,tagPath(a,people[1]),{tag:'demo TEAM'},C.CONTACT_TAG_ADD_COMMAND);assert.equal(ok(r).changed,true);
 r=await post(a,tagPath(a,people[1]),{tag:'VIP'},C.CONTACT_TAG_ADD_COMMAND);ok(r);
 for(const bad of ['','vip!',' x','x'.repeat(41),{}]){r=await post(a,tagPath(a,people[0]),{tag:bad},C.CONTACT_TAG_ADD_COMMAND);assert.equal(r.status,400);}
 r=await post(a,tagPath(a,other),{tag:'Peek'},C.CONTACT_TAG_ADD_COMMAND);assert.equal(r.status,404);
 r=await post(b,tagPath(b,people[0]),{tag:'Peek'},C.CONTACT_TAG_ADD_COMMAND);assert.equal(r.status,404);
 const school=C.verifySchoolContactTags(ok(await send(tags(a)+'/contact-tags',{identity:a})));
 assert.deepEqual(school.tags.map(x=>[x.tagKey,x.count]),[['demo team',2],['vip',1]]);
 const looked=C.verifyContactTagLookup(ok(await post(a,tags(a)+'/contact-tags/lookup',{personIds:[...people,other]},C.CONTACT_TAG_LOOKUP_COMMAND,null)));
 assert.equal(looked.people.length,3);assert(!looked.people.some(p=>p.personId===other));
 assert.deepEqual(looked.people.find(p=>p.personId===people[1]).tags,['demo TEAM','VIP']);
 r=await post(a,tags(a)+'/contact-tags/lookup',{personIds:[people[0]]},C.CONTACT_TAG_LOOKUP_COMMAND);assert.equal(r.status,409);
 r=await post(a,tagPath(a,people[0])+'/remove',{tag:'DEMO TEAM'},C.CONTACT_TAG_REMOVE_COMMAND);assert.deepEqual(ok(r).tags,[]);assert.equal(ok(r).changed,true);
 r=await post(a,tagPath(a,people[0])+'/remove',{tag:'Demo Team'},C.CONTACT_TAG_REMOVE_COMMAND);assert.equal(ok(r).changed,false);
 assert.deepEqual(C.verifyPersonContactTags(ok(await send(tagPath(a,people[1]),{identity:a}))).tags.map(x=>x.tag),['demo TEAM','VIP']);
 r=await send(tagPath(b,people[1]),{identity:b});assert.equal(r.status,404);
 const ev=await q("SELECT kind,tag_key,source FROM hon.contact_tag_events WHERE organization_id=$1 ORDER BY id",[a.org]);
 assert.deepEqual(ev.map(e=>e.kind+':'+e.tag_key),['ADDED:demo team','ADDED:demo team','ADDED:vip','REMOVED:demo team']);
 assert.equal((await q("SELECT count(*) n FROM hon.outbox_events WHERE organization_id=$1 AND event_type IN ('contact.tag.added','contact.tag.removed')",[a.org]))[0].n,'4');
 // Per-person limit of 20, raced.
 const many=await Promise.all(Array.from({length:23},(_,i)=>post(a,tagPath(a,people[2]),{tag:'tag'+i},C.CONTACT_TAG_ADD_COMMAND)));
 assert.equal(many.filter(x=>x.status===200).length,20);assert(many.filter(x=>x.status!==200).every(x=>x.status===422&&x.body.code==='CONTACT_TAG_LIMIT_REACHED'));
 pass('contact tags: add, exact replay, case-insensitive no-op, remove, school counts, batch lookup leaves other schools out, closed tag text, raced 20-per-person limit, recorded history and outbox');

 // 8. Evidence guard.
 await assert.rejects(q('UPDATE hon.automation_workflow_versions SET name=$2 WHERE workflow_id=$1',[id,'x']),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.automation_workflow_versions WHERE workflow_id=$1',[id]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.automation_workflows WHERE id=$1',[live.workflow.workflowId]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q('UPDATE hon.automation_workflows SET school_id=$2,revision=revision+1 WHERE id=$1',[live.workflow.workflowId,b.school]),/AUTOMATION_HISTORY_IMMUTABLE|violates foreign key/);
 await assert.rejects(q('UPDATE hon.automation_workflows SET name=$2,revision=revision+1 WHERE id=$1',[id,'Unarchive']),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.contact_tag_events SET tag_key='x' WHERE organization_id=$1",[a.org]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.automation_commands SET fingerprint=repeat('0',64) WHERE organization_id=$1",[a.org]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q('TRUNCATE hon.automation_commands CASCADE'),/AUTOMATION_HISTORY_IMMUTABLE|cannot truncate/);
 pass('versions, tag history and command receipts cannot be edited or deleted; a workflow is never deleted, moved or reopened after archive');
 console.log('PASS: automation workflows and contact tags (0416), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
