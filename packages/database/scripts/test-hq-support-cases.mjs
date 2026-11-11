import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// B-HQ-2 HQ support records (0232 proposed) integrity proof, TEST MODE, disposable database only. It proves: only a current
// HQ owner, or an HQ operator / HQ support person holding hq.support.manage, reads or writes support cases (billing-only
// operators, support without the permission, lapsed owners, school owners and unknown subjects are refused); the runtime
// can execute only the five entry points and has no table privilege; opening checks the organization and school; every
// command is idempotent by actor and key and refuses key reuse; notes and changes require the current version, assignees
// must hold support authority, a closed case is final and an empty change is refused; history is immutable and ordered;
// the list filters, pages and summarizes exactly; a reader revoked meanwhile gets nothing.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {HqSupportService}=await import('../../../apps/api/dist/hq-support/hq-support.service.js');
const {encodeHqSupportCursor}=await import('@hon/contracts');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),support=new HqSupportService(billing);
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID();
const ORG=randomUUID(),ORG2=randomUUID(),S=randomUUID(),S2=randomUUID(),ROLE=randomUUID();
const humans=Object.fromEntries(['owner','exowner','supportOp','supportAgent','billingOp','plainSupport','schoolOwner','stranger']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqsc-${k}-${randomUUID()}`,name:`Fixture ${k}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const tables=['hq_support_requests','hq_support_case_events','hq_support_cases'];
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const ids=(await admin.query('SELECT id FROM hon.hq_support_cases WHERE organization_id=ANY($1::uuid[])',[[ORG,ORG2]])).rows.map(r=>r.id);
  await admin.query('DELETE FROM hon.hq_support_requests WHERE case_id=ANY($1::uuid[])',[ids]);
  await admin.query('DELETE FROM hon.hq_support_case_events WHERE case_id=ANY($1::uuid[])',[ids]);
  await admin.query('DELETE FROM hon.hq_support_cases WHERE id=ANY($1::uuid[])',[ids]);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[[ORG,ORG2]]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[[ORG,ORG2]]);
  const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const counts=async()=>row(`SELECT (SELECT count(*) FROM hon.hq_support_cases)::int c,(SELECT count(*) FROM hon.hq_support_case_events)::int e,(SELECT count(*) FROM hon.hq_support_requests)::int r`);
const openInput=(patch={})=>({organizationId:ORG,schoolId:S,subject:'Owner cannot sign in',category:'ACCOUNT_ACCESS',priority:'HIGH',note:'Owner reports the sign-in link expired twice.',...patch});

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['open_hq_support_case(text,jsonb,uuid)',true],['add_hq_support_note(text,uuid,jsonb,uuid)',true],['change_hq_support_case(text,uuid,jsonb,uuid)',true],
  ['read_hq_support_cases(text,text,uuid,timestamptz,uuid,integer)',true],['read_hq_support_case(text,uuid)',true],['read_hq_support_schools(text)',true],['require_hq_support_actor(text)',false],
  ['hq_support_principal_eligible(uuid)',false],['hq_support_claim(uuid,uuid,text,text)',false],['hq_support_lock_case(uuid,integer)',false],['hq_support_assignees_json()',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 for(const t of tables)for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])
  assert.equal((await restricted.query('SELECT has_table_privilege(current_user,$1,$2) a',['hon.'+t,priv])).rows[0].a,false,`${t} ${priv}`);
 for(const t of tables)assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass",['hon.'+t]),{r:true,f:true},t);
 await cleanup();

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[h.user,h.subject,`${h.user}@example.test`,h.name]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[h.id,h.user,h.name]);}
 for(const[who,role,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['supportOp','HON_HQ_OPERATOR',['hq.support.manage'],null],
  ['supportAgent','HON_HQ_SUPPORT',['hq.support.manage'],null],['billingOp','HON_HQ_OPERATOR',['hq.billing.manage','hq.dashboard.view'],null],['plainSupport','HON_HQ_SUPPORT',['hq.billing.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),role,perms]);
 for(const[o,s,name]of [[ORG,S,'HQSC Fixture Dojo'],[ORG2,S2,'HQSC Other Dojo']]){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,$2,$2,'ACTIVE',clock_timestamp())",[o,name]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'UTC')",[s,o,name+' Main']);
 }
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[ORG,S,P('schoolOwner'),ROLE]);
 await admin.query('COMMIT');

 // ---------- 1. authority ----------
 for(const who of ['exowner','billingOp','plainSupport','schoolOwner','stranger']){
  await deny(support.list(H(who),{}),403,'SAAS_FORBIDDEN');
  await deny(support.open(H(who),openInput(),K()),403,'SAAS_FORBIDDEN');
 }
 await deny(support.list('hqsc-unknown-'+randomUUID(),{}),403,'SAAS_FORBIDDEN');
 // An unknown case is refused before existence is revealed to a non-reader.
 await deny(support.read(H('stranger'),randomUUID()),403,'SAAS_FORBIDDEN');
 await deny(support.read(H('owner'),randomUUID()),404,'SAAS_UNAVAILABLE');
 assert.deepEqual(await counts(),{c:0,e:0,r:0},'refusals wrote nothing');

 // ---------- 2. open ----------
 for(const bad of [openInput({subject:'x'}),openInput({note:''}),openInput({category:'REFUND'}),openInput({priority:'P1'}),{...openInput(),extra:1},openInput({schoolId:'nope'}),openInput({subject:' padded '})])
  await deny(support.open(H('owner'),bad,K()),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.open_hq_support_case($1,$2::jsonb,$3)',[H('owner'),JSON.stringify(openInput({extra:1})),K()]),'22023');
 await deny(support.open(H('owner'),openInput({organizationId:randomUUID()}),K()),404,'SAAS_UNAVAILABLE');
 await deny(support.open(H('owner'),openInput({schoolId:S2}),K()),404,'SAAS_UNAVAILABLE');
 const k1=K();
 const opened=await support.open(H('supportAgent'),openInput(),k1);
 assert.equal(opened.replayed,false); assert.equal(opened.operation,'OPEN');
 const c1=opened.case;
 assert.deepEqual({...c1,caseId:null,openedAt:null,updatedAt:null},{caseId:null,organizationId:ORG,organizationDisplayName:'HQSC Fixture Dojo',schoolId:S,schoolDisplayName:'HQSC Fixture Dojo Main',
  subject:'Owner cannot sign in',category:'ACCOUNT_ACCESS',priority:'HIGH',status:'OPEN',assignee:null,openedBy:{principalId:P('supportAgent'),displayName:'Fixture supportAgent'},
  openedAt:null,updatedAt:null,closedAt:null,version:1,noteCount:1});
 const replay=await support.open(H('supportAgent'),openInput(),k1);
 assert.equal(replay.replayed,true); assert.deepEqual(replay.case,c1,'replay returns the first receipt');
 await deny(support.open(H('supportAgent'),openInput({priority:'LOW'}),k1),409,'IDEMPOTENCY_KEY_REUSED');
 // The same key from another actor is a different request.
 const c2=(await support.open(H('owner'),openInput({organizationId:ORG2,schoolId:null,subject:'Billing question',category:'BILLING',priority:'NORMAL',note:'Asked about invoice dates.'}),k1)).case;
 assert.equal(c2.schoolId,null); assert.equal(c2.schoolDisplayName,null);
 assert.deepEqual(await counts(),{c:2,e:2,r:2});

 // ---------- 3. notes ----------
 await deny(support.note(H('owner'),c1.caseId,{expectedVersion:2,note:'Stale'},K()),409,'SAAS_VERSION_CONFLICT');
 await deny(support.note(H('owner'),c1.caseId,{expectedVersion:1,note:'x'.repeat(4001)},K()),400,'INVALID_SAAS_INPUT');
 await deny(support.note(H('owner'),randomUUID(),{expectedVersion:1,note:'Missing'},K()),404,'SAAS_UNAVAILABLE');
 const kn=K();
 const n1=await support.note(H('supportOp'),c1.caseId,{expectedVersion:1,note:'Sent a fresh sign-in link.\nAsked them to try in a private window.'},kn);
 assert.equal(n1.case.version,2); assert.equal(n1.case.noteCount,2);
 assert.deepEqual((await support.note(H('supportOp'),c1.caseId,{expectedVersion:1,note:'Sent a fresh sign-in link.\nAsked them to try in a private window.'},kn)).case,n1.case,'note replay');

 // ---------- 4. changes ----------
 await deny(support.change(H('owner'),c1.caseId,{expectedVersion:2},K()),400,'INVALID_SAAS_INPUT');
 await deny(support.change(H('owner'),c1.caseId,{expectedVersion:2,status:'OPEN'},K()),422,'SUPPORT_NO_CHANGE');
 await deny(support.change(H('owner'),c1.caseId,{expectedVersion:2,assigneePrincipalId:P('billingOp')},K()),422,'SUPPORT_ASSIGNEE_NOT_ELIGIBLE');
 await deny(support.change(H('owner'),c1.caseId,{expectedVersion:2,assigneePrincipalId:P('schoolOwner')},K()),422,'SUPPORT_ASSIGNEE_NOT_ELIGIBLE');
 const ch=await support.change(H('owner'),c1.caseId,{expectedVersion:2,status:'WAITING_ON_SCHOOL',assigneePrincipalId:P('supportAgent'),note:'Waiting for the owner to retry.'},K());
 assert.equal(ch.case.status,'WAITING_ON_SCHOOL'); assert.deepEqual(ch.case.assignee,{principalId:P('supportAgent'),displayName:'Fixture supportAgent'});
 assert.equal(ch.case.version,3); assert.equal(ch.case.noteCount,3);
 const pr=await support.change(H('supportAgent'),c1.caseId,{expectedVersion:3,priority:'URGENT',assigneePrincipalId:null},K());
 assert.equal(pr.case.priority,'URGENT'); assert.equal(pr.case.assignee,null);
 let list=await support.list(H('owner'),{status:'ACTIVE'});
 assert.deepEqual(list.summary,{OPEN:1,WAITING_ON_SCHOOL:1,RESOLVED:0,CLOSED:0,urgentActive:1,unassignedActive:2});
 const closed=await support.change(H('owner'),c1.caseId,{expectedVersion:4,status:'CLOSED',note:'Owner signed in. Closing.'},K());
 assert.equal(closed.case.status,'CLOSED'); assert.notEqual(closed.case.closedAt,null);
 await deny(support.note(H('owner'),c1.caseId,{expectedVersion:5,note:'After close'},K()),422,'SUPPORT_CASE_CLOSED');
 await deny(support.change(H('owner'),c1.caseId,{expectedVersion:5,status:'OPEN'},K()),422,'SUPPORT_CASE_CLOSED');
 // RESOLVED can be reopened; CLOSED cannot.
 const r1=await support.change(H('supportOp'),c2.caseId,{expectedVersion:1,status:'RESOLVED'},K());
 const r2=await support.change(H('supportOp'),c2.caseId,{expectedVersion:2,status:'OPEN',note:'Customer replied again.'},K());
 assert.equal(r1.case.status,'RESOLVED'); assert.equal(r2.case.status,'OPEN'); assert.equal(r2.case.closedAt,null);

 // ---------- 5. detail and history ----------
 const d=await support.read(H('supportAgent'),c1.caseId);
 assert.deepEqual(d.events.map(e=>[e.seq,e.kind]),[[1,'OPENED'],[2,'NOTE'],[3,'CHANGED'],[4,'CHANGED'],[5,'CHANGED']]);
 assert.deepEqual([d.events[2].statusFrom,d.events[2].statusTo,d.events[2].assigneeChanged,d.events[2].assigneeTo?.principalId],['OPEN','WAITING_ON_SCHOOL',true,P('supportAgent')]);
 assert.deepEqual([d.events[3].priorityFrom,d.events[3].priorityTo,d.events[3].assigneeChanged,d.events[3].assigneeTo],['HIGH','URGENT',true,null]);
 assert.deepEqual(d.events.map(e=>e.actor.principalId),[P('supportAgent'),P('supportOp'),P('owner'),P('supportAgent'),P('owner')]);
 assert.deepEqual(d.assignees.map(a=>a.principalId).filter(id=>Object.values(humans).some(h=>h.id===id)).sort(),[P('owner'),P('supportAgent'),P('supportOp')].sort(),'only current support people');
 assert.equal(d.viewer.principalId,P('supportAgent'));
 assert(!JSON.stringify(d).includes('@example.test'),'no email');
 for(const h of Object.values(humans))assert(!JSON.stringify(d).includes(h.subject),'no subject');

 // ---------- 6. immutability ----------
 await sqlDeny(admin.query('UPDATE hon.hq_support_case_events SET note=$2 WHERE case_id=$1',[c1.caseId,'rewritten']),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_support_case_events WHERE case_id=$1',[c1.caseId]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_support_cases WHERE id=$1',[c2.caseId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_support_cases SET subject='Changed' , version=version+1 WHERE id=$1",[c2.caseId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_support_cases SET priority='LOW' WHERE id=$1",[c2.caseId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_support_cases SET status='OPEN',closed_at=NULL,version=version+1 WHERE id=$1",[c1.caseId]),'42501');
 await sqlDeny(admin.query('UPDATE hon.hq_support_requests SET response=$2 WHERE case_id=$1',[c1.caseId,'{}']),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.hq_support_case_events'),'42501');

 // ---------- 7. list: filters, paging, summary; reads write nothing ----------
 for(let i=0;i<4;i++)await support.open(H('supportOp'),openInput({subject:`Paging case ${i}`,priority:'LOW',category:'FEEDBACK',note:`Fixture note ${i}`}),K());
 const before=await counts();
 const walk=async(q,limit)=>{const out=[];let cursor;let page;do{page=await support.list(H('supportOp'),{...q,limit:String(limit),...(cursor?{cursor:encodeHqSupportCursor(cursor)}:{})});out.push(...page.cases);cursor=page.nextCursor;}while(cursor);return {out,page};};
 const all=await walk({organizationId:ORG},100),ones=await walk({organizationId:ORG},1);
 assert.equal(all.out.length,5); assert.deepEqual(ones.out.map(c=>c.caseId),all.out.map(c=>c.caseId),'limit 1 walks the same order');
 assert.equal(new Set(all.out.map(c=>c.caseId)).size,5);
 assert.deepEqual(all.page.summary,{OPEN:4,WAITING_ON_SCHOOL:0,RESOLVED:0,CLOSED:1,urgentActive:0,unassignedActive:4});
 const closedOnly=await walk({organizationId:ORG,status:'CLOSED'},2);
 assert.deepEqual(closedOnly.out.map(c=>c.caseId),[c1.caseId]);
 const active=await walk({status:'ACTIVE'},2);
 assert(active.out.every(c=>c.status==='OPEN'||c.status==='WAITING_ON_SCHOOL')); assert(active.out.some(c=>c.caseId===c2.caseId)); assert(!active.out.some(c=>c.caseId===c1.caseId));
 for(const bad of [{limit:'0'},{limit:'101'},{status:'DONE'},{cursor:'bad'},{organizationId:'nope'},{schoolId:S}])await deny(support.list(H('owner'),bad),400,'INVALID_SAAS_INPUT');
 const picker=await support.schools(H('supportAgent'));
 const mine=picker.schools.filter(x=>x.organizationId===ORG||x.organizationId===ORG2);
 assert.deepEqual(mine.map(x=>[x.schoolId,x.organizationId]).sort(),[[S,ORG],[S2,ORG2]].sort());
 assert.equal(mine.find(x=>x.schoolId===S).schoolDisplayName,'HQSC Fixture Dojo Main');
 assert.equal(typeof picker.truncated,'boolean');
 for(const who of ['billingOp','plainSupport','schoolOwner','stranger','exowner'])await deny(support.schools(H(who)),403,'SAAS_FORBIDDEN');
 assert.deepEqual(await counts(),before,'reads write nothing');

 // ---------- 8. a reader revoked meanwhile gets nothing ----------
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('supportOp')]);
 await deny(support.list(H('supportOp'),{}),403,'SAAS_FORBIDDEN');
 await deny(support.note(H('supportOp'),c2.caseId,{expectedVersion:3,note:'After revocation'},K()),403,'SAAS_FORBIDDEN');
 // ...and is no longer assignable.
 await deny(support.change(H('owner'),c2.caseId,{expectedVersion:3,assigneePrincipalId:P('supportOp')},K()),422,'SUPPORT_ASSIGNEE_NOT_ELIGIBLE');
 assert.deepEqual(await counts(),before);
 console.log('HQ support records proof passed (posture, authority, open/note/change, idempotency, version, assignee eligibility, closed is final, immutable history, list paging/filter/summary, school picker, revocation).');
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);}
}
