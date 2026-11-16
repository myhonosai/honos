/** 0426 face check-in. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). Synthetic matcher only. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import {readFileSync} from 'node:fs';
import zlib from 'node:zlib';
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
const {FaceCheckInService}=require('./dist/face-checkin/face-checkin.service.js');
const {FaceCheckInController,FaceCheckInHumanGuard,FaceCheckInScanController,FaceCheckInScanHumanGuard,FamilyFaceCheckInController,FamilyFaceCheckInSignGuard,FamilyFaceCheckInWithdrawGuard}=require('./dist/face-checkin/face-checkin.controller.js');
const {FACE_CHECKIN_HUMAN_COMMAND:MANAGE,FACE_CHECKIN_SCAN_COMMAND:SCAN,FAMILY_FACE_CHECKIN_COMMAND:SIGN,FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND:UNSIGN}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'face-checkin-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS FACE-CHECKIN '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:face:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',command=MANAGE,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key?{'idempotency-key':key}:{})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['face_checkin_settings','face_checkin_consents','face_templates','face_template_deletions','face_checkin_matches','face_checkin_requests','attendance_check_ins','attendance_records','audit_events','outbox_events'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status,code){
 const before=await counts();const r=await work();
 assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));
 assert.deepEqual(await counts(),before);assert(!('data' in r.body));
 assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/SQLSTATE|SELECT |external_subject|hon\./));return r;
}
async function human(identity,label){
 const user=K(),principal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[principal,user,label]);
 return principal;
}
async function customRole(o,code,perms){
 const id=(await q("INSERT INTO hon.roles(organization_id,management_school_id,code,name) VALUES($1,$2,$3,$4) RETURNING id",[o.organizationId,o.schoolId,code,code.replace('CUSTOM_','')]))[0].id;
 for(const p of perms)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[id,o.organizationId,p]);
 return id;
}
const grant=async(o,principal,role)=>(await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval \'1 minute\') RETURNING id',[o.organizationId,o.schoolId,principal,role]))[0].id;
// Synthetic pictures: tiny valid PNGs whose pixels differ; an optional text chunk stands for camera metadata.
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'latin1'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(zlib.crc32(body)>>>0);return Buffer.concat([len,body,crc]);}
function png(seed,text){
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
 const parts=[Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr)];
 if(text)parts.push(chunk('tEXt',Buffer.from('Comment\0'+text,'latin1')));
 parts.push(chunk('IDAT',zlib.deflateSync(Buffer.from([0,seed%256,(seed>>8)%256,7]))),chunk('IEND',Buffer.alloc(0)));return Buffer.concat(parts);
}
const sha=b=>createHash('sha256').update(b).digest('hex');
const addStudent=async(o,given,family,{birth=null,familyId=null}={})=>{
 const p=(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id',[o.organizationId,o.schoolId,given,family]))[0].id;
 if(familyId)await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')",[o.organizationId,o.schoolId,familyId,p]);
 return {personId:p,studentProfileId:(await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5) RETURNING id',[o.organizationId,o.schoolId,p,familyId,birth]))[0].id};
};
const setPhoto=async(o,s,bytes,by)=>{
 const has=(await q('SELECT 1 FROM hon.person_photos WHERE person_id=$1',[s.personId])).length;
 if(has)await q("UPDATE hon.person_photos SET content=$2,checksum=encode(sha256($2),'hex'),version=version+1,updated_at=clock_timestamp() WHERE person_id=$1",[s.personId,bytes]);
 else await q("INSERT INTO hon.person_photos(person_id,organization_id,school_id,media_type,content,checksum,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,'image/png',$4,encode(sha256($4),'hex'),$5,$5)",[s.personId,o.organizationId,o.schoolId,bytes,by]);
};
const addSession=async o=>{
 const program=(await q("INSERT INTO hon.programs(organization_id,school_id,name,status) VALUES($1,$2,$3,'SCHEDULED') RETURNING id",[o.organizationId,o.schoolId,'Face synthetic program '+K()]))[0].id;
 return (await q("INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,'Face synthetic class',clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '50 minutes',20,'WALK_IN') RETURNING id",[o.organizationId,o.schoolId,program]))[0].id;
};
const locate=(o,country,region,city,by)=>q("INSERT INTO hon.school_locations(school_id,organization_id,country_code,region_code,city,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$6)",[o.schoolId,o.organizationId,country,region,city,by]);
const read=(identity,schoolId)=>send('school/schools/'+schoolId+'/face-check-in',{identity,method:'GET'});
const settings=(identity,b,o={})=>send('school/face-check-in/settings',{identity,body:b,...o});
const record=(identity,b,o={})=>send('school/face-check-in/consent',{identity,body:b,...o});
const withdraw=(identity,b,o={})=>send('school/face-check-in/withdraw',{identity,body:b,...o});
const enroll=(identity,b,o={})=>send('school/face-check-in/enroll',{identity,body:b,...o});
const match=(identity,b,o={})=>send('school/face-check-in/match',{identity,body:b,command:SCAN,...o});
const confirm=(identity,b,o={})=>send('school/face-check-in/confirm',{identity,body:b,command:SCAN,...o});
const familyRead=identity=>send('parent/face-check-in',{identity,method:'GET'});
const sign=(identity,b,o={})=>send('parent/face-check-in/sign',{identity,body:b,command:SIGN,...o});
const unsign=(identity,b,o={})=>send('parent/face-check-in/withdraw',{identity,body:b,command:UNSIGN,...o});
const ACKS=['ALTERNATIVE_CHECK_IN_OFFERED','RETENTION_POLICY_PUBLISHED'];
const turnOn=(schoolId,expectedVersion,cityLimits=null,acknowledgements=ACKS)=>({schoolId,expectedVersion,enabled:true,cityLimits,acknowledgements});
const turnOff=(schoolId,expectedVersion)=>({schoolId,expectedVersion,enabled:false,cityLimits:null,acknowledgements:[]});

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL.
 const priv=['face_checkin_program','face_checkin_form_parts','face_checkin_forms','face_checkin_settings','face_checkin_consents','face_templates','face_template_deletions','face_checkin_matches','face_checkin_requests'];
 for(const t of priv){for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+' '+p);
  assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid=('hon.'||$1)::regclass",[t]))[0],{r:true,f:true,n:0});}
 const entries=['read_face_checkin','save_face_checkin_settings','record_face_checkin_consent','withdraw_face_checkin_consent','enroll_face_checkin_student','match_face_checkin',
  'confirm_face_checkin_match','read_family_face_checkin','sign_family_face_checkin_consent','withdraw_family_face_checkin_consent'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%face\\_checkin%' OR p.proname LIKE '%face\\_template%')");
 assert(fns.length>=entries.length+15);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 assert.deepEqual(entries.filter(e=>!fns.some(f=>f.proname===e)),[]);
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.face_templates'),e=>e.code==='42501');
 assert.equal((await q("SELECT is_sensitive AND is_staff_assignable ok FROM hon.permissions WHERE code='face_checkin.manage'"))[0].ok,true);
 assert.equal((await q('SELECT status FROM hon.face_checkin_program'))[0].status,'CLOSED');
 assert.equal((await q("SELECT count(*)::int n FROM hon.face_checkin_forms WHERE review_status='TEST_ONLY_DRAFT' AND digest=encode(sha256(convert_to(title||E'\\n\\n'||body,'UTF8')),'hex')"))[0].n,30);
 {const verify=readFileSync(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Face check-in exact verification (0426)')[1]?.split('-- End face check-in exact verification.')[0];
  assert(section);await q(section.replaceAll('hon_runtime',runtime.username));}
 pass('nine forced-RLS private tables; the runtime executes only the ten entry points; the program starts CLOSED; 30 draft forms with matching digests; the deployment verifier section passes');

 // Fixture: three schools with paid access (Illinois, New York State outside the city, Oregon near Portland).
 const hq={subject:'face-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Face synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Face synthetic','Face synthetic','Face school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'face-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision(),C=await provision(),D=await provision();
 for(const o of [A,B,C,D])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.is_system_role AND r.code='OWNER' AND rp.permission_code='face_checkin.manage'",[A.organizationId]))[0].n,1);
 const faceRole=await customRole(A,'CUSTOM_FACE',['school.view','face_checkin.manage']);
 const manager=person('manager'),managerPrincipal=await human(manager,'Manager');const managerGrant=await grant(A,managerPrincipal,faceRole);
 const manager2=person('manager-2');await grant(A,await human(manager2,'Manager 2'),faceRole);
 const scanner=person('scanner'),scannerPrincipal=await human(scanner,'Scanner');const scannerGrant=await grant(A,scannerPrincipal,await customRole(A,'CUSTOM_SCAN',['school.view','attendance.record']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_FACE',['school.view','face_checkin.manage','attendance.record']));
 const managerD=person('manager-d');await grant(D,await human(managerD,'Manager D'),await customRole(D,'CUSTOM_FACE',['school.view','face_checkin.manage']));
 const managerC=person('manager-c');await grant(C,await human(managerC,'Manager C'),await customRole(C,'CUSTOM_FACE',['school.view','face_checkin.manage']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 // Families at school A: the Park family (guardian + a viewer) and the Lee family.
 const [park,lee]=[K(),K()];await q("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Park Family'),($2,$3,$4,'Lee Family')",[park,lee,A.organizationId,A.schoolId]);
 const famGrant=async(identity,family,level)=>{const p=await human(identity,'Parent');await q("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",[A.organizationId,A.schoolId,family,p,level]);return p;};
 const guardian=person('guardian'),guardianPrincipal=await famGrant(guardian,park,'PRIMARY_GUARDIAN');
 const viewer=person('viewer');await famGrant(viewer,park,'VIEWER');
 const leeParent=person('lee');await famGrant(leeParent,lee,'PRIMARY_GUARDIAN');
 const mina=await addStudent(A,'Mina','Park',{birth:'2016-03-01',familyId:park});
 const adult=await addStudent(A,'Leo','Kim',{birth:'1990-05-05'});
 const noPhoto=await addStudent(A,'Ana','Lee',{birth:'2015-01-01',familyId:lee});
 const otherB=await addStudent(B,'Other','School',{birth:'1990-01-01'});
 const pics={mina:png(1),leo:png(2),other:png(3),stranger:png(999)};
 await setPhoto(A,mina,pics.mina,managerPrincipal);await setPhoto(A,adult,pics.mina,managerPrincipal);await setPhoto(B,otherB,pics.other,managerPrincipal);
 const sessionA=await addSession(A),sessionB=await addSession(B);
 const module=await Test.createTestingModule({controllers:[FaceCheckInController,FaceCheckInScanController,FamilyFaceCheckInController],providers:[FaceCheckInService,FaceCheckInHumanGuard,FaceCheckInScanHumanGuard,FamilyFaceCheckInSignGuard,FamilyFaceCheckInWithdrawGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. Closed program and no address: readable, nothing can be turned on; refusals write nothing.
 const first=ok(await read(manager,A.schoolId));
 assert.equal(first.program,'CLOSED');assert.equal(first.matcher,'SYNTHETIC');assert.equal(first.addressNotice.status,'LOCATION_REQUIRED');assert.deepEqual(first.choices,[]);
 assert.deepEqual(first.settings,{status:'OFF',profile:null,cityLimits:null,acknowledgements:[],offReason:null,version:0,updatedAt:null});
 assert.deepEqual(first.forms,[]);assert.deepEqual(first.students.map(s=>s.givenName).sort(),['Ana','Leo','Mina']);
 assert.deepEqual(first.students.map(s=>[s.givenName,s.adult,s.hasPhoto]).sort(),[['Ana',false,false],['Leo',true,true],['Mina',false,true]]);
 for(const who of [outsider,scanner,managerB,guardian])await denied(()=>read(who,A.schoolId),403,'FACE_CHECKIN_FORBIDDEN');
 await denied(()=>settings(manager,turnOn(A.schoolId,0)),403,'FACE_CHECKIN_CLOSED');
 await denied(()=>settings(manager,turnOn(A.schoolId,0),{command:SCAN}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>settings(manager,turnOn(A.schoolId,0),{key:null}),400,'FACE_CHECKIN_INVALID');
 await denied(()=>settings(scanner,turnOn(A.schoolId,0)),403,'FACE_CHECKIN_FORBIDDEN');
 const fam0=ok(await familyRead(guardian));assert.deepEqual({...fam0,children:fam0.children.map(c=>c.givenName)},{program:'CLOSED',schoolStatus:'OFF',canSign:false,canWithdraw:true,forms:[],children:['Mina']});
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>read(manager,A.schoolId),403,'FACE_CHECKIN_FORBIDDEN');
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[A.organizationId]);
 pass('while the program is CLOSED and the school has no address, staff with face_checkin.manage can read but nothing can be turned on; scanners, parents and other schools cannot read');

 // 3. Test mode, then the address decides the law; the owner answers the city-limits question and confirms each step.
 await q("UPDATE hon.face_checkin_program SET status='TEST_MODE'");
 await denied(()=>settings(manager,turnOn(A.schoolId,0)),400,'FACE_CHECKIN_LOCATION_REQUIRED');
 await locate(A,'US','IL','Chicago',managerPrincipal);await locate(B,'US','NY','Albany',managerPrincipal);await locate(C,'US','OR','Beaverton',managerPrincipal);
 const rA=ok(await read(manager,A.schoolId));
 assert.equal(rA.addressNotice.profile,'US_IL_BIPA');assert.deepEqual(rA.choices,[{cityLimits:null,profile:'US_IL_BIPA',status:'AVAILABLE_WITH_CONSENT',acknowledgements:ACKS}]);
 await denied(()=>settings(manager,turnOn(A.schoolId,0,null,[ACKS[0]])),400,'FACE_CHECKIN_ACKNOWLEDGEMENTS_REQUIRED');
 await denied(()=>settings(manager,turnOn(A.schoolId,0,null,[...ACKS,'ENTRANCE_SIGN_POSTED'])),400,'FACE_CHECKIN_ACKNOWLEDGEMENTS_REQUIRED');
 await denied(()=>settings(manager,turnOn(A.schoolId,0,'NONE')),400,'FACE_CHECKIN_CITY_LIMITS_REQUIRED');
 const onKey=K(),on=ok(await settings(manager,turnOn(A.schoolId,0),{key:onKey}));
 assert.deepEqual({...on.settings,updatedAt:null},{status:'ON',profile:'US_IL_BIPA',cityLimits:null,acknowledgements:ACKS,offReason:null,version:1,updatedAt:null});assert.equal(on.replayed,false);
 assert.equal(ok(await settings(manager,turnOn(A.schoolId,0),{key:onKey})).replayed,true);
 await denied(()=>settings(manager,turnOff(A.schoolId,1),{key:onKey}),409,'FACE_CHECKIN_KEY_REUSED');
 await denied(()=>settings(manager2,turnOn(A.schoolId,0)),409,'FACE_CHECKIN_VERSION_CONFLICT');
 await denied(()=>settings(manager2,turnOn(A.schoolId,1)),409,'FACE_CHECKIN_ALREADY_ON');
 const forms=ok(await read(manager,A.schoolId)).forms;
 assert.deepEqual(forms.map(f=>[f.formId,f.profile,f.language]),[[19,'US_IL_BIPA','en'],[20,'US_IL_BIPA','es'],[21,'US_IL_BIPA','ko']]);
 for(const f of forms)assert.equal(f.digest,createHash('sha256').update(f.title+'\n\n'+f.body).digest('hex'));
 assert.match(forms[0].body,/Biometric Information Privacy Act/i);
 // New York State outside New York City: the owner must say whether the school is inside the city limits.
 const rB=ok(await read(managerB,B.schoolId));
 assert.deepEqual(rB.choices.map(c=>[c.cityLimits,c.profile,c.acknowledgements.length]),[['NONE','US_GENERAL',2],['US_NYC','US_NYC',3]]);
 await denied(()=>settings(managerB,turnOn(B.schoolId,0)),400,'FACE_CHECKIN_CITY_LIMITS_REQUIRED');
 await denied(()=>settings(managerB,turnOn(B.schoolId,0,'US_NYC')),400,'FACE_CHECKIN_ACKNOWLEDGEMENTS_REQUIRED');
 const nyc=ok(await settings(managerB,turnOn(B.schoolId,0,'US_NYC',['ALTERNATIVE_CHECK_IN_OFFERED','ENTRANCE_SIGN_POSTED','RETENTION_POLICY_PUBLISHED'])));
 assert.equal(nyc.settings.profile,'US_NYC');assert.equal(nyc.settings.cityLimits,'US_NYC');
 // Near Portland, Oregon: inside the city limits face recognition is banned.
 const rC=ok(await read(managerC,C.schoolId));
 assert.deepEqual(rC.choices.map(c=>[c.cityLimits,c.profile,c.status]),[['NONE','US_GENERAL','AVAILABLE_WITH_CONSENT'],['US_PORTLAND_BAN','US_PORTLAND_BAN','BLOCKED']]);
 await denied(()=>settings(managerC,turnOn(C.schoolId,0,'US_PORTLAND_BAN',[])),403,'FACE_CHECKIN_NOT_AVAILABLE');
 // United States only for now (owner decision 2026-11-16): a school in Germany cannot turn it on although a GDPR draft exists.
 await locate(D,'DE',null,'Berlin',managerPrincipal);
 const rD=ok(await read(managerD,D.schoolId));
 assert.deepEqual(rD.choices.map(c=>[c.cityLimits,c.profile,c.status]),[[null,'EU_GDPR','NOT_LAUNCHED']]);
 await denied(()=>settings(managerD,turnOn(D.schoolId,0,null,['ALTERNATIVE_CHECK_IN_OFFERED','IMPACT_ASSESSMENT_DONE','RETENTION_POLICY_PUBLISHED'])),403,'FACE_CHECKIN_NOT_AVAILABLE');
 pass('the address decides the profile; US schools only for now; the owner answers the city-limits question (New York City, Portland ban) and confirms exactly the required steps; version-checked, exact replay, key reuse refused');

 // 4. Consent: parents sign the school's current form in the portal, staff record a signed paper form; minors need a guardian.
 const ilEn=forms[0],nycForm=(await q("SELECT id,digest FROM hon.face_checkin_forms WHERE profile_code='US_NYC' AND language='en'"))[0];
 const fam=ok(await familyRead(guardian));
 assert.equal(fam.canSign,true);assert.equal(fam.schoolStatus,'ON');assert.deepEqual(fam.children.map(c=>[c.givenName,c.consent,c.enrolled]),[['Mina',null,false]]);assert.equal(fam.forms.length,3);
 const sb=(studentProfileId,form=ilEn,signerName='Jordan Park')=>({studentProfileId,formId:form.formId??form.id,formDigest:form.digest,signerName});
 await denied(()=>sign(guardian,sb(mina.studentProfileId,{formId:ilEn.formId,digest:'0'.repeat(64)})),409,'FACE_CHECKIN_FORM_CHANGED');
 await denied(()=>sign(guardian,sb(mina.studentProfileId,nycForm)),409,'FACE_CHECKIN_FORM_CHANGED');
 await denied(()=>sign(guardian,sb(noPhoto.studentProfileId)),404,'FACE_CHECKIN_STUDENT_NOT_FOUND');
 await denied(()=>sign(leeParent,sb(mina.studentProfileId)),404,'FACE_CHECKIN_STUDENT_NOT_FOUND');
 await denied(()=>sign(outsider,sb(mina.studentProfileId)),403,'FACE_CHECKIN_FORBIDDEN');
 await denied(()=>sign(manager,sb(mina.studentProfileId)),403,'FACE_CHECKIN_FORBIDDEN');
 await denied(()=>sign(viewer,sb(mina.studentProfileId)),403,'FACE_CHECKIN_FORBIDDEN');
 await denied(()=>sign(guardian,sb(mina.studentProfileId),{command:UNSIGN}),403,'HUMAN_UI_REQUIRED');
 const signKey=K(),signed=ok(await sign(guardian,sb(mina.studentProfileId),{key:signKey}));
 assert.equal(signed.studentProfileId,mina.studentProfileId);assert.equal(signed.consent.state,'GIVEN');assert.equal(signed.consent.method,'PARENT_PORTAL');assert.equal(signed.consent.formId,19);
 assert.deepEqual(ok(await sign(guardian,sb(mina.studentProfileId),{key:signKey})),{...signed,replayed:true});
 await denied(()=>sign(guardian,sb(mina.studentProfileId)),409,'FACE_CHECKIN_CONSENT_EXISTS');
 assert.deepEqual((await q('SELECT signer_kind,signer_name,method,signer_principal_id,witnessed_by_principal_id,form_digest FROM hon.face_checkin_consents WHERE id=$1',[signed.consent.consentId]))[0],
  {signer_kind:'GUARDIAN',signer_name:'Jordan Park',method:'PARENT_PORTAL',signer_principal_id:guardianPrincipal,witnessed_by_principal_id:null,form_digest:ilEn.digest});
 const consentAudit=JSON.stringify(await q("SELECT a.next_state,o.payload FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id WHERE a.action_code LIKE 'face_checkin.%'"));
 assert(!consentAudit.includes('Jordan Park'),'audit and outbox carry identifiers only');
 const rb=(studentProfileId,signerKind,form=ilEn)=>({schoolId:A.schoolId,studentProfileId,formId:form.formId,formDigest:form.digest,signerKind,signerName:'Leo Kim',witnessAttested:true});
 await denied(()=>record(manager,{...rb(noPhoto.studentProfileId,'ADULT_STUDENT')}),400,'FACE_CHECKIN_GUARDIAN_REQUIRED');
 await denied(()=>record(manager,{...rb(adult.studentProfileId,'ADULT_STUDENT'),witnessAttested:false}),400,'FACE_CHECKIN_INVALID');
 await denied(()=>record(managerB,{...rb(adult.studentProfileId,'ADULT_STUDENT'),schoolId:B.schoolId,formId:nycForm.id,formDigest:nycForm.digest}),404,'FACE_CHECKIN_STUDENT_NOT_FOUND');
 await denied(()=>record(scanner,rb(adult.studentProfileId,'ADULT_STUDENT')),403,'FACE_CHECKIN_FORBIDDEN');
 // 18 or older: only the student signs, in the portal and in person.
 const grownUp=await addStudent(A,'Joon','Park',{birth:'1999-02-02',familyId:park});
 await denied(()=>sign(guardian,sb(grownUp.studentProfileId)),400,'FACE_CHECKIN_ADULT_SIGNS');
 await denied(()=>record(manager,rb(adult.studentProfileId,'GUARDIAN')),400,'FACE_CHECKIN_ADULT_SIGNS');
 const paper=ok(await record(manager,rb(adult.studentProfileId,'ADULT_STUDENT')));
 assert.equal(paper.consent.method,'IN_PERSON');assert.equal(paper.consent.signerKind,'ADULT_STUDENT');
 assert.equal((await q('SELECT witnessed_by_principal_id w FROM hon.face_checkin_consents WHERE id=$1',[paper.consent.consentId]))[0].w,managerPrincipal);
 pass('a guardian signs the current form for their own child only (typed name, exact digest); staff record a witnessed paper form; a minor needs a guardian and an adult signs for themselves; consents carry the form digest and audit carries no names');

 // 5. Enrollment from the profile photo: consent and a photo first; one template per photo.
 await denied(()=>enroll(manager,{schoolId:A.schoolId,studentProfileId:noPhoto.studentProfileId}),403,'FACE_CHECKIN_CONSENT_REQUIRED');
 await denied(()=>enroll(scanner,{schoolId:A.schoolId,studentProfileId:mina.studentProfileId}),403,'FACE_CHECKIN_FORBIDDEN');
 const en=ok(await enroll(manager,{schoolId:A.schoolId,studentProfileId:mina.studentProfileId}));
 assert.equal(en.outcome,'ENROLLED');assert.equal(en.matcher,'SYNTHETIC');
 assert.equal(ok(await enroll(manager2,{schoolId:A.schoolId,studentProfileId:mina.studentProfileId})).outcome,'ALREADY_ENROLLED');
 assert.equal((await q("SELECT encode(template,'hex') t FROM hon.face_templates WHERE student_profile_id=$1",[mina.studentProfileId]))[0].t,sha(pics.mina));
 await denied(()=>enroll(manager,{schoolId:A.schoolId,studentProfileId:adult.studentProfileId}),409,'FACE_TEMPLATE_DUPLICATE');
 await setPhoto(A,adult,pics.leo,managerPrincipal);
 assert.equal(ok(await enroll(manager,{schoolId:A.schoolId,studentProfileId:adult.studentProfileId})).outcome,'ENROLLED');
 const ana=ok(await sign(leeParent,sb(noPhoto.studentProfileId,ilEn,'Sam Lee')));assert.equal(ana.consent.state,'GIVEN');
 await denied(()=>enroll(manager,{schoolId:A.schoolId,studentProfileId:noPhoto.studentProfileId}),400,'FACE_CHECKIN_PHOTO_REQUIRED');
 pass('enrollment needs a current consent and a profile photo; the synthetic template is the photo digest; one template per photo; repeats keep the template');

 // 6. Scan: a picture proposes at most one student; nothing is recorded until a person confirms.
 const tagged=png(1,'GPS 41.88,-87.63 camera serial 1234');
 const mb=(data,sessionId=sessionA,schoolId=A.schoolId)=>({schoolId,sessionId,mediaType:'image/png',data:data.toString('base64')});
 await denied(()=>match(manager,mb(tagged)),403,'FACE_CHECKIN_FORBIDDEN');
 await denied(()=>match(outsider,mb(tagged)),403,'FACE_CHECKIN_FORBIDDEN');
 await denied(()=>match(scanner,mb(tagged),{command:MANAGE}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>match(scanner,mb(tagged,sessionB)),404,'FACE_CHECKIN_SESSION_NOT_FOUND');
 await denied(()=>match(scanner,{...mb(tagged),mediaType:'image/jpeg'}),400,'FACE_CHECKIN_IMAGE_REFUSED');
 const c0=await counts();
 const mk=K(),proposed=ok(await match(scanner,mb(tagged),{key:mk}));
 assert.equal(proposed.outcome,'PROPOSED');assert.deepEqual(proposed.student,{studentProfileId:mina.studentProfileId,givenName:'Mina',familyName:'Park'});
 assert.equal(ok(await match(scanner,mb(tagged),{key:mk})).replayed,true);
 await denied(()=>match(scanner,mb(pics.leo),{key:mk}),409,'FACE_CHECKIN_KEY_REUSED');
 const c1=await counts();assert.equal(Number(c1.attendance_records),Number(c0.attendance_records));assert.equal(Number(c1.face_checkin_matches),Number(c0.face_checkin_matches)+1);
 const none=ok(await match(scanner,mb(pics.stranger)));assert.equal(none.outcome,'NO_MATCH');assert.equal(none.student,null);
 assert.equal(ok(await match(scanner,mb(pics.other))).outcome,'NO_MATCH','another school\'s student is never proposed');
 const dump=JSON.stringify(await q("SELECT row_to_json(x) FROM (SELECT a.next_state n,o.payload p FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id WHERE a.action_code='face_checkin.match') x"))+JSON.stringify(await q('SELECT * FROM hon.face_checkin_matches'))+JSON.stringify(await q('SELECT fingerprint,response FROM hon.face_checkin_requests'));
 for(const p of [tagged,pics.stranger])assert(!dump.includes(sha(p))&&!dump.includes(p.toString('base64')),'neither the picture nor its digest is stored');
 const cb=(matchId,accept=true,status='PRESENT')=>({schoolId:A.schoolId,matchId,accept,status});
 await denied(()=>confirm(manager,cb(proposed.matchId)),403,'FACE_CHECKIN_FORBIDDEN');
 await denied(()=>confirm(managerB,{...cb(proposed.matchId),schoolId:B.schoolId}),404,'FACE_CHECKIN_MATCH_NOT_FOUND');
 const done=ok(await confirm(scanner,cb(proposed.matchId,true,'LATE')));
 assert.equal(done.outcome,'CONFIRMED');assert.equal(done.checkIn.outcome,'RECORDED');assert.equal(done.checkIn.attendance.status,'LATE');
 assert.deepEqual((await q('SELECT method,method_ref,attendance_record_id,attendance_status,recorded_by_principal_id FROM hon.attendance_check_ins WHERE method_ref=$1',[proposed.matchId]))[0],
  {method:'FACE',method_ref:proposed.matchId,attendance_record_id:done.checkIn.attendance.id,attendance_status:'LATE',recorded_by_principal_id:scannerPrincipal});
 await denied(()=>confirm(scanner,cb(proposed.matchId)),409,'FACE_CHECKIN_VERSION_CONFLICT');
 await denied(()=>confirm(scanner,cb(none.matchId)),409,'FACE_CHECKIN_VERSION_CONFLICT');
 const again=ok(await match(scanner,mb(png(1))));const dup=ok(await confirm(scanner,cb(again.matchId)));
 assert.equal(dup.checkIn.outcome,'ALREADY_RECORDED');assert.equal(dup.checkIn.attendance.id,done.checkIn.attendance.id);
 const leoMatch=ok(await match(scanner,mb(pics.leo)));assert.equal(leoMatch.student.givenName,'Leo');
 const r0=await counts();const rejected=ok(await confirm(scanner,cb(leoMatch.matchId,false)));
 assert.equal(rejected.outcome,'REJECTED');assert.equal(rejected.checkIn,null);const r1=await counts();assert.equal(r1.attendance_records,r0.attendance_records);
 pass('a scanner (attendance.record) gets at most one proposed student from this school; the picture is stripped, hashed and discarded; only a person\'s confirmation records attendance (method FACE through the shared check-in path); a rejection records nothing');

 // 7. Withdrawal, photo changes, turning off, an address change and retention all delete templates at once.
 const pending=ok(await match(scanner,mb(png(1))));
 const fam2=ok(await familyRead(guardian)).children.find(c=>c.givenName==='Mina');assert.equal(fam2.enrolled,true);
 await denied(()=>unsign(guardian,{consentId:fam2.consent.consentId,expectedVersion:2}),409,'FACE_CHECKIN_VERSION_CONFLICT');
 await denied(()=>unsign(leeParent,{consentId:fam2.consent.consentId,expectedVersion:1}),404,'FACE_CHECKIN_CONSENT_NOT_FOUND');
 const gone=ok(await unsign(guardian,{consentId:fam2.consent.consentId,expectedVersion:1}));assert.equal(gone.consent.state,'WITHDRAWN');
 assert.equal((await q('SELECT count(*)::int n FROM hon.face_templates WHERE student_profile_id=$1',[mina.studentProfileId]))[0].n,0);
 assert.equal((await q("SELECT reason FROM hon.face_template_deletions WHERE student_profile_id=$1 ORDER BY deleted_at DESC LIMIT 1",[mina.studentProfileId]))[0].reason,'CONSENT_WITHDRAWN');
 const expired=ok(await confirm(scanner,cb(pending.matchId)));assert.equal(expired.outcome,'EXPIRED');assert.equal(expired.checkIn,null);
 assert.equal(ok(await match(scanner,mb(png(1)))).outcome,'NO_MATCH');
 await setPhoto(A,adult,png(4),managerPrincipal);
 assert.equal((await q("SELECT reason FROM hon.face_template_deletions WHERE student_profile_id=$1 ORDER BY deleted_at DESC LIMIT 1",[adult.studentProfileId]))[0].reason,'PHOTO_CHANGED');
 assert.equal(ok(await enroll(manager,{schoolId:A.schoolId,studentProfileId:adult.studentProfileId})).outcome,'ENROLLED');
 // Retention: an inactive student for 30 days, or no face check-in for 12 months, is swept on the next read or by the daily job.
 await q("UPDATE hon.face_templates SET last_matched_at=clock_timestamp()-interval '13 months' WHERE student_profile_id=$1",[adult.studentProfileId]);
 assert.equal((await q('SELECT hon.purge_face_checkin_retention() n'))[0].n,1);
 assert.equal((await q("SELECT reason FROM hon.face_template_deletions WHERE student_profile_id=$1 ORDER BY deleted_at DESC LIMIT 1",[adult.studentProfileId]))[0].reason,'NO_CHECK_IN_12_MONTHS');
 assert.equal(ok(await enroll(manager,{schoolId:A.schoolId,studentProfileId:adult.studentProfileId})).outcome,'ENROLLED');
 await q("UPDATE hon.student_profiles SET status='SUSPENDED',version=version+1 WHERE id=$1",[adult.studentProfileId]);
 assert.equal(ok(await match(scanner,mb(png(4)))).outcome,'NO_MATCH','a student who is not ACTIVE is never proposed');
 await q("UPDATE hon.student_profiles SET updated_at=clock_timestamp()-interval '31 days' WHERE id=$1",[adult.studentProfileId]);
 const swept=ok(await read(manager,A.schoolId));assert.equal(swept.students.find(s=>s.studentProfileId===adult.studentProfileId).enrolled,false);
 assert.equal((await q("SELECT reason FROM hon.face_template_deletions WHERE student_profile_id=$1 ORDER BY deleted_at DESC LIMIT 1",[adult.studentProfileId]))[0].reason,'NOT_ACTIVE_30_DAYS');
 // Turning off deletes every template; turning on again starts a new activation and old consents must be signed again.
 const mina2=ok(await sign(guardian,sb(mina.studentProfileId)));assert.equal(ok(await enroll(manager,{schoolId:A.schoolId,studentProfileId:mina.studentProfileId})).outcome,'ENROLLED');
 const offed=ok(await settings(manager,turnOff(A.schoolId,1)));assert.equal(offed.templatesDeleted,1);assert.equal(offed.settings.offReason,'OWNER');
 assert.equal((await q('SELECT count(*)::int n FROM hon.face_templates WHERE school_id=$1',[A.schoolId]))[0].n,0);
 await denied(()=>match(scanner,mb(png(1))),403,'FACE_CHECKIN_OFF');
 await denied(()=>sign(guardian,sb(noPhoto.studentProfileId,ilEn,'Jordan Park')),404,'FACE_CHECKIN_STUDENT_NOT_FOUND');
 assert.equal(ok(await familyRead(guardian)).canSign,false);
 ok(await settings(manager,turnOn(A.schoolId,2)));
 const renew=ok(await read(manager,A.schoolId)).students.find(s=>s.studentProfileId===mina.studentProfileId).consent;
 assert.equal(renew.state,'RENEW');assert.equal(renew.consentId,mina2.consent.consentId);
 await denied(()=>enroll(manager,{schoolId:A.schoolId,studentProfileId:mina.studentProfileId}),403,'FACE_CHECKIN_CONSENT_REQUIRED');
 const resigned=ok(await sign(guardian,sb(mina.studentProfileId)));assert.equal(resigned.consent.state,'GIVEN');
 assert.equal((await q('SELECT status FROM hon.face_checkin_consents WHERE id=$1',[mina2.consent.consentId]))[0].status,'WITHDRAWN');
 // An address change turns the school off (owner must answer the new law) and deletes its templates.
 assert.equal(ok(await enroll(manager,{schoolId:A.schoolId,studentProfileId:mina.studentProfileId})).outcome,'ENROLLED');
 await q("UPDATE hon.school_locations SET city='Austin',region_code='TX',version=version+1,updated_at=clock_timestamp() WHERE school_id=$1",[A.schoolId]);
 const moved=ok(await read(manager,A.schoolId));assert.equal(moved.settings.status,'OFF');assert.equal(moved.settings.offReason,'LOCATION_CHANGED');assert.equal(moved.addressNotice.profile,'US_TX_CUBI');
 assert.equal((await q('SELECT count(*)::int n FROM hon.face_templates WHERE school_id=$1',[A.schoolId]))[0].n,0);
 assert.equal((await q("SELECT reason FROM hon.face_template_deletions WHERE student_profile_id=$1 ORDER BY deleted_at DESC LIMIT 1",[mina.studentProfileId]))[0].reason,'LOCATION_CHANGED');
 pass('withdrawal deletes the template at once and expires open proposals; a new photo, inactivity (30 days), no check-in for 12 months, turning off and an address change all delete templates; old consents must be signed again after a new activation');

 // 8. The database refuses unguarded changes even for the owner.
 for(const st of ["UPDATE hon.face_checkin_consents SET signer_name='x'","UPDATE hon.face_checkin_consents SET status='GIVEN',version=version+1 WHERE status='WITHDRAWN'","DELETE FROM hon.face_checkin_consents",
  "DELETE FROM hon.face_template_deletions","UPDATE hon.face_template_deletions SET reason='OTHER'","UPDATE hon.face_checkin_forms SET body='x'","DELETE FROM hon.face_checkin_forms",
  "UPDATE hon.face_checkin_matches SET outcome='CONFIRMED' WHERE outcome='NO_MATCH'","DELETE FROM hon.face_checkin_matches","UPDATE hon.face_checkin_requests SET response='{}'::jsonb",
  "UPDATE hon.face_checkin_settings SET status='ON'","DELETE FROM hon.face_checkin_settings","DELETE FROM hon.face_checkin_program",
  "TRUNCATE hon.face_templates","TRUNCATE hon.face_checkin_consents","TRUNCATE hon.face_template_deletions","TRUNCATE hon.face_checkin_matches",
  "INSERT INTO hon.attendance_check_ins(organization_id,school_id,class_session_id,student_profile_id,method,method_ref,attendance_record_id,attendance_status,recorded_by_principal_id) SELECT organization_id,school_id,class_session_id,student_profile_id,'PIN',method_ref,attendance_record_id,attendance_status,recorded_by_principal_id FROM hon.attendance_check_ins LIMIT 1"]){
  await admin.query('BEGIN');await assert.rejects(()=>admin.query(st),e=>['42501','23503','23514','23505','22P02','0A000'].includes(e.code),st);await admin.query('ROLLBACK');}
 pass('consents only go from GIVEN to WITHDRAWN; forms, deletion records, decided matches and receipts are immutable; settings change only by version');

 // 9. Authority is decided again after the last write.
 {const blocker=new pg.Client({connectionString:owner.toString(),ssl:false});await blocker.connect();
  try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['face-checkin:'+A.schoolId]);
   const c=await counts();const v=ok(await read(manager,A.schoolId)).settings.version;const waiting=settings(manager,turnOn(A.schoolId,v,null,['ALTERNATIVE_CHECK_IN_OFFERED','RETENTION_POLICY_PUBLISHED']));
   for(let i=0;i<300;i++){if((await q("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND NOT granted"))[0].n!=='0')break;await new Promise(r=>setTimeout(r,10));}
   await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[managerGrant]);
   await blocker.query('ROLLBACK');const res=await waiting;assert.equal(res.status,403,JSON.stringify(res.body));
   assert.deepEqual(await counts(),c);}
  finally{await blocker.end();}}
 await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[scannerGrant]);
 await denied(()=>match(scanner,mb(png(1))),403,'FACE_CHECKIN_FORBIDDEN');
 pass('a settings change whose grant is revoked while it waits commits nothing; a revoked scanner is refused');
 console.log('Face check-in proof (0426): '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
