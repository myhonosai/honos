/** School demo data (0446): real signed HON sessions -> Nest/guards -> fixed runtime SQL -> marked disposable PostgreSQL. No provider,
 *  processor, charge, message or AI. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point; the sign-up program is
 *  opened to TEST_MODE and paid access is stood in by this proof's owner connection only. Synthetic names only. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
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
const {SchoolDemoDataController}=require('./dist/school-demo-data/school-demo-data.controller.js');
const {SchoolDemoDataService}=require('./dist/school-demo-data/school-demo-data.service.js');
const guards=require('./dist/school-demo-data/school-demo-data-human-ui.guard.js');
const {SIGNUP_CONFIRMATION,verifySchoolDemoDataView}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'demo-data-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS DEMO DATA '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',
  ...(method==='POST'?{'content-type':'application/json','idempotency-key':key,'x-hon-human-command':command}:{})}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{let b=null;try{b=JSON.parse(t)}catch{}resolve({status:res.statusCode,headers:res.headers,body:b});});});
  req.on('error',reject);if(method==='POST')req.end(JSON.stringify(body));else req.end();});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body).slice(0,600));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const refused=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body).slice(0,600));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));assert(!('data' in r.body));return r.body;};
const person=label=>({externalSubject:'oidc:demo:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const base=w=>`organizations/${w.org}/schools/${w.school}/settings/demo-data`;
const read=async w=>verifySchoolDemoDataView(ok(await send(base(w),{identity:w})));
const load=(w,extra={})=>send(base(w)+'/load',{identity:w,method:'POST',command:'school.demo_data.load',body:{},...extra});
const remove=(w,view,extra={})=>send(base(w)+'/remove',{identity:w,method:'POST',command:'school.demo_data.remove',body:{setId:view.setId,expectedVersion:view.version},...extra});
const setAccess=(w,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[w.org,status]);
// Row counts of every school-scoped table for one school: what removal must give back exactly.
let scopedTables;
async function census(w){const out={};for(const t of scopedTables)out[t]=Number((await q(`SELECT count(*) n FROM hon.${t} WHERE organization_id=$1 AND school_id=$2`,[w.org,w.school]))[0].n);return out;}
const BOOKKEEPING=new Set(['audit_events','idempotency_records','school_demo_data_sets']);
function sameExceptBookkeeping(a,b,label){for(const t of scopedTables)if(!BOOKKEEPING.has(t))assert.equal(b[t],a[t],label+': '+t);}
const person0=async(w,given,family,extra={})=>(await q("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[w.org,w.school,given,family,extra.email??null,extra.phone??null]))[0].id;
async function realStudent(w,given,family,birth){
 const fam=(await q("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,$3) RETURNING id",[w.org,w.school,family+' family']))[0].id;
 const p=await person0(w,given,family);
 await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'STUDENT',false)",[w.org,w.school,fam,p]);
 const profile=(await q("INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5) RETURNING id",[w.org,w.school,p,fam,birth]))[0].id;
 return {profile,person:p,family:fam};
}
const demoIds=async(set,table)=>(await q('SELECT row_id id FROM hon.school_demo_data_rows WHERE set_id=$1 AND table_name=$2 ORDER BY row_id',[set,table])).map(r=>r.id);
const rejects=async(sql,args,code)=>{await assert.rejects(q(sql,args),e=>{assert.equal(e.message,code,e.message);return true;});};

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 scopedTables=(await q(`SELECT c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND c.relkind='r'
   AND (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('organization_id','school_id') AND NOT a.attisdropped)=2 ORDER BY 1`)).map(r=>r.t);
 // 1. Custody and exact runtime ACL.
 for(const t of ['school_demo_data_sets','school_demo_data_rows']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['read_school_demo_data','load_school_demo_data','remove_school_demo_data','demo_data_removal_allows'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%demo_data%')");
 assert.equal(fns.length,16,fns.map(f=>f.proname).join());
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.permissions p ON p.code=rp.permission_code WHERE p.code='school.demo_data.manage' AND NOT (p.is_sensitive AND p.is_staff_assignable)"))[0].n,'0');
 pass('forced deny-all RLS on two new tables; runtime executes exactly read, load, remove and the guard removal check');

 // 2. The 42 append-only guards carry exactly one added removal line before their unchanged body.
 const patched=await q("SELECT p.oid::regprocedure::text f,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.prosrc LIKE '%0446 demo data removal%'");
 assert.equal(patched.length,42);
 for(const f of patched){assert.equal(f.prosrc.split('0446 demo data removal').length,2,f.f);assert.match(f.prosrc,/\bBEGIN\n {2}IF TG_OP='DELETE' AND hon\.demo_data_removal_allows\(TG_TABLE_NAME,to_jsonb\(OLD\)\) THEN RETURN OLD; END IF; -- 0446 demo data removal\n/,f.f);}
 const canonical=readFileSync(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const section=canonical.slice(canonical.indexOf('-- School demo data exact verification (0446)'),canonical.indexOf('-- End school demo data exact verification.'));
 assert(section.length>1000);await admin.query(section.replaceAll('hon_runtime',runtime.username));
 pass('42 append-only guards patched once each, original bodies after the added line; the canonical 011 section passes');

 const module=await Test.createTestingModule({controllers:[SchoolDemoDataController],providers:[SchoolDemoDataService,...Object.values(guards),HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');

 // 3. Authority: pre-access schools, the wrong school, missing permission and non-browser commands are refused.
 refused(await send(base(a),{identity:a}),403);
 refused(await load(a),403);
 await setAccess(a,'ACTIVE');await setAccess(b,'ACTIVE');
 refused(await send(`organizations/${b.org}/schools/${b.school}/settings/demo-data`,{identity:a}),403);
 refused(await send(base(a)+'/load',{identity:a,method:'POST',command:'school.demo_data.remove',body:{}}),403);
 refused(await send(base(a)+'/load',{identity:a,method:'POST',command:'school.demo_data.load',body:{extra:1}}),400,'VALIDATION_FAILED');
 const none=await read(a);assert.equal(none.status,'NONE');assert.equal(none.lastRemovedAt,null);
 const ownerRole=(await q("SELECT r.id FROM hon.roles r WHERE r.organization_id=$1 AND r.code='OWNER'",[a.org]))[0].id;
 await q("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='school.demo_data.manage'",[ownerRole]);
 refused(await send(base(a),{identity:a}),403);
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'school.demo_data.manage')",[ownerRole,a.org]);
 pass('pre-access school, other school, wrong command, open input and a missing permission are refused');

 // 4. Load: the fixed demo school, registered row by row, fictional contacts, no outbox event, counts-only audit.
 const realBefore=await realStudent(a,'Rowan','Ashby','2015-05-05');
 const censusBefore=await census(a),censusB=await census(b),outboxBefore=Number((await q('SELECT count(*) n FROM hon.outbox_events'))[0].n);
 const key=K();
 const first=await load(a,{key});const loaded=verifySchoolDemoDataView(ok(first),'LOADED');
 assert.equal(first.body.meta.replayed,false);
 assert.deepEqual(loaded.counts,{adultStudents:8,attendance:loaded.counts.attendance,classSessions:loaded.counts.classSessions,classes:3,families:28,guardians:20,
  invoices:loaded.counts.invoices,leads:15,memberships:38,overdueInvoices:2,payments:loaded.counts.payments,programs:3,students:38});
 assert(loaded.counts.attendance>150&&loaded.counts.classSessions>=40&&loaded.counts.invoices>=76&&loaded.counts.payments>=40);
 const replay=await load(a,{key});assert.equal(replay.body.meta.replayed,true);assert.deepEqual(replay.body.data,first.body.data);
 refused(await send(base(a)+'/remove',{identity:a,method:'POST',command:'school.demo_data.remove',key,body:{setId:loaded.setId,expectedVersion:1}}),409,'IDEMPOTENCY_KEY_REUSED');
 refused(await load(a),409,'DEMO_DATA_ALREADY_LOADED');
 assert.equal(Number((await q('SELECT count(*) n FROM hon.outbox_events'))[0].n),outboxBefore,'no outbox event');
 const people=await q("SELECT p.* FROM hon.people p JOIN hon.school_demo_data_rows r ON r.table_name='people' AND r.row_id=p.id WHERE r.set_id=$1",[loaded.setId]);
 assert.equal(people.length,20+30+8+15);
 for(const p of people){assert(p.email===null||/^[a-z.]+@example\.com$/.test(p.email),p.email);assert(p.phone_e164===null||/^\+120155501\d\d$/.test(p.phone_e164),p.phone_e164);}
 assert.equal(new Set(people.filter(p=>p.phone_e164).map(p=>p.phone_e164)).size,43);
 const audit=await q("SELECT next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='school.demo_data.load'",[a.org]);
 assert.equal(audit.length,1);assert.deepEqual(Object.keys(audit[0].next_state).sort(),['counts','setId']);
 assert.equal((await q("SELECT count(*) n FROM hon.memberships m JOIN hon.school_demo_data_rows r ON r.table_name='memberships' AND r.row_id=m.id WHERE r.set_id=$1 AND m.state='ACTIVE'",[loaded.setId]))[0].n,'38');
 assert.equal((await q("SELECT count(*) n FROM hon.invoice_payment_records x JOIN hon.school_demo_data_rows r ON r.table_name='invoice_payment_records' AND r.row_id=x.id WHERE r.set_id=$1 AND x.method NOT IN ('CASH','CARD_TERMINAL')",[loaded.setId]))[0].n,'0');
 sameExceptBookkeeping(censusB,await census(b),'school B untouched by A load');
 pass('load: 28 families, 38 students, 15 leads, classes, memberships, invoices and attendance; replay, key reuse and a second load handled; fictional contacts; no outbox');

 // 5. Demo people are never contacted or charged, whatever path tries.
 const demoGuardian=people.find(p=>p.email&&p.email.startsWith('maria.')).id;
 const demoFamily=(await demoIds(loaded.setId,'families'))[0],demoAccount=(await demoIds(loaded.setId,'billing_accounts'))[0];
 await rejects("INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,created_by_principal_id) VALUES($1,$2,$3,'SMS','hi',(SELECT id FROM hon.principals LIMIT 1))",[a.org,a.school,demoGuardian],'DEMO_CONTACT_NOT_CONTACTABLE');
 await rejects("INSERT INTO hon.school_family_access_invitations(organization_id,school_id,family_id,email) VALUES($1,$2,$3,'x@example.com')",[a.org,a.school,demoFamily],'DEMO_CONTACT_NOT_CONTACTABLE');
 for(const t of ['school_pay_customers','school_pay_method_setups','school_pay_autopay_plans','school_pay_charge_attempts'])
  await rejects(`INSERT INTO hon.${t}(organization_id,school_id,billing_account_id) VALUES($1,$2,$3)`,[a.org,a.school,demoAccount],'DEMO_ACCOUNT_NOT_PAYABLE');
 pass('messages, family app invitations and every school-pay customer, method, autopay and charge insert refuse demo people and accounts');

 // 6. Guards still hold outside a removal: a demo payment record or membership decision cannot be deleted directly.
 const demoPay=(await demoIds(loaded.setId,'invoice_payment_records'))[0],demoDecision=(await demoIds(loaded.setId,'membership_activation_decisions'))[0];
 await rejects('DELETE FROM hon.invoice_payment_records WHERE id=$1',[demoPay],'INVOICE_PAYMENT_RECORD_IMMUTABLE');
 await rejects('DELETE FROM hon.membership_activation_decisions WHERE id=$1',[demoDecision],'IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE');
 await rejects("UPDATE hon.school_demo_data_sets SET status='REMOVING',version=2,removing_xact='1' WHERE id=$1",[loaded.setId],'DEMO_DATA_IMMUTABLE');
 await rejects("DELETE FROM hon.school_demo_data_rows WHERE set_id=$1",[loaded.setId],'DEMO_DATA_IMMUTABLE');
 assert.equal((await q("SELECT hon.demo_data_removal_allows('invoice_payment_records',jsonb_build_object('id',$1::text)) ok",[demoPay]))[0].ok,false);
 pass('outside a removal the guards still refuse, the registry cannot be forged and the removal check says no');

 // 7. Something real attached to demo records stops the removal; nothing changes; moving it lets removal go.
 const demoSession=(await q("SELECT s.id FROM hon.class_sessions s JOIN hon.school_demo_data_rows r ON r.table_name='class_sessions' AND r.row_id=s.id WHERE r.set_id=$1 AND s.status='SCHEDULED' ORDER BY s.starts_at LIMIT 1",[loaded.setId]))[0].id;
 const realBooking=(await q("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,source) VALUES($1,$2,$3,$4,'REGULAR','STAFF') RETURNING id",[a.org,a.school,demoSession,realBefore.profile]))[0].id;
 const blocked=refused(await remove(a,loaded),409,'DEMO_DATA_IN_USE');assert.deepEqual(blocked.tables,['class_bookings']);
 assert.equal((await read(a)).status,'LOADED');
 assert.equal((await q('SELECT count(*) n FROM hon.school_demo_data_rows WHERE set_id=$1',[loaded.setId]))[0].n,String((await q('SELECT count(*) n FROM hon.school_demo_data_rows WHERE set_id=$1 AND origin=$2',[loaded.setId,'LOADED']))[0].n));
 await q('DELETE FROM hon.class_bookings WHERE id=$1',[realBooking]);
 pass('a real student booked into a demo class stops removal with the table name and changes nothing');

 // 8. What staff add to demo people while trying HON goes with them, including append-only records.
 const demoProfile=(await demoIds(loaded.setId,'student_profiles'))[0];
 const demoInvoice=(await q("SELECT i.id,i.total_minor FROM hon.invoices i JOIN hon.school_demo_data_rows r ON r.table_name='invoices' AND r.row_id=i.id WHERE r.set_id=$1 AND i.status='ISSUED' LIMIT 1",[loaded.setId]))[0];
 const addedBooking=(await q("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,source) VALUES($1,$2,$3,$4,'REGULAR','STAFF') RETURNING id",[a.org,a.school,demoSession,demoProfile]))[0].id;
 const ownerPrincipal=(await q("SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1",[a.externalSubject]))[0].id;
 const addedPay=(await q("INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id) VALUES($1,$2,$3,$4,'USD',current_date,'CASH',$5) RETURNING id",[a.org,a.school,demoInvoice.id,demoInvoice.total_minor,ownerPrincipal]))[0].id;
 // A real lead added after the load is not demo and must survive.
 const realLeadPerson=await person0(a,'Quinn','Harlow',{email:'quinn.harlow@example.invalid'});
 const censusLoaded=await census(a);
 refused(await remove(a,{...loaded,version:2}),409,'VERSION_CONFLICT');
 const rkey=K();const removedRes=await remove(a,loaded,{key:rkey});const removed=verifySchoolDemoDataView(ok(removedRes),'NONE');
 assert(removed.lastRemovedAt);assert.equal(removedRes.body.meta.replayed,false);
 const again=await remove(a,loaded,{key:rkey});assert.equal(again.body.meta.replayed,true);assert.deepEqual(again.body.data,removedRes.body.data);
 refused(await remove(a,loaded),404,'DEMO_DATA_NOT_LOADED');
 for(const [t,id]of [['class_bookings',addedBooking],['invoice_payment_records',addedPay]])assert.equal((await q(`SELECT count(*) n FROM hon.${t} WHERE id=$1`,[id]))[0].n,'0',t);
 const set=(await q('SELECT * FROM hon.school_demo_data_sets WHERE id=$1',[loaded.setId]))[0];
 assert.equal(set.status,'REMOVED');assert.equal(set.version,3);assert(set.removed_counts.dependents>=17,JSON.stringify(set.removed_counts));
 assert.equal((await q('SELECT count(*) n FROM hon.school_demo_data_rows WHERE set_id=$1',[loaded.setId]))[0].n,'0');
 pass('removal takes the demo set and what staff added to demo people (booking, payment record), with exact replay, version and not-loaded refusals');

 // 9. Removal gives the school back exactly: every school-scoped table has its pre-load count (plus the real lead person
 //    added while loaded), real rows untouched, no demo contact anywhere, school B untouched.
 const after=await census(a);
 for(const t of scopedTables){if(BOOKKEEPING.has(t))continue;assert.equal(after[t],censusBefore[t]+(t==='people'?1:0),t);}
 assert(censusLoaded.people>after.people);
 for(const id of [realBefore.person,realLeadPerson])assert.equal((await q('SELECT count(*) n FROM hon.people WHERE id=$1',[id]))[0].n,'1');
 assert.equal((await q('SELECT count(*) n FROM hon.student_profiles WHERE id=$1',[realBefore.profile]))[0].n,'1');
 for(const t of scopedTables){
  const hit=(await q(`SELECT count(*) n FROM hon.${t} x WHERE x.organization_id=$1 AND (to_jsonb(x)::text LIKE '%@example.com%' OR to_jsonb(x)::text LIKE '%+1201555%')`,[a.org]))[0].n;
  assert.equal(hit,'0',t);
 }
 sameExceptBookkeeping(censusB,await census(b),'school B untouched by A removal');
 const removeAudit=await q("SELECT next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='school.demo_data.remove'",[a.org]);
 assert.equal(removeAudit.length,1);assert.doesNotMatch(JSON.stringify(removeAudit),/example\.com|Rivera|Maria/);
 pass('every school-scoped table back to its pre-load count, real rows kept, no demo contact left anywhere, other school untouched');

 // 10. Two schools at once, and a second round in the same school.
 const bl=verifySchoolDemoDataView(ok(await load(b)),'LOADED');
 const second=verifySchoolDemoDataView(ok(await load(a)),'LOADED');assert.notEqual(second.setId,loaded.setId);
 verifySchoolDemoDataView(ok(await remove(a,second)),'NONE');
 assert.equal((await read(b)).setId,bl.setId);
 assert.equal(Number((await q("SELECT count(*) n FROM hon.school_demo_data_rows WHERE set_id=$1",[bl.setId]))[0].n)>800,true);
 verifySchoolDemoDataView(ok(await remove(b,bl)),'NONE');
 sameExceptBookkeeping(censusB,await census(b),'school B back after its own round');
 pass('two schools load independently; removing one keeps the other; a school can load and remove again');
 console.log(`School demo data proof passed: ${groups} groups.`);
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
