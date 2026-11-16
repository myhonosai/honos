/** 0394 attendance cards and scan check-in. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import {readFileSync} from 'node:fs';
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
const {AttendanceCardsService,attendanceCardDigest}=require('./dist/schedule/attendance-cards.service.js');
const {AttendanceCardsController,AttendanceCardsHumanGuard,AttendanceScanController,AttendanceScanHumanGuard}=require('./dist/schedule/attendance-cards.controller.js');
const {ATTENDANCE_CARDS_HUMAN_COMMAND:CARDS,ATTENDANCE_SCAN_HUMAN_COMMAND:SCAN,isAttendanceCardCode}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'attendance-cards-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS ATTENDANCE-CARDS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const sha=b=>createHash('sha256').update(b).digest('hex');
const person=label=>({externalSubject:'oidc:cards:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',command=CARDS,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key?{'idempotency-key':key}:{})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['attendance_card_settings','attendance_cards','attendance_check_ins','attendance_card_requests','attendance_records','audit_events','outbox_events'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status,code){
 const before=await counts();const r=await work();
 assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));
 assert.deepEqual(await counts(),before);assert(!('data' in r.body));
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
const addPerson=async(o,given,family)=>(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id',[o.organizationId,o.schoolId,given,family]))[0].id;
const readCards=(identity,schoolId)=>send('school/schools/'+schoolId+'/attendance/cards',{identity,method:'GET'});
const configure=(identity,b,o={})=>send('school/attendance/cards/settings',{identity,body:b,...o});
const print=(identity,b,o={})=>send('school/attendance/cards/print',{identity,body:b,...o});
const cancel=(identity,b,o={})=>send('school/attendance/cards/cancel',{identity,body:b,...o});
const consent=(identity,b,o={})=>send('school/attendance/cards/photo-consent',{identity,body:b,...o});
const scan=(identity,b,o={})=>send('school/attendance/check-in',{identity,body:b,command:SCAN,...o});
const addStudent=async(o,given,family)=>{const p=await addPerson(o,given,family);return {personId:p,studentProfileId:(await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id) VALUES($1,$2,$3) RETURNING id',[o.organizationId,o.schoolId,p]))[0].id};};
const addSession=async o=>{
 const program=(await q("INSERT INTO hon.programs(organization_id,school_id,name,status) VALUES($1,$2,$3,'SCHEDULED') RETURNING id",[o.organizationId,o.schoolId,'Cards synthetic program '+K()]))[0].id;
 return (await q("INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,'Cards synthetic class',clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '50 minutes',20,'WALK_IN') RETURNING id",[o.organizationId,o.schoolId,program]))[0].id;
};
const settings0=(schoolId,expectedVersion,codeType='BARCODE')=>({schoolId,expectedVersion,codeType,showPhoto:true,showLogo:false,design:'BOLD'});

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL.
 const priv=['attendance_card_settings','attendance_cards','attendance_check_ins','attendance_card_requests','student_photo_consent_rules','student_photo_consents'];
 for(const t of priv){for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+' '+p);
  assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid=('hon.'||$1)::regclass",[t]))[0],{r:true,f:true,n:0});}
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%attendance_card%' OR p.proname IN ('attendance_check_in_student','attendance_photo_consent_rule','attendance_photo_consent_state','set_student_photo_consent'))");
 const entries=['read_attendance_cards','configure_attendance_cards','issue_attendance_cards','revoke_attendance_card','check_in_with_attendance_card','set_student_photo_consent'];
 assert.deepEqual(fns.map(f=>f.proname).sort(),['attendance_card_begin','attendance_card_finish','attendance_card_json','attendance_card_settings_json','attendance_cards_actor','attendance_check_in_student',
  'attendance_photo_consent_rule','attendance_photo_consent_state','check_in_with_attendance_card','configure_attendance_cards','guard_attendance_card','issue_attendance_cards',
  'read_attendance_cards','revoke_attendance_card','set_student_photo_consent']);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.attendance_cards'),e=>e.code==='42501');
 assert.equal((await q("SELECT is_sensitive AND is_staff_assignable ok FROM hon.permissions WHERE code='attendance.cards.manage'"))[0].ok,true);
 {const verify=readFileSync(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Attendance card exact verification (0394)')[1]?.split('-- End attendance card exact verification.')[0];
  assert(section);await q(section.replaceAll('hon_runtime',runtime.username));}
 pass('six forced-RLS private tables; the runtime executes only read, settings, print, cancel, photo consent and scan; the shared check-in path is private; the deployment verifier section passes');

 // Fixture: two schools with paid access; card manager, scanner, both, outsider, other school.
 const hq={subject:'cards-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Cards synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Cards synthetic','Cards synthetic','Cards school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'cards-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.is_system_role AND r.code='OWNER' AND rp.permission_code='attendance.cards.manage'",[A.organizationId]))[0].n,1);
 const cardRole=await customRole(A,'CUSTOM_CARDS',['school.view','attendance.cards.manage']);
 const manager=person('manager'),managerPrincipal=await human(manager,'Manager');const managerGrant=await grant(A,managerPrincipal,cardRole);
 const manager2=person('manager-2');await grant(A,await human(manager2,'Manager 2'),cardRole);
 const scanner=person('scanner'),scannerPrincipal=await human(scanner,'Scanner');const scannerGrant=await grant(A,scannerPrincipal,await customRole(A,'CUSTOM_SCAN',['school.view','attendance.record']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_CARDS',['school.view','attendance.cards.manage','attendance.record']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const mina=await addStudent(A,'Mina','Park'),leo=await addStudent(A,'Leo','Park'),otherB=await addStudent(B,'Other','School');
 const sessionA=await addSession(A),sessionB=await addSession(B);
 const module=await Test.createTestingModule({controllers:[AttendanceCardsController,AttendanceScanController],providers:[AttendanceCardsService,AttendanceCardsHumanGuard,AttendanceScanHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. Read: defaults before any choice, the school's own students only; refusals write nothing.
 const first=ok(await readCards(manager,A.schoolId));
 assert.deepEqual({...first.settings,schoolName:null},{codeType:'QR',showPhoto:true,showLogo:true,design:'CLASSIC',version:0,updatedAt:null,schoolName:null,logoUrl:null,accentColor:null,photoConsent:{required:false,profile:null,reason:'NO_LOCATION'}});
 assert.equal(first.maxPerPrint,40);
 assert.deepEqual(first.students.map(s=>s.givenName).sort(),['Leo','Mina']);
 assert(first.students.every(s=>s.card===null&&s.hasPhoto===false&&s.photoConsent==='NOT_REQUIRED'&&s.photoConsentVersion===0));
 for(const who of [outsider,scanner,managerB])await denied(()=>readCards(who,A.schoolId),403,'ATTENDANCE_CARDS_FORBIDDEN');
 for(const who of [scanner,outsider])await denied(()=>print(who,{schoolId:A.schoolId,studentProfileIds:[mina.studentProfileId]}),403,'ATTENDANCE_CARDS_FORBIDDEN');
 await denied(()=>print(manager,{schoolId:A.schoolId,studentProfileIds:[otherB.studentProfileId]}),404,'ATTENDANCE_CARD_STUDENT_NOT_FOUND');
 await denied(()=>print(manager,{schoolId:A.schoolId,studentProfileIds:[mina.studentProfileId]},{command:SCAN}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>print(manager,{schoolId:A.schoolId,studentProfileIds:[mina.studentProfileId]},{key:null}),400,'ATTENDANCE_CARDS_INVALID');
 await denied(()=>print(manager,{schoolId:A.schoolId,studentProfileIds:[mina.studentProfileId,mina.studentProfileId]}),400,'ATTENDANCE_CARDS_INVALID');
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>readCards(manager,A.schoolId),403,'ATTENDANCE_CARDS_FORBIDDEN');
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[A.organizationId]);
 pass('a school that never chose reads QR with photo and logo; attendance.cards.manage at the exact school with paid access; refusals write nothing');

 // 3. Settings: owner's choice of barcode or QR, version-checked, exact replay, key reuse refused.
 const sk=K(),saved=ok(await configure(manager,settings0(A.schoolId,0),{key:sk}));
 assert.equal(saved.replayed,false);assert.equal(saved.settings.codeType,'BARCODE');assert.equal(saved.settings.version,1);assert.equal(saved.settings.design,'BOLD');
 assert.equal(ok(await configure(manager,settings0(A.schoolId,0),{key:sk})).replayed,true);
 await denied(()=>configure(manager,settings0(A.schoolId,0,'QR'),{key:sk}),409,'ATTENDANCE_CARD_KEY_REUSED');
 await denied(()=>configure(manager2,settings0(A.schoolId,0,'QR')),409,'ATTENDANCE_CARD_VERSION_CONFLICT');
 assert.equal(ok(await configure(manager2,settings0(A.schoolId,1,'QR'))).settings.version,2);
 assert.equal(ok(await readCards(manager,A.schoolId)).settings.codeType,'QR');
 pass('the owner chooses barcode or QR and the look; version-checked, exact replay, key reuse refused');

 // 4. Print: codes shown once, only digests stored, ids-only audit/outbox, replay has no codes, a reprint replaces.
 const pk=K(),c0=await counts();
 const printed=ok(await print(manager,{schoolId:A.schoolId,studentProfileIds:[mina.studentProfileId,leo.studentProfileId]},{key:pk}));
 assert.equal(printed.replayed,false);assert.equal(printed.replaced,0);assert.equal(printed.cards.length,2);
 const codeOf=id=>printed.cards.find(c=>c.studentProfileId===id).code;
 for(const c of printed.cards){assert(isAttendanceCardCode(c.code));
  const row=(await q('SELECT encode(code_digest,\'hex\') d,code_last4,status FROM hon.attendance_cards WHERE id=$1',[c.cardId]))[0];
  assert.deepEqual(row,{d:attendanceCardDigest(c.code),code_last4:c.code.slice(-4),status:'ACTIVE'});}
 const c1=await counts();assert.equal(Number(c1.attendance_cards),Number(c0.attendance_cards)+2);
 const dump=JSON.stringify(await q("SELECT a.next_state,o.payload FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id WHERE a.action_code='attendance.cards.issue'"));
 for(const c of printed.cards){assert(!dump.includes(c.code));assert(!dump.includes(attendanceCardDigest(c.code)));}
 const replay=ok(await print(manager,{schoolId:A.schoolId,studentProfileIds:[leo.studentProfileId,mina.studentProfileId]},{key:pk}));
 assert.equal(replay.replayed,true);assert(replay.cards.every(c=>c.code===null));assert.deepEqual(replay.cards.map(c=>c.cardId).sort(),printed.cards.map(c=>c.cardId).sort());
 assert.deepEqual(await counts(),c1);
 await denied(()=>print(manager,{schoolId:A.schoolId,studentProfileIds:[mina.studentProfileId]},{key:pk}),409,'ATTENDANCE_CARD_KEY_REUSED');
 const reprint=ok(await print(manager2,{schoolId:A.schoolId,studentProfileIds:[leo.studentProfileId]}));
 assert.equal(reprint.replaced,1);
 assert.equal((await q('SELECT status FROM hon.attendance_cards WHERE id=$1',[printed.cards.find(c=>c.studentProfileId===leo.studentProfileId).cardId]))[0].status,'REPLACED');
 const list=ok(await readCards(manager,A.schoolId)).students;
 assert.equal(list.find(s=>s.studentProfileId===leo.studentProfileId).card.cardId,reprint.cards[0].cardId);
 pass('a print shows each code once and stores only its digest and last four; replay has no codes; a reprint replaces the old card');

 // 5. Scan: live attendance.record first, then the existing record_attendance; provenance row; no parallel model.
 const minaCode=codeOf(mina.studentProfileId),oldLeo=codeOf(leo.studentProfileId),newLeo=reprint.cards[0].code;
 const sb=(code,status='PRESENT',schoolId=A.schoolId,sessionId=sessionA)=>({schoolId,sessionId,code,status});
 await denied(()=>scan(manager,sb(minaCode)),403,'ATTENDANCE_CARDS_FORBIDDEN');
 await denied(()=>scan(outsider,sb(minaCode)),403,'ATTENDANCE_CARDS_FORBIDDEN');
 await denied(()=>scan(scanner,sb(minaCode),{command:CARDS}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>scan(scanner,sb(minaCode,'PRESENT',A.schoolId,sessionB)),404,'ATTENDANCE_SESSION_NOT_FOUND');
 await denied(()=>scan(scanner,sb(minaCode.slice(0,25)+String((Number(minaCode[25])+1)%10))),400,'ATTENDANCE_CARDS_INVALID');
 const s0=await counts(),k1=K();
 const rec=ok(await scan(scanner,sb(minaCode,'LATE'),{key:k1}));
 assert.equal(rec.outcome,'RECORDED');assert.equal(rec.student.studentProfileId,mina.studentProfileId);assert.equal(rec.student.givenName,'Mina');assert.equal(rec.attendance.status,'LATE');
 const s1=await counts();assert.equal(Number(s1.attendance_records),Number(s0.attendance_records)+1);assert.equal(Number(s1.attendance_check_ins),Number(s0.attendance_check_ins)+1);
 const ci=(await q('SELECT method,method_ref,attendance_record_id,attendance_status,recorded_by_principal_id FROM hon.attendance_check_ins WHERE student_profile_id=$1',[mina.studentProfileId]))[0];
 assert.deepEqual(ci,{method:'CARD',method_ref:printed.cards.find(c=>c.studentProfileId===mina.studentProfileId).cardId,attendance_record_id:rec.attendance.id,attendance_status:'LATE',recorded_by_principal_id:scannerPrincipal});
 const ar=(await q('SELECT status::text s,recorded_by_principal_id p FROM hon.attendance_records WHERE id=$1',[rec.attendance.id]))[0];assert.deepEqual(ar,{s:'LATE',p:scannerPrincipal});
 const again=ok(await scan(scanner,sb(minaCode,'PRESENT')));
 assert.equal(again.outcome,'ALREADY_RECORDED');assert.equal(again.attendance.status,'LATE');assert.equal(again.attendance.id,rec.attendance.id);
 assert.equal(ok(await scan(scanner,sb(minaCode,'LATE'),{key:k1})).outcome,'ALREADY_RECORDED');
 assert.deepEqual(await counts(),s1);
 const stale=ok(await scan(scanner,sb(oldLeo)));
 assert.equal(stale.outcome,'CARD_NOT_ACTIVE');assert.equal(stale.student.givenName,'Leo');assert.equal(stale.card.status,'REPLACED');assert.equal(stale.attendance,null);
 const bCode=ok(await print(managerB,{schoolId:B.schoolId,studentProfileIds:[otherB.studentProfileId]})).cards[0].code;
 for(const code of [bCode,'00000000000000000000000000'.slice(0,24)+'00']){
  if(!isAttendanceCardCode(code))continue;
  const nr=ok(await scan(scanner,sb(code)));assert.deepEqual(nr,{outcome:'NOT_RECOGNIZED',student:null,card:null,attendance:null});}
 const unknown=(()=>{for(;;){const b=String(Math.floor(Math.random()*1e12)).padStart(12,'0').repeat(2);const r=[...b+'00'].reduce((a,d)=>(a*10+Number(d))%97,0);const c=b+String(98-r).padStart(2,'0');if(isAttendanceCardCode(c))return c;}})();
 assert.deepEqual(ok(await scan(scanner,sb(unknown))),{outcome:'NOT_RECOGNIZED',student:null,card:null,attendance:null});
 // Leo was marked absent (with a note) before arriving: the scan corrects the record and keeps the rest.
 const markReq=K();await admin.query('BEGIN');
 await admin.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_principal_id',$5,true),set_config('app.hon_external_subject',$3,true),set_config('app.hon_request_id',$4,true),set_config('app.hon_correlation_id',$4,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[A.organizationId,A.schoolId,scanner.externalSubject,markReq,scannerPrincipal]);
 const absent=(await admin.query('SELECT hon.record_attendance($1,$2::uuid,$3::jsonb,$4,$5::uuid,$5::uuid) AS d',[scanner.externalSubject,sessionA,JSON.stringify({studentProfileId:leo.studentProfileId,status:'UNEXCUSED_ABSENCE',note:'Synthetic note'}),K(),markReq])).rows[0].d.attendance;
 await admin.query('COMMIT');
 const arrived=ok(await scan(scanner,sb(newLeo)));
 assert.equal(arrived.outcome,'RECORDED');assert.equal(arrived.attendance.status,'PRESENT');assert.equal(arrived.attendance.id,absent.id);assert.equal(arrived.attendance.version,absent.version+1);
 assert.deepEqual((await q('SELECT status::text s,category::text c,note n FROM hon.attendance_records WHERE id=$1',[absent.id]))[0],{s:'PRESENT',c:'REGULAR_PARTICIPANT',n:'Synthetic note'});
 assert.equal(ok(await scan(scanner,sb(newLeo,'LATE'))).outcome,'ALREADY_RECORDED');
 assert.equal((await q("SELECT count(*)::int n FROM hon.attendance_check_ins WHERE school_id=$1",[A.schoolId]))[0].n,2);
 pass('a scan needs live attendance.record at the school, then writes through record_attendance with one CARD provenance row; repeats, replaced cards and other schools record nothing; an arrival corrects an absence');

 // 6. Cancel a card: it stops working at once.
 const minaCard=printed.cards.find(c=>c.studentProfileId===mina.studentProfileId);
 await denied(()=>cancel(manager,{schoolId:A.schoolId,cardId:minaCard.cardId,expectedVersion:2}),409,'ATTENDANCE_CARD_VERSION_CONFLICT');
 await denied(()=>cancel(scanner,{schoolId:A.schoolId,cardId:minaCard.cardId,expectedVersion:1}),403,'ATTENDANCE_CARDS_FORBIDDEN');
 await denied(()=>cancel(managerB,{schoolId:B.schoolId,cardId:minaCard.cardId,expectedVersion:1}),404,'ATTENDANCE_CARD_NOT_FOUND');
 const ck=K(),cancelled=ok(await cancel(manager,{schoolId:A.schoolId,cardId:minaCard.cardId,expectedVersion:1},{key:ck}));
 assert.equal(cancelled.card.status,'REVOKED');assert.equal(cancelled.card.version,2);
 assert.equal(ok(await cancel(manager,{schoolId:A.schoolId,cardId:minaCard.cardId,expectedVersion:1},{key:ck})).replayed,true);
 const session2=await addSession(A);
 const gone=ok(await scan(scanner,sb(minaCode,'PRESENT',A.schoolId,session2)));assert.equal(gone.outcome,'CARD_NOT_ACTIVE');assert.equal(gone.card.status,'REVOKED');
 assert.equal(ok(await readCards(manager,A.schoolId)).students.find(s=>s.studentProfileId===mina.studentProfileId).card,null);
 pass('a cancelled card stops working at once; cancel is version-checked, exact-school and replays exactly');

 // 7. The database refuses unguarded changes even for the owner.
 for(const st of ["UPDATE hon.attendance_cards SET code_digest=sha256('x'::bytea) WHERE id='"+minaCard.cardId+"'","UPDATE hon.attendance_cards SET status='ACTIVE',version=version+1,ended_at=NULL,ended_by_principal_id=NULL WHERE id='"+minaCard.cardId+"'",
  "DELETE FROM hon.attendance_cards","UPDATE hon.attendance_check_ins SET attendance_status='PRESENT'","DELETE FROM hon.attendance_check_ins","UPDATE hon.attendance_card_requests SET response='{}'::jsonb",
  "INSERT INTO hon.attendance_check_ins(organization_id,school_id,class_session_id,student_profile_id,method,method_ref,attendance_record_id,attendance_status,recorded_by_principal_id) SELECT organization_id,school_id,class_session_id,student_profile_id,'FACE',method_ref,attendance_record_id,attendance_status,recorded_by_principal_id FROM hon.attendance_check_ins LIMIT 1",
  "TRUNCATE hon.attendance_cards","TRUNCATE hon.attendance_check_ins","TRUNCATE hon.attendance_card_settings","TRUNCATE hon.attendance_card_requests"]){
  await admin.query('BEGIN');await assert.rejects(()=>admin.query(st),e=>['42501','23503','23514','23505'].includes(e.code),st);await admin.query('ROLLBACK');}
 pass('cards cannot be re-activated, re-coded or deleted; check-in rows and receipts are immutable; no other method yet');

 // 8. Photo consent by place (owner decision 2026-11-16): none without an address; where the place needs it, the card
 //    carries the photo only with recorded consent. The server decides printPhoto.
 {const png=readFileSync(new URL('../../../apps/web/public/paper-import-samples/student-card.png',import.meta.url));
  const kid=await addStudent(A,'Ana','Lee');const kp=kid.studentProfileId;
  await q("INSERT INTO hon.person_photos(person_id,organization_id,school_id,media_type,content,checksum,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,'image/png',$4,encode(sha256($4),'hex'),$5,$5)",[kid.personId,A.organizationId,A.schoolId,png,managerPrincipal]);
  const kidRow=async()=>{const r=ok(await readCards(manager,A.schoolId));return {rule:r.settings.photoConsent,kid:r.students.find(s=>s.studentProfileId===kp)};};
  const printKid=async()=>ok(await print(manager,{schoolId:A.schoolId,studentProfileIds:[kp]})).cards[0].printPhoto;
  let now=await kidRow();assert.deepEqual(now.rule,{required:false,profile:null,reason:'NO_LOCATION'});assert.equal(now.kid.photoConsent,'NOT_REQUIRED');assert.equal(now.kid.hasPhoto,true);
  assert.equal(await printKid(),true);
  assert.equal(ok(await print(manager,{schoolId:A.schoolId,studentProfileIds:[mina.studentProfileId]})).cards[0].printPhoto,false,'no photo, no photo on the card');
  // Rules: every 0392 profile has a draft row; only EU, UK, Korea and unreviewed places need consent.
  assert.deepEqual((await q("SELECT profile_code FROM hon.student_photo_consent_rules WHERE consent_required ORDER BY 1")).map(r=>r.profile_code),['EU_GDPR','KR_PIPA','NOT_REVIEWED','UK_GDPR']);
  assert.equal((await q("SELECT count(*)::int n FROM hon.biometric_jurisdiction_profiles p LEFT JOIN hon.student_photo_consent_rules r ON r.profile_code=p.code WHERE r.profile_code IS NULL OR r.review_status<>'TEST_ONLY_DRAFT'"))[0].n,0);
  await q("INSERT INTO hon.school_locations(school_id,organization_id,country_code,city,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'DE','Berlin',$3,$3)",[A.schoolId,A.organizationId,managerPrincipal]);
  now=await kidRow();assert.deepEqual(now.rule,{required:true,profile:'EU_GDPR',reason:'PROFILE'});assert.equal(now.kid.photoConsent,'MISSING');assert.equal(now.kid.photoConsentVersion,0);
  assert.equal(await printKid(),false,'consent needed and missing: initials');
  const cb=(given,expectedVersion,studentProfileId=kp,schoolId=A.schoolId)=>({schoolId,studentProfileId,given,expectedVersion});
  await denied(()=>consent(manager,cb(false,0)),400,'ATTENDANCE_CARDS_INVALID');
  await denied(()=>consent(scanner,cb(true,0)),403,'ATTENDANCE_CARDS_FORBIDDEN');
  await denied(()=>consent(managerB,cb(true,0,kp,B.schoolId)),404,'ATTENDANCE_CARD_STUDENT_NOT_FOUND');
  await denied(()=>consent(manager,cb(true,0),{command:SCAN}),403,'HUMAN_UI_REQUIRED');
  const gk=K(),given=ok(await consent(manager,cb(true,0),{key:gk}));
  assert.deepEqual({...given,recordedAt:null},{studentProfileId:kp,photoConsent:'GIVEN',photoConsentVersion:1,recordedAt:null,replayed:false});
  assert.deepEqual(ok(await consent(manager,cb(true,0),{key:gk})),{...given,replayed:true});
  await denied(()=>consent(manager,cb(true,0)),409,'ATTENDANCE_CARD_VERSION_CONFLICT');
  assert.equal((await kidRow()).kid.photoConsent,'GIVEN');assert.equal(await printKid(),true);
  const audit=(await q("SELECT next_state FROM hon.audit_events WHERE entity_type='STUDENT_PHOTO_CONSENT' AND entity_id=$1",[kp]))[0].next_state;
  assert.deepEqual(Object.keys(audit).sort(),['internalOnly','status','studentProfileId','version']);
  const withdrawn=ok(await consent(manager,cb(false,1)));assert.equal(withdrawn.photoConsent,'MISSING');assert.equal(withdrawn.photoConsentVersion,2);
  assert.equal(await printKid(),false);
  // An unreviewed place fails closed; a US state without a rule needs none.
  await q("INSERT INTO hon.school_locations(school_id,organization_id,country_code,city,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'JP','Tokyo',$3,$3)",[B.schoolId,B.organizationId,managerPrincipal]);
  assert.deepEqual(ok(await readCards(managerB,B.schoolId)).settings.photoConsent,{required:true,profile:'NOT_REVIEWED',reason:'PROFILE'});
  assert.equal((await q("SELECT hon.attendance_photo_consent_rule(o.id,s.id)->>'required' r FROM hon.organizations o JOIN hon.schools s ON s.organization_id=o.id WHERE s.id=$1",[A.schoolId]))[0].r,'true');
  assert.equal((await q("SELECT (SELECT consent_required FROM hon.student_photo_consent_rules WHERE profile_code=hon.biometric_profile_for('US','CA','Los Angeles')) r"))[0].r,false);
  for(const st of ["UPDATE hon.student_photo_consent_rules SET consent_required=NOT consent_required","DELETE FROM hon.student_photo_consent_rules","DELETE FROM hon.student_photo_consents",
    "UPDATE hon.student_photo_consents SET status='GIVEN'","TRUNCATE hon.student_photo_consents"]){
   await admin.query('BEGIN');await assert.rejects(()=>admin.query(st),e=>e.code==='42501',st);await admin.query('ROLLBACK');}}
 pass('photo consent follows the place: none without an address, required for EU/UK/Korea/unreviewed (draft); the card carries the photo only with recorded consent; consent is version-checked, exact-school, replayable and immutable except by a new version');

 // 9. Authority is decided again after the last write.
 {const blocker=new pg.Client({connectionString:owner.toString(),ssl:false});await blocker.connect();
  try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['attendance-card:'+mina.studentProfileId]);
   const c=await counts();const pending=print(manager,{schoolId:A.schoolId,studentProfileIds:[mina.studentProfileId]});
   for(let i=0;i<300;i++){if((await q("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND NOT granted"))[0].n!=='0')break;await new Promise(r=>setTimeout(r,10));}
   await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[managerGrant]);
   await blocker.query('ROLLBACK');const res=await pending;assert.equal(res.status,403,JSON.stringify(res.body));
   assert.deepEqual(await counts(),c);}
  finally{await blocker.end();}}
 {const leoNew=leo.studentProfileId,session3=await addSession(A),session4=await addSession(A);
  const blocker=new pg.Client({connectionString:owner.toString(),ssl:false});await blocker.connect();
  try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[session3+':'+leoNew]);
   const pending=scan(scanner,sb(newLeo,'PRESENT',A.schoolId,session3));
   for(let i=0;i<300;i++){if((await q("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND NOT granted"))[0].n!=='0')break;await new Promise(r=>setTimeout(r,10));}
   // The scan holds its staff member's grant (hon.lock_attendance_actor): a revocation waits for it instead of racing it.
   await admin.query('BEGIN');await admin.query("SET LOCAL lock_timeout='300ms'");
   await assert.rejects(()=>admin.query("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[scannerGrant]),e=>e.code==='55P03');
   await admin.query('ROLLBACK');
   await blocker.query('ROLLBACK');const res=await pending;assert.equal(ok(res).outcome,'RECORDED');}
  finally{await blocker.end();}
  await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[scannerGrant]);
  await denied(()=>scan(scanner,sb(newLeo,'PRESENT',A.schoolId,session4)),403,'ATTENDANCE_CARDS_FORBIDDEN');}
 pass('a print whose grant is revoked while it waits commits nothing; a scan holds its grant so a revocation waits for it, and the next scan is refused');
 console.log('Attendance card proof (0394): '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
