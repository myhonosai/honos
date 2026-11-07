/** B-CRM-1a person record read + update (0217 proposed). Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {SchoolPersonRecordService}=require('./dist/people/school-person-record.service.js');
const {SchoolPersonRecordController,SchoolPersonRecordHumanGuard}=require('./dist/people/school-person-record.controller.js');
const {PERSON_RECORD_HUMAN_COMMAND}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),blocker=new pg.Client({connectionString:owner.toString(),ssl:false}),blocker2=new pg.Client({connectionString:owner.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'b-crm-1a-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS PERSON-RECORD '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:bcrm1a:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':PERSON_RECORD_HUMAN_COMMAND,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
const tables=['people','audit_events','outbox_events','idempotency_records','communication_consents','student_profiles','family_members'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
const snapshot=async id=>(await q('SELECT given_name,family_name,email::text email,phone_e164,version,updated_at FROM hon.people WHERE id=$1',[id]))[0];
async function denied(work,status,code,personId){
 const before=await counts(),row=personId?await snapshot(personId):null;const r=await work();
 assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));
 assert.deepEqual(await counts(),before);if(personId)assert.deepEqual(await snapshot(personId),row);
 assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/SQLSTATE|SELECT |external_subject|hon\./));return r;
}
async function human(identity,label,active=true){
 const user=K(),principal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,$4)",[principal,user,label,active]);
 return principal;
}
async function customRole(o,code,perms){
 const id=(await q("INSERT INTO hon.roles(organization_id,management_school_id,code,name) VALUES($1,$2,$3,$4) RETURNING id",[o.organizationId,o.schoolId,code,code.replace('CUSTOM_','')]))[0].id;
 for(const p of perms)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[id,o.organizationId,p]);
 return id;
}
const grant=async(o,principal,role)=>(await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval \'1 minute\') RETURNING id',[o.organizationId,o.schoolId,principal,role]))[0].id;
const addPerson=async(o,given,family,email=null,phone=null)=>(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[o.organizationId,o.schoolId,given,family,email,phone]))[0].id;
const read=(identity,schoolId,personId)=>send('school/schools/'+schoolId+'/people/'+personId,{identity,method:'GET'});
const body=(schoolId,personId,expectedVersion,patch={})=>({schoolId,personId,expectedVersion,givenName:'Ana',familyName:'Rivera',email:'ana@example.invalid',phoneE164:'+15555550100',...patch});
const update=(identity,b,key)=>send('school/people/update',{identity,body:b,key});
const waitFor=async(sql,label)=>{for(let i=0;i<300;i++){if((await q(sql))[0].n!=='0')return;await new Promise(r=>setTimeout(r,10));}throw new Error(label);};
const waitForAdvisoryWait=()=>waitFor("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND NOT granted",'never waited on the consent advisory lock');
const {CommunicationConsentService,COMMUNICATION_CONSENT_ADVISORY_LOCK_SQL}=require('./dist/communication/communication-consent.service.js');
// Exactly the canonical consent writer's serialization key (communication-consent.service.ts), not a copy.
const consentKey=COMMUNICATION_CONSENT_ADVISORY_LOCK_SQL;
assert.match(consentKey,/\$1::uuid::text/);
const waitForLockWait=async()=>{for(let i=0;i<200;i++){if((await q("SELECT count(*) n FROM pg_locks WHERE NOT granted"))[0].n!=='0')return;await new Promise(r=>setTimeout(r,10));}throw new Error('update never waited on the person lock');};

try{
 await Promise.all([admin.connect(),restricted.connect(),blocker.connect(),blocker2.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL: still no UPDATE on people; exactly two fixed entry points; helpers private.
 for(const p of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.people',p]))[0].ok,false,p);
 const fns=await q("SELECT p.oid,p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN ('school_person_actor','school_person_json','read_school_person','update_school_person')");
 assert.equal(fns.length,4);
 for(const f of fns){const entry=['read_school_person','update_school_person'].includes(f.proname);
  assert.equal(f.prosecdef,entry,f.proname);assert.deepEqual(f.proconfig,['search_path=pg_catalog, hon'],f.proname);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry,f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 const perm=(await q("SELECT is_staff_assignable,is_sensitive FROM hon.permissions WHERE code='people.update'"))[0];assert.deepEqual(perm,{is_staff_assignable:true,is_sensitive:false});
 pass('runtime has no UPDATE on hon.people; only the read and the update are executable; people.update is staff assignable');

 // Fixture: two HQ-provisioned schools with active paid access; editors, a reader, an update-only role, a parent, outsiders.
 const hq={subject:'bcrm1a-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'B-CRM-1a synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'B-CRM-1a synthetic','B-CRM-1a synthetic','B-CRM-1a school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'bcrm1a-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code='people.update'",[A.organizationId]))[0].n,'1');
 const editRole=await customRole(A,'CUSTOM_FRONT_DESK_EDIT',['school.view','people.read','people.update']);
 const editor=person('editor'),editorPrincipal=await human(editor,'Editor');const editorGrant=await grant(A,editorPrincipal,editRole);
 const editor2=person('editor-2'),editor2Principal=await human(editor2,'Editor 2');const editor2Grant=await grant(A,editor2Principal,editRole);
 const editor3=person('editor-3');await grant(A,await human(editor3,'Editor 3'),editRole);
 const reader=person('reader');await grant(A,await human(reader,'Reader'),await customRole(A,'CUSTOM_FRONT_DESK_READ',['school.view','people.read']));
 const updateOnly=person('update-only');await grant(A,await human(updateOnly,'Update only'),await customRole(A,'CUSTOM_UPDATE_ONLY',['school.view','people.update']));
 const inactive=person('inactive');await grant(A,await human(inactive,'Inactive',false),editRole);
 const editorB=person('editor-b');await grant(B,await human(editorB,'Editor B'),await customRole(B,'CUSTOM_FRONT_DESK_EDIT',['school.view','people.read','people.update']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const parent=person('parent'),parentPrincipal=await human(parent,'Parent');
 const fam=(await q("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,'Rivera family') RETURNING id",[A.organizationId,A.schoolId]))[0].id;
 await q("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',clock_timestamp()-interval '1 minute',$5)",[A.organizationId,A.schoolId,fam,parentPrincipal,editorPrincipal]);
 const student=await addPerson(A,'Ana','Rivera','ana@example.invalid','+15555550100');
 await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5)',[A.organizationId,A.schoolId,student,fam,'2015-04-02']);
 await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')",[A.organizationId,A.schoolId,fam,student]);
 const guardian=await addPerson(A,'Luis','Rivera','luis@example.invalid',null);
 const personB=await addPerson(B,'Other','School');
 const module=await Test.createTestingModule({controllers:[SchoolPersonRecordController],providers:[SchoolPersonRecordService,SchoolPersonRecordHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. Read: exact shape, student profile, consent defaults, canEdit from live authority.
 const r1=ok(await read(editor,A.schoolId,student));
 assert.deepEqual({...r1,updatedAt:undefined},{personId:student,schoolId:A.schoolId,givenName:'Ana',familyName:'Rivera',email:'ana@example.invalid',phoneE164:'+15555550100',version:1,updatedAt:undefined,
  student:{birthDate:'2015-04-02',status:'ACTIVE',version:1},consents:{EMAIL:'NOT_RECORDED',SMS:'NOT_RECORDED'},canEdit:true});
 assert.equal(ok(await read(reader,A.schoolId,student)).canEdit,false);
 assert.equal(ok(await read(editor,A.schoolId,guardian)).student,null);
 pass('read returns the closed record with student profile, consent states and canEdit from live authority');

 // 3. Read and update denials: no authority, other school, parent, inactive, update-only; nothing written.
 for(const who of [outsider,parent,inactive,updateOnly])await denied(()=>read(who,A.schoolId,student),403,'PERSON_FORBIDDEN');
 await denied(()=>read(editorB,A.schoolId,student),403,'PERSON_FORBIDDEN');
 await denied(()=>read(editorB,B.schoolId,student),404,'PERSON_UNAVAILABLE');
 await denied(()=>read(editor,A.schoolId,personB),404,'PERSON_UNAVAILABLE');
 for(const who of [outsider,parent,inactive,updateOnly,reader])await denied(()=>update(who,body(A.schoolId,student,1,{familyName:'X'})),403,'PERSON_FORBIDDEN',student);
 await denied(()=>update(editorB,body(B.schoolId,student,1,{familyName:'X'})),404,'PERSON_UNAVAILABLE',student);
 await denied(()=>update(editor,body(A.schoolId,personB,1,{givenName:'X',familyName:'Y',email:null,phoneE164:null})),404,'PERSON_UNAVAILABLE',personB);
 pass('outsiders, parents, inactive principals, read-only and update-only staff, and other schools are refused with nothing written');

 // 4. Closed input: forged scope keys, bad formats, and direct runtime SQL shape errors.
 for(const patch of [{organizationId:A.organizationId},{principalId:K()},{givenName:''},{givenName:'x'.repeat(121)},{givenName:'A\u0007'},{email:'not-an-email'},{phoneE164:'5555550100'},{expectedVersion:0},{expectedVersion:'1'},{birthDate:'2015-01-01'}])
  await denied(()=>update(editor,body(A.schoolId,student,1,{familyName:'X',...patch})),400,'PERSON_INPUT_INVALID',student);
 const {email:_e,...missing}=body(A.schoolId,student,1);await denied(()=>update(editor,missing),400,'PERSON_INPUT_INVALID',student);
 await denied(()=>send('school/people/update',{identity:editor,body:body(A.schoolId,student,1,{familyName:'X'}),key:'not-a-uuid'}),400,'PERSON_INPUT_INVALID',student);
 await denied(()=>send('school/people/update',{identity:editor,body:body(A.schoolId,student,1,{familyName:'X'}),headers:{'x-hon-human-command':'school-family-account'}}),403,'HUMAN_UI_REQUIRED',student);
 await denied(()=>send('school/people/update',{identity:editor,body:body(A.schoolId,student,1,{familyName:'X'}),headers:{'x-hon-school-id':B.schoolId}}),403,'HUMAN_UI_REQUIRED',student);
 await assert.rejects(()=>restricted.query("SELECT hon.update_school_person($1,$2::jsonb,$3::uuid)",[editor.externalSubject,JSON.stringify({...body(A.schoolId,student,1),extra:1}),K()]),e=>e.code==='22023');
 await assert.rejects(()=>restricted.query('UPDATE hon.people SET given_name=$1 WHERE id=$2',['X',student]),e=>e.code==='42501');
 await assert.rejects(()=>restricted.query("SELECT hon.school_person_actor($1,$2::uuid,true)",[editor.externalSubject,A.schoolId]),e=>e.code==='42501');
 pass('closed body, header and key checks; forged organization/principal refused; runtime cannot UPDATE people or call helpers');

 // 5. Successful edit: version, audit with prior/next, outbox without contact values, replay, key reuse, version conflict, unchanged.
 const before=await counts(),key=K(),edit=body(A.schoolId,student,1,{familyName:'  Rivera-Lopez ',email:'ANA.R@Example.invalid',phoneE164:null});
 const done=ok(await update(editor,edit,key));
 assert.deepEqual(done.changedFields,['familyName','email','phoneE164']);
 assert.equal(done.person.version,2);assert.equal(done.person.familyName,'Rivera-Lopez');assert.equal(done.person.email,'ana.r@example.invalid');assert.equal(done.person.phoneE164,null);
 assert.deepEqual(await snapshot(student).then(s=>({...s,updated_at:undefined})),{given_name:'Ana',family_name:'Rivera-Lopez',email:'ana.r@example.invalid',phone_e164:null,version:2,updated_at:undefined});
 const after=await counts();
 for(const t of ['audit_events','outbox_events','idempotency_records'])assert.equal(Number(after[t]),Number(before[t])+1,t);
 const audit=(await q("SELECT actor_principal_id,source,prior_state,next_state,result FROM hon.audit_events WHERE action_code='people.update' AND entity_id=$1",[student]))[0];
 assert.equal(audit.actor_principal_id,editorPrincipal);assert.equal(audit.source,'HUMAN_UI');assert.equal(audit.result,'SUCCEEDED');
 assert.deepEqual(audit.prior_state,{givenName:'Ana',familyName:'Rivera',email:'ana@example.invalid',phoneE164:'+15555550100',version:1});
 assert.deepEqual(audit.next_state.changedFields,['familyName','email','phoneE164']);
 const outbox=(await q("SELECT payload,aggregate_version FROM hon.outbox_events WHERE event_type='people.person.updated' AND aggregate_id=$1",[student]))[0];
 assert.deepEqual(outbox.payload,{personId:student,version:2,changedFields:['familyName','email','phoneE164']});assert.equal(outbox.aggregate_version,2);
 assert.deepEqual(ok(await update(editor,edit,key)),done);assert.deepEqual(await counts(),after);
 await denied(()=>update(editor,{...edit,givenName:'Anna'},key),409,'PERSON_IDEMPOTENCY_CONFLICT',student);
 await denied(()=>update(editor2,body(A.schoolId,student,1,{givenName:'Anna'})),409,'PERSON_VERSION_CONFLICT',student);
 await denied(()=>update(editor2,body(A.schoolId,student,2,{familyName:'Rivera-Lopez',email:'ana.r@example.invalid',phoneE164:null})),400,'PERSON_UNCHANGED',student);
 pass('edit bumps the version, audits prior and next state, emits an outbox event with field names only, replays exactly, refuses key reuse, stale versions and no-op edits');

 // 6. Consent: an opt-in never moves to a new or cleared address; names still editable; opted-out or unrecorded channels editable.
 await q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'EMAIL','OPTED_IN','STAFF',clock_timestamp(),$4)",[A.organizationId,A.schoolId,guardian,editorPrincipal]);
 await q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'SMS','OPTED_OUT','STAFF',clock_timestamp(),$4)",[A.organizationId,A.schoolId,guardian,editorPrincipal]);
 assert.deepEqual(ok(await read(editor,A.schoolId,guardian)).consents,{EMAIL:'OPTED_IN',SMS:'OPTED_OUT'});
 const g=p=>body(A.schoolId,guardian,1,{givenName:'Luis',familyName:'Rivera',email:'luis@example.invalid',phoneE164:null,...p});
 await denied(()=>update(editor,g({email:'new@example.invalid'})),409,'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED',guardian);
 await denied(()=>update(editor,g({email:null})),409,'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED',guardian);
 const g2=ok(await update(editor,g({email:'LUIS@example.invalid',givenName:'Luís',phoneE164:'+15555550111'})));
 assert.deepEqual(g2.changedFields,['givenName','phoneE164']);assert.equal(g2.person.email,'luis@example.invalid');
 const mixed=await addPerson(A,'Mia','Chen','Mia.Chen@Example.invalid');
 assert.deepEqual(ok(await update(editor3,body(A.schoolId,mixed,1,{givenName:'Mia',familyName:'Chen-Li',email:'mia.chen@example.invalid',phoneE164:null}))).changedFields,['familyName']);
 assert.equal((await snapshot(mixed)).email,'Mia.Chen@Example.invalid');
 await q("UPDATE hon.communication_consents SET status='OPTED_IN',version=version+1 WHERE person_id=$1 AND channel='SMS'",[guardian]);
 await denied(()=>update(editor,body(A.schoolId,guardian,2,{givenName:'Luís',familyName:'Rivera',email:'luis@example.invalid',phoneE164:'+15555550122'})),409,'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED',guardian);
 pass('a contact change or clear is refused while that channel is opted in; names and other channels stay editable; case-only email is not a change');

 // 7. Suspended paid access: read and edit refused, nothing written; restored access works again.
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>read(editor,A.schoolId,student),403,'PERSON_FORBIDDEN');
 await denied(()=>update(editor,body(A.schoolId,student,2,{givenName:'Anna',familyName:'Rivera-Lopez',email:'ana.r@example.invalid',phoneE164:null})),403,'PERSON_FORBIDDEN',student);
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[A.organizationId]);
 assert.equal(ok(await read(editor,A.schoolId,student)).version,2);
 pass('a school without paid access in effect can neither read nor edit; restoring access restores both');

 // 8. Authority decided after the last write: revoked, or expired by the clock, while waiting on the person lock commits nothing.
 for(const [label,end,grantId,who] of [['revoked',"revoked_at=clock_timestamp(),revoked_by_principal_id=granted_by_principal_id",editor2Grant,editor2],['expired',"effective_until=clock_timestamp()",editorGrant,editor]]){
  const row=await snapshot(student),c=await counts();
  await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM hon.people WHERE id=$1 FOR UPDATE',[student]);
  const pending=update(who,body(A.schoolId,student,row.version,{givenName:'Anna-'+label,familyName:'Rivera-Lopez',email:'ana.r@example.invalid',phoneE164:null}));
  await waitForLockWait();
  await q('UPDATE hon.principal_role_grants SET '+end+' WHERE id=$1',[grantId]);
  await blocker.query('COMMIT');
  const r=await pending;assert.equal(r.status,403,label+':'+JSON.stringify(r.body));assert.equal(r.body.code,'PERSON_FORBIDDEN');
  assert.deepEqual(await snapshot(student),row,label);assert.deepEqual(await counts(),c,label);
 }
 pass('a grant revoked, or ended by the clock, while the edit waited on the person lock commits nothing');
 // 9. Lock order matches the CRM registration flows (people before idempotency_records): no deadlock with a SHARE ROW EXCLUSIVE holder.
 {const row=await snapshot(student);
  await blocker.query('BEGIN');await blocker.query('LOCK TABLE hon.people IN SHARE ROW EXCLUSIVE MODE');
  const pending=update(editor3,body(A.schoolId,student,row.version,{givenName:'Anna',familyName:'Rivera-Lopez',email:'ana.r@example.invalid',phoneE164:null}));
  await waitForLockWait();
  await blocker.query('LOCK TABLE hon.idempotency_records IN SHARE ROW EXCLUSIVE MODE');
  await blocker.query('COMMIT');
  const r=ok(await pending);assert.equal(r.person.version,row.version+1);assert.deepEqual(r.changedFields,['givenName']);}
 pass('the edit takes the people lock before the idempotency insert, so a CRM-style SHARE ROW EXCLUSIVE holder never deadlocks with it');
 // 10. Contact edits serialize with consent capture through the canonical person/channel advisory lock.
 const effects=async()=>Object.fromEntries(await Promise.all(['audit_events','outbox_events','idempotency_records'].map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
 const consentRow=(o,id,channel,status)=>q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,$4,$5,'STAFF',clock_timestamp(),$6)",[o.organizationId,o.schoolId,id,channel,status,editorPrincipal]);
 const raceEdit=(id,patch)=>update(editor3,body(A.schoolId,id,1,{givenName:'Race',familyName:'Case',email:'race-a@example.invalid',phoneE164:'+15555550200',...patch}));
 for(const [label,channel,patch,prepare,capture] of [
  ['existing EMAIL opt-in','EMAIL',{email:'race-b@example.invalid'},id=>consentRow(A,id,'EMAIL','OPTED_OUT'),id=>blocker.query("UPDATE hon.communication_consents SET status='OPTED_IN',version=version+1 WHERE person_id=$1 AND channel='EMAIL'",[id])],
  ['existing EMAIL opt-in, email cleared','EMAIL',{email:null},id=>consentRow(A,id,'EMAIL','OPTED_OUT'),id=>blocker.query("UPDATE hon.communication_consents SET status='OPTED_IN',version=version+1 WHERE person_id=$1 AND channel='EMAIL'",[id])],
  ['first SMS opt-in','SMS',{phoneE164:'+15555550299'},async()=>{},id=>blocker.query("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'SMS','OPTED_IN','STAFF',clock_timestamp(),$4)",[A.organizationId,A.schoolId,id,editorPrincipal])],
  ['first EMAIL opt-in','EMAIL',{email:'race-c@example.invalid'},async()=>{},id=>blocker.query("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'EMAIL','OPTED_IN','STAFF',clock_timestamp(),$4)",[A.organizationId,A.schoolId,id,editorPrincipal])]]){
  const id=await addPerson(A,'Race','Case','race-a@example.invalid','+15555550200');await prepare(id);
  const row=await snapshot(id),before=await effects();
  await blocker.query('BEGIN');await blocker.query(consentKey,[id,channel]);await capture(id);
  const pending=raceEdit(id,patch);
  await waitForAdvisoryWait();
  await blocker.query('COMMIT');
  const r=await pending;assert.equal(r.status,409,label+':'+JSON.stringify(r.body));assert.equal(r.body.code,'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED',label);
  assert.deepEqual(await snapshot(id),row,label);assert.deepEqual(await effects(),before,label);
 }
 // Reverse order: the edit holds the advisory lock first (paused on the consent row), the consent writer waits for it;
 // both finish without deadlock and the later opt-in is for the new address.
 {const id=await addPerson(A,'Race','Case','race-a@example.invalid','+15555550200');await consentRow(A,id,'EMAIL','OPTED_OUT');
  await blocker.query('BEGIN');await blocker.query("SELECT 1 FROM hon.communication_consents WHERE person_id=$1 AND channel='EMAIL' FOR UPDATE",[id]);
  const pending=raceEdit(id,{email:'race-d@example.invalid'});
  await waitFor("SELECT count(*) n FROM pg_locks WHERE locktype='transactionid' AND NOT granted",'edit never reached the consent row');
  await blocker2.query('BEGIN');const writer=blocker2.query(consentKey,[id,'EMAIL']);
  await waitForAdvisoryWait();
  await blocker.query('ROLLBACK');
  const r=ok(await pending);assert.deepEqual(r.changedFields,['email']);
  await writer;await blocker2.query("UPDATE hon.communication_consents SET status='OPTED_IN',version=version+1 WHERE person_id=$1 AND channel='EMAIL'",[id]);await blocker2.query('COMMIT');
  assert.equal((await snapshot(id)).email,'race-d@example.invalid');
  assert.deepEqual(ok(await read(editor3,A.schoolId,id)).consents,{EMAIL:'OPTED_IN',SMS:'NOT_RECORDED'});}
 pass('a consent capture in flight (existing opt-in or first insert, EMAIL and SMS, change or clear) makes the edit refuse with nothing written; in the reverse order both finish without deadlock');
 // 11. The real consent writer with an UPPERCASE person selector (accepted by its UUID check and ParseUUIDPipe) takes the
 // same canonical lock: its first opt-in, held open after the insert, makes the contact edit wait and then refuse.
 {const consents=new CommunicationConsentService(database);
  const id=await addPerson(A,'Race','Case','race-a@example.invalid','+15555550200'),row=await snapshot(id);
  const editEffects=async()=>(await q("SELECT (SELECT count(*) FROM hon.audit_events WHERE action_code='people.update' AND entity_id=$1) a,(SELECT count(*) FROM hon.outbox_events WHERE event_type='people.person.updated' AND payload->>'personId'=$1::text) o,(SELECT count(*) FROM hon.idempotency_records WHERE idempotency_key LIKE 'people.update:%') k",[id]))[0];
  const before=await editEffects();
  await blocker.query('BEGIN');await blocker.query('LOCK TABLE hon.audit_events IN SHARE MODE');
  const writer=consents.record({organizationId:A.organizationId,schoolId:A.schoolId,principalId:editorPrincipal,principalType:'HUMAN_USER',requestId:K(),correlationId:K(),idempotencyKey:'upper-'+K(),source:'HUMAN_UI'},
   id.toUpperCase(),'EMAIL',{status:'OPTED_IN',source:'STAFF',capturedAt:new Date().toISOString()});
  await waitFor("SELECT count(*) n FROM pg_locks WHERE NOT granted AND relation='hon.audit_events'::regclass",'consent writer never reached its evidence insert');
  const pending=raceEdit(id,{email:'race-e@example.invalid'});
  await waitFor("SELECT (count(*)>=2)::int::text n FROM pg_locks WHERE NOT granted",'edit never waited');
  await blocker.query('COMMIT');
  const w=await writer;assert.equal(w.created,true);assert.equal(w.consent.status,'OPTED_IN');
  const r=await pending;assert.equal(r.status,409,'uppercase first opt-in:'+JSON.stringify(r.body));assert.equal(r.body.code,'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED');
  assert.deepEqual(await snapshot(id),row);assert.deepEqual(await editEffects(),before);
  assert.deepEqual(ok(await read(editor3,A.schoolId,id)).consents,{EMAIL:'OPTED_IN',SMS:'NOT_RECORDED'});}
 pass('the real consent writer with an uppercase person selector shares the canonical lock: its in-flight first opt-in makes the edit refuse with no contact, audit, outbox or key effects');
 // 12. B-CRM-1b birth date: posture. One new definer entry point; helpers and the corrections table private.
 {const fn=(await q("SELECT p.oid,p.prosecdef,p.proconfig FROM pg_proc p WHERE p.oid='hon.update_school_student_birth_date(text,jsonb,uuid)'::regprocedure"))[0];
  assert.equal(fn.prosecdef,true);assert.deepEqual(fn.proconfig,['search_path=pg_catalog, hon']);
  assert.equal((await q("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok",[runtime.username,fn.oid]))[0].ok,true);
  for(const h of ['hon.crm_guardian_child_current_identity(uuid,uuid,uuid)','hon.record_crm_guardian_child_identity_correction(uuid,uuid,uuid,uuid,uuid)','hon.school_person_is_owner(uuid,uuid)','hon.crm_guardian_child_child_relation(uuid)'])
   for(const who of [runtime.username,'public'])assert.equal((await q("SELECT has_function_privilege($1,$2::regprocedure,'EXECUTE') ok",[who,h]))[0].ok,false,h+' '+who);
  assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int policies FROM pg_class c WHERE oid='hon.crm_guardian_child_identity_corrections'::regclass"))[0],{r:true,f:true,policies:0});
  for(const pr of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await q("SELECT has_table_privilege($1,'hon.crm_guardian_child_identity_corrections',$2) ok",[runtime.username,pr]))[0].ok,false,pr);
  for(const pr of ['UPDATE','DELETE'])assert.equal((await q("SELECT has_table_privilege($1,'hon.student_profiles',$2) ok",[runtime.username,pr]))[0].ok,false,pr);}
 pass('birth date: one definer entry point for the runtime; the corrections table, helpers and the child relation stay private; no UPDATE on student_profiles');

 // 13. Birth date correction by delegated staff: version, reason audited, outbox without the date, replay, conflicts, refusals.
 const ownerRole=(await q("SELECT id FROM hon.roles WHERE organization_id=$1 AND code='OWNER' AND is_system_role",[A.organizationId]))[0].id;
 const owner=person('owner'),ownerPrincipal=await human(owner,'Owner');const ownerGrant=await grant(A,ownerPrincipal,ownerRole);
 const bd=(personId,expectedVersion,birthDate,reason='Parent supplied the passport date')=>({schoolId:A.schoolId,personId,expectedVersion,birthDate,reason});
 const setBirth=(identity,b,key=K())=>send('school/people/birth-date',{identity,body:b,key});
 const profile=async id=>(await q('SELECT birth_date::text birth_date,version,updated_at FROM hon.student_profiles WHERE person_id=$1',[id]))[0];
 const kid=await addPerson(A,'Kai','Moreno');
 await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5)',[A.organizationId,A.schoolId,kid,fam,'2016-03-01']);
 const bdDenied=async(work,status,code,id)=>{const row=id?await profile(id):null,c=await counts();const r=await work();
  assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.body.code,code);if(id)assert.deepEqual(await profile(id),row);assert.deepEqual(await counts(),c);};
 {const c=await counts(),key=K(),b=bd(kid,1,'2016-04-01',' Parent supplied the passport date ');
  const r=ok(await setBirth(editor3,b,key));
  assert.deepEqual(r.changedFields,['birthDate']);assert.equal(r.enrollmentCorrected,false);
  assert.deepEqual(r.person.student,{birthDate:'2016-04-01',status:'ACTIVE',version:2});assert.equal(r.person.version,1);
  const after=await counts();for(const t of ['audit_events','outbox_events','idempotency_records'])assert.equal(Number(after[t]),Number(c[t])+1,t);
  const audit=(await q("SELECT prior_state,next_state,entity_type FROM hon.audit_events WHERE action_code='people.student.birth_date.update' AND next_state->>'personId'=$1",[kid]))[0];
  assert.equal(audit.entity_type,'STUDENT_PROFILE');assert.deepEqual(audit.prior_state,{personId:kid,birthDate:'2016-03-01',version:1});
  assert.deepEqual(audit.next_state,{personId:kid,birthDate:'2016-04-01',version:2,reason:'Parent supplied the passport date',minorToAdult:false,enrollmentCorrected:false});
  const ob=(await q("SELECT payload FROM hon.outbox_events WHERE event_type='people.student.updated' AND payload->>'personId'=$1",[kid]))[0].payload;
  assert.deepEqual(Object.keys(ob).sort(),['changedFields','personId','studentProfileId','version']);assert(!JSON.stringify(ob).includes('2016'));
  assert.deepEqual(ok(await setBirth(editor3,b,key)),r);assert.deepEqual(await counts(),after);
  await bdDenied(()=>setBirth(editor3,{...b,birthDate:'2016-05-01'},key),409,'PERSON_IDEMPOTENCY_CONFLICT',kid);}
 await bdDenied(()=>setBirth(editor3,bd(kid,1,'2016-05-01')),409,'PERSON_VERSION_CONFLICT',kid);
 await bdDenied(()=>setBirth(editor3,bd(kid,2,'2016-04-01')),400,'PERSON_UNCHANGED',kid);
 const tomorrow=new Date(Date.now()+2*864e5).toISOString().slice(0,10);
 for(const b of [bd(kid,2,tomorrow),bd(kid,2,'1899-12-31'),bd(kid,2,'2016-02-30'),bd(kid,2,'2016-05-01',''),{...bd(kid,2,'2016-05-01'),organizationId:A.organizationId},{...bd(kid,2,'2016-05-01'),birthDate:null}])
  await bdDenied(()=>setBirth(editor3,b),400,'PERSON_INPUT_INVALID',kid);
 await bdDenied(()=>setBirth(editor3,bd(guardian,1,'1980-01-01')),404,'PERSON_UNAVAILABLE');
 await bdDenied(()=>setBirth(editorB,{...bd(kid,2,'2016-05-01'),schoolId:B.schoolId}),404,'PERSON_UNAVAILABLE',kid);
 for(const who of [reader,updateOnly,parent,outsider,inactive])await bdDenied(()=>setBirth(who,bd(kid,2,'2016-05-01')),403,'PERSON_FORBIDDEN',kid);
 await assert.rejects(()=>restricted.query('UPDATE hon.student_profiles SET birth_date=$1 WHERE person_id=$2',['2000-01-01',kid]),e=>e.code==='42501');
 pass('a delegated editor corrects a birth date with a reason: version, audit with the reason, outbox without the date, replay, key reuse, stale and unchanged edits, future and invalid dates, no profile, other school and no authority refused with nothing written');

 // 14. Minor to adult needs a school OWNER (it removes the 0177 guardian-of-record requirement); stricter or first-time dates do not.
 const adultDate=(new Date().getUTCFullYear()-30)+'-01-15';
 await bdDenied(()=>setBirth(editor3,bd(kid,2,adultDate)),403,'PERSON_BIRTH_DATE_OWNER_REQUIRED',kid);
 {const r=ok(await setBirth(owner,bd(kid,2,adultDate,'Registered under the wrong date; adult member')));assert.equal(r.person.student.birthDate,adultDate);
  assert.equal((await q("SELECT next_state->>'minorToAdult' m FROM hon.audit_events WHERE action_code='people.student.birth_date.update' AND next_state->>'personId'=$1 AND next_state->>'version'='3'",[kid]))[0].m,'true');}
 assert.equal(ok(await setBirth(editor3,bd(kid,3,'2017-06-01'))).person.student.birthDate,'2017-06-01');
 const unknown=await addPerson(A,'Noa','Moreno');
 await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id) VALUES($1,$2,$3,$4)',[A.organizationId,A.schoolId,unknown,fam]);
 assert.equal(ok(await setBirth(editor3,bd(unknown,1,adultDate))).person.student.birthDate,adultDate);
 // The owner rule is decided again after the last write: an OWNER grant revoked while the crossing waited commits nothing.
 {const row=await profile(kid),c=await counts();
  await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM hon.student_profiles WHERE person_id=$1 FOR UPDATE',[kid]);
  const pending=setBirth(owner,bd(kid,row.version,adultDate));
  await waitForLockWait();
  await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=granted_by_principal_id WHERE id=$1',[ownerGrant]);
  await blocker.query('COMMIT');
  const r=await pending;assert.equal(r.status,403,JSON.stringify(r.body));assert.deepEqual(await profile(kid),row);assert.deepEqual(await counts(),c);}
 pass('making a known minor an adult needs a live school OWNER grant (an OWNER grant revoked while the change waited on the student lock commits nothing); staff may make a date stricter or set a first one');
 console.log('B-CRM-1a/1b person record proof: '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end(),blocker.end(),blocker2.end()]);
}
