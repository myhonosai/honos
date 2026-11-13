/** School support requests (0335): real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL.
 *  No provider, payment, message or AI. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point; the sign-up program is opened
 *  to TEST_MODE by this proof's owner connection only. Entitlements are changed by the owner connection to stand in for a trial or paid access. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
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
const {SchoolSupportController}=require('./dist/support/school-support.controller.js');
const {SchoolSupportService}=require('./dist/support/school-support.service.js');
const {SchoolSupportReadHumanUiGuard,SchoolSupportSubmitHumanUiGuard,SchoolSupportMessageHumanUiGuard}=require('./dist/support/school-support.guard.js');
const {SIGNUP_CONFIRMATION,SUPPORT_SUBMIT_COMMAND,SUPPORT_MESSAGE_COMMAND,verifySupportRequestList}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'support-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS SUPPORT '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=SUPPORT_SUBMIT_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const person=label=>({externalSubject:'oidc:support:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const base=w=>`organizations/${w.org}/schools/${w.school}/support-requests`;
const list=async w=>verifySupportRequestList(ok(await send(base(w),{identity:w})));
const ask={topic:'GETTING_STARTED',subject:'How do I add my first class?',message:'We teach kids on Tuesdays.\nWhere do I start?',pageHint:'/staff/welcome'};
const submit=(w,body,key=K(),extra={})=>send(base(w),{identity:w,method:'POST',key,body,...extra});
const reply=(w,id,message,key=K(),extra={})=>send(base(w)+'/'+id+'/messages',{identity:w,method:'POST',key,command:SUPPORT_MESSAGE_COMMAND,body:{message},...extra});
const evidence=async w=>(await q("SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'support.request.%') a,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'support.request.%') o",[w.org]))[0];
const hqSubject='oidc:support:hq:'+K();
const hq=(fn,args)=>restricted.query(`SELECT hon.${fn} data`,args).then(r=>r.rows[0].data);

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['school_support_requests','school_support_commands']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['submit_school_support_request','add_school_support_message','read_school_support_requests'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN ('guard_school_support','require_support_request_actor','support_request_text','school_support_request_json','school_support_claim','school_support_check_call','submit_school_support_request','add_school_support_message','read_school_support_requests')");
 assert.equal(fns.length,9);
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 pass('forced deny-all RLS on two new tables; runtime executes exactly three entry points');

 const module=await Test.createTestingModule({controllers:[SchoolSupportController],providers:[SchoolSupportService,SchoolSupportReadHumanUiGuard,SchoolSupportSubmitHumanUiGuard,SchoolSupportMessageHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 // Owners of new sign-ups hold support.request (registration copies every permission; the migration backfills older OWNER roles).
 for(const w of [a,b])assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code='support.request'",[w.org]))[0].n,'1');
 assert.equal((await q("SELECT count(*) n FROM hon.organization_entitlements WHERE organization_id=$1 AND status='ACTIVE'",[a.org]))[0].n,'0');

 // 2. D3: before access starts the owner asks for help; it is an OPEN HQ case for this exact school with the school's words.
 assert.deepEqual((await list(a)).requests,[]);
 const key=K();let r=await submit(a,ask,key);let req=ok(r);
 assert.equal(r.body.meta.replayed,false);assert.equal(req.status,'OPEN');assert.equal(req.topic,'GETTING_STARTED');assert.equal(req.subject,ask.subject);
 assert.equal(req.messages.length,1);assert.equal(req.messages[0].note,ask.message);assert.equal(req.messages[0].author,'Synthetic alpha');
 const kase=(await q('SELECT c.* FROM hon.hq_support_cases c JOIN hon.school_support_requests s ON s.case_id=c.id WHERE s.id=$1',[req.requestId]))[0];
 assert.equal(kase.organization_id,a.org);assert.equal(kase.school_id,a.school);assert.equal(kase.category,'ONBOARDING');assert.equal(kase.priority,'NORMAL');assert.equal(kase.status,'OPEN');
 assert.equal((await q("SELECT note FROM hon.hq_support_case_events WHERE case_id=$1 AND kind='OPENED'",[kase.id]))[0].note,ask.message);
 r=await submit(a,ask,key);assert.deepEqual(ok(r),req);assert.equal(r.body.meta.replayed,true);
 r=await submit(a,{...ask,subject:'Something else entirely'},key);assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');
 for(const bad of [{...ask,topic:'BOSS'},{...ask,subject:'hi'},{...ask,message:''},{...ask,message:'x'.repeat(4001)},{...ask,message:' padded'},{...ask,message:'bell\u0007'},{...ask,pageHint:'https://evil.test'},{...ask,extra:1},{topic:'OTHER',subject:'Missing page hint',message:'x'}]){
  r=await submit(a,bad);assert.equal(r.status,400,JSON.stringify([bad,r.body]));}
 let ev=await evidence(a);assert.deepEqual([Number(ev.a),Number(ev.o)],[1,1]);
 const audit=(await q("SELECT next_state::text s FROM hon.audit_events WHERE organization_id=$1 AND action_code='support.request.submitted'",[a.org]))[0].s;
 assert(!/Tuesdays|first class/.test(audit),audit);
 const outbox=(await q("SELECT payload::text s FROM hon.outbox_events WHERE organization_id=$1 AND event_type='support.request.submitted'",[a.org]))[0].s;
 assert(!/Tuesdays|first class/.test(outbox),outbox);
 pass('a pre-trial owner opens an OPEN HQ support case for exactly this school with its words; exact replay, refused key reuse, closed validation, identifier-only audit and outbox');

 // 3. HQ works the case; the school sees status and its own messages only, and writing back reopens it.
 const hqUser=K(),hqPrincipal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Secret HQ Agent')",[hqUser,hqSubject,'hq-'+K()+'@example.invalid']);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Secret HQ Agent',true)",[hqPrincipal,hqUser]);
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_SUPPORT',ARRAY['hq.support.manage'],clock_timestamp()-interval '1 hour')",[hqPrincipal]);
 let v=(await q('SELECT version FROM hon.hq_support_cases WHERE id=$1',[kase.id]))[0].version;
 await hq('change_hq_support_case($1,$2,$3::jsonb,$4)',[hqSubject,kase.id,{expectedVersion:v,status:'WAITING_ON_SCHOOL',assigneePrincipalId:hqPrincipal,note:'Internal: owner sounds new, call them'},K()]);
 let mine=(await list(a)).requests[0];
 assert.equal(mine.status,'WAITING_ON_SCHOOL');assert.equal(mine.messages.length,1);
 assert(!JSON.stringify(mine).includes('Internal')&&!JSON.stringify(mine).includes('Secret HQ Agent'));
 r=await reply(a,req.requestId,'We have 20 students to bring over.');req=ok(r);
 assert.equal(req.status,'OPEN');assert.deepEqual(req.messages.map(m=>m.note),[ask.message,'We have 20 students to bring over.']);
 const kinds=(await q('SELECT kind,status_from,status_to,actor_principal_id FROM hon.hq_support_case_events WHERE case_id=$1 ORDER BY seq',[kase.id]));
 assert.deepEqual(kinds.map(k=>k.kind),['OPENED','CHANGED','NOTE','CHANGED']);assert.equal(kinds[3].status_from,'WAITING_ON_SCHOOL');assert.equal(kinds[3].status_to,'OPEN');
 const hqView=await hq('read_hq_support_case($1,$2)',[hqSubject,kase.id]);
 assert(JSON.stringify(hqView).includes('We have 20 students to bring over.'));
 v=(await q('SELECT version FROM hon.hq_support_cases WHERE id=$1',[kase.id]))[0].version;
 await hq('change_hq_support_case($1,$2,$3::jsonb,$4)',[hqSubject,kase.id,{expectedVersion:v,status:'CLOSED'},K()]);
 mine=(await list(a)).requests[0];assert.equal(mine.status,'CLOSED');assert(mine.closedAt);
 r=await reply(a,req.requestId,'One more thing');assert.equal(r.status,409);assert.equal(r.body.code,'SUPPORT_REQUEST_CLOSED');
 ev=await evidence(a);assert.deepEqual([Number(ev.a),Number(ev.o)],[2,2]);
 pass('HQ notes, assignee and names never reach the school; a school message lands in HQ history and moves a waiting case back to OPEN; a closed case takes no more messages');

 // 4. Isolation and authority: another school, wrong ids, delegation, wrong command, unknown person, revoked grant.
 r=await send(base(a),{identity:b});assert.equal(r.status,403);
 r=await send(`organizations/${a.org}/schools/${b.school}/support-requests`,{identity:b});assert.equal(r.status,403);
 r=await reply(b,req.requestId,'peeking');assert.equal(r.status,404);
 r=await send(base(a),{identity:a,headers:{'x-hon-delegated-by-principal-id':K()}});assert.equal(r.status,403);
 r=await submit(a,ask,K(),{command:'onboarding.profile.save'});assert.equal(r.status,403);
 r=await reply(a,req.requestId,'wrong command',K(),{command:SUPPORT_SUBMIT_COMMAND});assert.equal(r.status,403);
 r=await send(base(a),{identity:person('stranger')});assert.equal(r.status,403);
 const grant=(await q('SELECT owner_grant_id g FROM hon.hon_os_school_registrations WHERE organization_id=$1',[b.org]))[0].g;
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[grant]);
 r=await send(base(b),{identity:b});assert.equal(r.status,403);r=await submit(b,ask);assert.equal(r.status,403);
 assert.equal((await q('SELECT count(*) n FROM hon.school_support_requests WHERE organization_id=$1',[b.org]))[0].n,'0');
 assert.equal((await q('SELECT count(*) n FROM hon.hq_support_case_events e JOIN hon.school_support_requests s ON s.case_id=e.case_id WHERE s.id=$1',[req.requestId]))[0].n,'5');
 pass('another school, wrong school ids, another school\'s request, delegation, wrong browser commands, unknown person and a revoked grant are all refused with nothing written');

 // 5. Daily limit: ten new requests per school in 24 hours, counted under a per-school lock.
 const results=await Promise.all(Array.from({length:12},(_,i)=>submit(a,{...ask,subject:'Question number '+i})));
 assert.equal(results.filter(x=>x.status===200).length,9);assert.equal(results.filter(x=>x.status===429).length,3);
 assert(results.filter(x=>x.status===429).every(x=>x.body.code==='SUPPORT_RATE_LIMITED'));
 assert.equal((await list(a)).requests.length,10);
 pass('concurrent requests stop at ten per school per day with SUPPORT_RATE_LIMITED, and nothing else is written');

 // 6. Evidence guard: links and commands never change or disappear.
 for(const sql of ['UPDATE hon.school_support_requests SET topic=$2 WHERE id=$1','DELETE FROM hon.school_support_requests WHERE id=$1 AND $2::text IS NOT NULL']){
  await assert.rejects(q(sql,[req.requestId,'OTHER']),/SUPPORT_REQUEST_IMMUTABLE/);}
 await assert.rejects(q("UPDATE hon.school_support_commands SET fingerprint=repeat('0',64) WHERE organization_id=$1",[a.org]),/SUPPORT_REQUEST_IMMUTABLE/);
 await assert.rejects(q('TRUNCATE hon.school_support_commands CASCADE'),/SUPPORT_REQUEST_IMMUTABLE|cannot truncate/);
 pass('request links and command receipts cannot be edited, deleted or truncated');
 console.log('PASS: school support requests (0335), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
