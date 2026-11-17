/** 0454 membership agreement with one signing. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import {readFileSync} from 'node:fs';
import zlib from 'node:zlib';
import pg from 'pg';
import {membershipFixtureQuery} from './membership-activation-test-support.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {MembershipAgreementService}=require('./dist/membership-agreement/membership-agreement.service.js');
const {MembershipAgreementController,MembershipAgreementHumanGuard,FamilyMembershipAgreementController,FamilyMembershipAgreementSignGuard,FamilyPersonPhotoGuard}=require('./dist/membership-agreement/membership-agreement.controller.js');
const {MEMBERSHIP_AGREEMENT_HUMAN_COMMAND:MANAGE,FAMILY_MEMBERSHIP_AGREEMENT_SIGN_COMMAND:SIGN,FAMILY_PERSON_PHOTO_COMMAND:PHOTO}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'membership-agreement-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS MEMBERSHIP-AGREEMENT '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:agreement:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',command=MANAGE,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key?{'idempotency-key':key}:{})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['membership_agreement_drafts','membership_agreement_versions','membership_agreement_texts','membership_agreement_signatures','membership_agreement_requests',
 'face_checkin_consents','face_templates','face_template_deletions','person_photos','audit_events','outbox_events'];
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
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'latin1'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(zlib.crc32(body)>>>0);return Buffer.concat([len,body,crc]);}
function png(seed,text){
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
 const parts=[Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr)];
 if(text)parts.push(chunk('tEXt',Buffer.from('Comment\0'+text,'latin1')));
 parts.push(chunk('IDAT',zlib.deflateSync(Buffer.from([0,seed%256,(seed>>8)%256,7]))),chunk('IEND',Buffer.alloc(0)));return Buffer.concat(parts);
}
const sha=s=>createHash('sha256').update(s).digest('hex');
const read=identity=>send('school/schools/'+A.schoolId+'/membership-agreement',{identity,method:'GET'});
const draft=(identity,b,o={})=>send('school/membership-agreement/draft',{identity,body:{schoolId:A.schoolId,...b},...o});
const publish=(identity,b,o={})=>send('school/membership-agreement/publish',{identity,body:{schoolId:A.schoolId,schoolResponsible:true,...b},...o});
const familyRead=identity=>send('parent/membership-agreement',{identity,method:'GET',command:SIGN});
const sign=(identity,b,o={})=>send('parent/membership-agreement/sign',{identity,body:b,command:SIGN,...o});
const photoSet=(identity,b,o={})=>send('parent/person-photo/set',{identity,body:b,command:PHOTO,...o});
const photoRemove=(identity,b,o={})=>send('parent/person-photo/remove',{identity,body:b,command:PHOTO,...o});
let A,B;

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL.
 const priv=['membership_agreement_drafts','membership_agreement_versions','membership_agreement_texts','membership_agreement_signatures','membership_agreement_requests'];
 for(const t of priv){for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+' '+p);
  assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid=('hon.'||$1)::regclass",[t]))[0],{r:true,f:true,n:0});}
 const entries=['read_membership_agreement','save_membership_agreement_draft','publish_membership_agreement','read_family_membership_agreement','sign_family_membership_agreement',
  'set_family_child_photo','remove_family_child_photo'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%membership\\_agreement%' OR p.proname IN ('set_family_child_photo','remove_family_child_photo'))");
 assert(fns.length>=entries.length+12);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 assert.deepEqual(entries.filter(e=>!fns.some(f=>f.proname===e)),[]);
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.membership_agreement_signatures'),e=>e.code==='42501');
 assert.equal((await q("SELECT is_sensitive AND is_staff_assignable ok FROM hon.permissions WHERE code='membership.agreement.manage'"))[0].ok,true);
 {const verify=readFileSync(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Membership agreement exact verification (0454)')[1]?.split('-- End membership agreement exact verification.')[0];
  assert(section);await q(section.replaceAll('hon_runtime',runtime.username));}
 pass('five forced-RLS private tables; the runtime executes only the seven entry points; the deployment verifier section passes');

 // Fixture: two schools with paid access. School A is in Illinois with face check-in ON (test mode).
 const hq={subject:'agreement-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Agreement synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Agreement synthetic','Agreement synthetic','Agreement school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'agreement-'+K(),K(),K()]))[0];
 A=await provision();B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.is_system_role AND r.code='OWNER' AND rp.permission_code='membership.agreement.manage'",[A.organizationId]))[0].n,1);
 const role=await customRole(A,'CUSTOM_AGREEMENT',['school.view','membership.agreement.manage']);
 const manager=person('manager'),managerPrincipal=await human(manager,'Manager');const managerGrant=await grant(A,managerPrincipal,role);
 const manager2=person('manager-2');await grant(A,await human(manager2,'Manager 2'),role);
 const desk=person('desk');await grant(A,await human(desk,'Desk'),await customRole(A,'CUSTOM_DESK',['school.view','people.read','people.update']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_AGREEMENT',['school.view','membership.agreement.manage']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const [park,lee]=[K(),K()];await q("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Park Family'),($2,$3,$4,'Lee Family')",[park,lee,A.organizationId,A.schoolId]);
 const grants={};
 const famGrant=async(identity,family,level)=>{const p=await human(identity,'Parent');grants[identity.externalSubject]=(await q("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4) RETURNING id",[A.organizationId,A.schoolId,family,p,level]))[0].id;return p;};
 const guardian=person('guardian'),guardianPrincipal=await famGrant(guardian,park,'PRIMARY_GUARDIAN');
 const viewer=person('viewer');await famGrant(viewer,park,'VIEWER');
 const leeParent=person('lee');await famGrant(leeParent,lee,'PRIMARY_GUARDIAN');
 const payer=(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id',[A.organizationId,A.schoolId,'Hana','Park']))[0].id;
 const account=(await q("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,'USD') RETURNING id",[A.organizationId,A.schoolId,payer]))[0].id;
 const addStudent=async(given,family,{birth=null,familyId=null,membership=null}={})=>{
  const p=(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id',[A.organizationId,A.schoolId,given,family]))[0].id;
  if(familyId)await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')",[A.organizationId,A.schoolId,familyId,p]);
  if(membership)await membershipFixtureQuery(admin,"INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,'SYNTHETIC_PLAN',$5,$6,$7)",[A.organizationId,A.schoolId,account,p,membership,membership==='DRAFT'?null:'2026-01-01T00:00:00Z',membership==='DRAFT'?null:'2027-01-01T00:00:00Z']);
  return {personId:p,studentProfileId:(await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5) RETURNING id',[A.organizationId,A.schoolId,p,familyId,birth]))[0].id};
 };
 const mina=await addStudent('Mina','Park',{birth:'2016-03-01',familyId:park,membership:'ACTIVE'});
 const jun=await addStudent('Jun','Park',{familyId:park,membership:'DRAFT'});
 const teen=await addStudent('Tae','Park',{birth:'2000-01-01',familyId:park,membership:'ACTIVE'});
 const sora=await addStudent('Sora','Park',{birth:'2018-01-01',familyId:park,membership:'CANCELLED'});
 const ana=await addStudent('Ana','Lee',{birth:'2015-01-01',familyId:lee,membership:'ACTIVE'});
 await q("INSERT INTO hon.person_photos(person_id,organization_id,school_id,media_type,content,checksum,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,'image/png',$4,encode(sha256($4),'hex'),$5,$5)",[mina.personId,A.organizationId,A.schoolId,png(1),managerPrincipal]);
 await q("UPDATE hon.face_checkin_program SET status='TEST_MODE'");
 await q("INSERT INTO hon.school_locations(school_id,organization_id,country_code,region_code,city,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'US','IL','Chicago',$3,$3)",[A.schoolId,A.organizationId,managerPrincipal]);
 await q("INSERT INTO hon.face_checkin_settings(school_id,organization_id,status,profile_code,acknowledgements,activation,updated_by_principal_id) VALUES($1,$2,'ON','US_IL_BIPA',ARRAY['ALTERNATIVE_CHECK_IN_OFFERED','RETENTION_POLICY_PUBLISHED'],1,$3)",[A.schoolId,A.organizationId,managerPrincipal]);
 const module=await Test.createTestingModule({controllers:[MembershipAgreementController,FamilyMembershipAgreementController],providers:[MembershipAgreementService,MembershipAgreementHumanGuard,FamilyMembershipAgreementSignGuard,FamilyPersonPhotoGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. Staff: nothing is published at first; only membership.agreement.manage at this exact school reads or writes.
 const empty=ok(await read(manager));
 assert.deepEqual(empty,{drafts:[],current:null,versions:[],summary:{covered:4,signed:0,needsNewVersion:0,notSigned:4}});
 for(const who of [outsider,desk,managerB,guardian])await denied(()=>read(who),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>draft(desk,{language:'en',title:'Membership agreement',body:'Text',expectedVersion:0}),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>draft(manager,{language:'en',title:'Membership agreement',body:'Text',expectedVersion:0},{command:SIGN}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>draft(manager,{language:'en',title:'Membership agreement',body:'Text',expectedVersion:0},{key:null}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>draft(manager,{language:'en',title:'<b>x</b>',body:'Text',expectedVersion:0}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>draft(manager,{language:'en',title:'Agreement',body:'bad\u0007bell',expectedVersion:0}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>draft(manager,{language:'fr',title:'Agreement',body:'Text',expectedVersion:0}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 const body1='1. Classes and fees.\n2. Safety rules.\n\tSynthetic test text only.';
 const dKey=K(),d1=ok(await draft(manager,{language:'en',title:'Membership agreement',body:body1,expectedVersion:0},{key:dKey}));
 assert.equal(d1.draft.version,1);assert.equal(d1.replayed,false);
 assert.equal(ok(await draft(manager,{language:'en',title:'Membership agreement',body:body1,expectedVersion:0},{key:dKey})).replayed,true);
 await denied(()=>draft(manager,{language:'en',title:'Other',body:body1,expectedVersion:0},{key:dKey}),409,'MEMBERSHIP_AGREEMENT_KEY_REUSED');
 await denied(()=>draft(manager2,{language:'en',title:'Other',body:body1,expectedVersion:0}),409,'MEMBERSHIP_AGREEMENT_VERSION_CONFLICT');
 const d2=ok(await draft(manager,{language:'en',title:'Membership agreement',body:body1+'\n3. Refunds.',expectedVersion:1}));assert.equal(d2.draft.version,2);
 const k1=ok(await draft(manager,{language:'ko',title:'회원 약관',body:'합성 테스트 문구입니다.',expectedVersion:0}));
 pass('staff with membership.agreement.manage at the exact school read and save drafts per language (version-checked, exact replay, key reuse refused); others are refused and nothing is written');

 // 3. Publish: exactly the previewed drafts, English required, the school confirms it is responsible for its wording.
 await denied(()=>publish(manager,{expectedNumber:0,drafts:[{language:'ko',version:1}]}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>publish(manager,{expectedNumber:0,drafts:[{language:'en',version:2}],schoolResponsible:false}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>publish(manager,{expectedNumber:0,drafts:[{language:'en',version:1}]}),409,'MEMBERSHIP_AGREEMENT_DRAFT_CHANGED');
 await denied(()=>publish(manager,{expectedNumber:1,drafts:[{language:'en',version:2}]}),409,'MEMBERSHIP_AGREEMENT_VERSION_CONFLICT');
 const pKey=K(),v1=ok(await publish(manager,{expectedNumber:0,drafts:[{language:'en',version:2},{language:'ko',version:1}]},{key:pKey}));
 assert.equal(v1.number,1);assert.deepEqual(v1.texts.map(t=>t.language),['en','ko']);
 assert.equal(v1.texts[0].digest,sha('Membership agreement\n\n'+body1+'\n3. Refunds.'));assert.equal(v1.texts[1].digest,sha(k1.draft.title+'\n\n'+k1.draft.body));
 assert.equal(ok(await publish(manager,{expectedNumber:0,drafts:[{language:'en',version:2},{language:'ko',version:1}]},{key:pKey})).replayed,true);
 await denied(()=>publish(manager,{expectedNumber:1,drafts:[{language:'en',version:2},{language:'ko',version:1}]}),400,'MEMBERSHIP_AGREEMENT_UNCHANGED');
 const afterPublish=ok(await read(manager));
 assert.equal(afterPublish.current.versionId,v1.versionId);assert.deepEqual(afterPublish.versions.map(v=>[v.number,v.languages,v.signatures]),[[1,['en','ko'],0]]);
 const pubAudit=(await q("SELECT next_state FROM hon.audit_events WHERE action_code='membership_agreement.publish' AND entity_id=$1",[v1.versionId]))[0].next_state;
 assert.deepEqual(Object.keys(pubAudit).sort(),['internalOnly','number','version','versionId']);
 pass('publishing makes an immutable version from exactly the previewed drafts (English required, stale preview or unchanged text refused) with a SHA-256 digest per language; identifier-only audit');

 // 4. Parent read: covered children, who signs, photo and face check-in; a VIEWER reads but cannot sign.
 const fam=ok(await familyRead(guardian));
 assert.equal(fam.canSign,true);assert.equal(fam.canChangePhotos,true);assert.equal(fam.agreement.versionId,v1.versionId);
 assert.equal(fam.face.available,true);assert.deepEqual(fam.face.forms.map(f=>f.language),['en','es','ko']);
 assert.deepEqual(fam.children.map(c=>[c.givenName,c.covered,c.signer,c.agreement.status,c.photo?.version??null]),
  [['Jun',true,'GUARDIAN','NOT_SIGNED',null],['Mina',true,'GUARDIAN','NOT_SIGNED',1],['Sora',false,'GUARDIAN','NOT_SIGNED',null],['Tae',true,'SELF','NOT_SIGNED',null]]);
 const asViewer=ok(await familyRead(viewer));assert.equal(asViewer.canSign,false);assert.equal(asViewer.canChangePhotos,false);
 await denied(()=>familyRead(outsider),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>send('parent/membership-agreement?familyId='+lee,{identity:guardian,method:'GET',command:SIGN}),400,'MEMBERSHIP_AGREEMENT_SELECTORS_NOT_ACCEPTED');
 const en=fam.agreement.texts[0],ilEn=fam.face.forms.find(f=>f.language==='en');
 const sb=(ids,faces=[],extra={})=>({versionId:v1.versionId,language:'en',digest:en.digest,signerName:'Hana Park',eSignConsent:true,studentProfileIds:ids,faceOptIns:faces,...extra});
 const opt=(s,f=ilEn)=>({studentProfileId:s.studentProfileId,formId:f.formId,formDigest:f.digest});
 pass('the parent sees the current version, every child with whether it is covered and who signs, photos and the face check-in box; a VIEWER cannot sign; no selectors');

 // 5. Every refusal leaves everything unsaved, including the other children of the same signing.
 await denied(()=>sign(viewer,sb([mina.studentProfileId])),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>sign(outsider,sb([mina.studentProfileId])),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>sign(guardian,sb([mina.studentProfileId],[],{eSignConsent:false})),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>sign(guardian,sb([mina.studentProfileId],[],{signerName:'H'})),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>sign(guardian,sb([mina.studentProfileId],[opt(jun)])),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>sign(guardian,sb([mina.studentProfileId],[],{digest:sha('other')})),409,'MEMBERSHIP_AGREEMENT_CHANGED');
 await denied(()=>sign(guardian,sb([mina.studentProfileId],[],{language:'es'})),409,'MEMBERSHIP_AGREEMENT_CHANGED');
 await denied(()=>sign(guardian,sb([mina.studentProfileId,ana.studentProfileId])),404,'MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND');
 await denied(()=>sign(guardian,sb([mina.studentProfileId,sora.studentProfileId])),400,'MEMBERSHIP_AGREEMENT_NOT_COVERED');
 await denied(()=>sign(guardian,sb([mina.studentProfileId,teen.studentProfileId])),400,'MEMBERSHIP_AGREEMENT_ADULT_SIGNS');
 await denied(()=>sign(guardian,sb([mina.studentProfileId,jun.studentProfileId],[opt(mina),opt(jun)])),400,'MEMBERSHIP_AGREEMENT_PHOTO_REQUIRED');
 await denied(()=>sign(guardian,sb([mina.studentProfileId,jun.studentProfileId],[opt(mina,{...ilEn,digest:sha('old form')})])),409,'FACE_CHECKIN_FORM_CHANGED');
 pass('a VIEWER, an outsider, no e-sign consent, a changed agreement, another family\'s child, an uncovered child, an adult, a face box without a photo and a changed face form are each refused, and nothing at all is saved');

 // 6. One signing: two children, face check-in for one; one transaction, separate records.
 const sKey=K(),signed=ok(await sign(guardian,sb([mina.studentProfileId,jun.studentProfileId],[opt(mina)]),{key:sKey}));
 assert.equal(signed.replayed,false);assert.equal(signed.number,1);
 assert.deepEqual(signed.children.map(c=>[c.studentProfileId,c.faceConsent?.state??null,c.faceConsent?.method??null]).sort(),
  [[mina.studentProfileId,'GIVEN','PARENT_PORTAL'],[jun.studentProfileId,null,null]].sort());
 const rows=await q('SELECT signing_id,student_profile_id,signer_name,esign_consent,face_consent_id,digest,language FROM hon.membership_agreement_signatures WHERE signing_id=$1',[signed.signingId]);
 assert.equal(rows.length,2);assert(rows.every(r=>r.signer_name==='Hana Park'&&r.esign_consent&&r.digest===en.digest&&r.language==='en'));
 const faceId=rows.find(r=>r.student_profile_id===mina.studentProfileId).face_consent_id;assert(faceId);assert.equal(rows.find(r=>r.student_profile_id===jun.studentProfileId).face_consent_id,null);
 assert.deepEqual((await q('SELECT form_id,form_digest,signer_kind,method,signer_principal_id FROM hon.face_checkin_consents WHERE id=$1',[faceId]))[0],
  {form_id:ilEn.formId,form_digest:ilEn.digest,signer_kind:'GUARDIAN',method:'PARENT_PORTAL',signer_principal_id:guardianPrincipal});
 const trail=await q("SELECT action_code,next_state FROM hon.audit_events WHERE request_id IN (SELECT request_id FROM hon.audit_events WHERE entity_id=$1) ORDER BY action_code",[signed.signingId]);
 assert.deepEqual(trail.map(t=>t.action_code),['face_checkin.family_sign','membership_agreement.family_sign']);
 assert(!JSON.stringify(trail).includes('Hana'),'audit holds identifiers only');
 assert.equal((await q("SELECT count(*)::int n FROM hon.outbox_events WHERE causation_id=(SELECT request_id FROM hon.audit_events WHERE entity_id=$1)",[signed.signingId]))[0].n,2);
 assert(!JSON.stringify((await q('SELECT response FROM hon.membership_agreement_requests WHERE idempotency_key=$1',[sKey]))[0].response).includes('Hana'),'receipts never hold the typed name');
 const replay=ok(await sign(guardian,sb([mina.studentProfileId,jun.studentProfileId],[opt(mina)]),{key:sKey}));assert.equal(replay.replayed,true);assert.equal(replay.signingId,signed.signingId);
 await denied(()=>sign(guardian,sb([jun.studentProfileId]),{key:sKey}),409,'MEMBERSHIP_AGREEMENT_KEY_REUSED');
 await denied(()=>sign(guardian,sb([jun.studentProfileId])),409,'MEMBERSHIP_AGREEMENT_ALREADY_SIGNED');
 const copy=ok(await familyRead(guardian));
 assert.deepEqual(copy.children.filter(c=>c.covered).map(c=>[c.givenName,c.agreement.status,c.faceConsent?.state??null]),[['Jun','SIGNED',null],['Mina','SIGNED','GIVEN'],['Tae','NOT_SIGNED',null]]);
 assert.equal(copy.signings.length,1);assert.equal(copy.signings[0].signerName,'Hana Park');
 assert.deepEqual(copy.signings[0].children.map(c=>[c.studentProfileId,c.faceOptIn]).sort(),[[mina.studentProfileId,true],[jun.studentProfileId,false]].sort());
 assert.deepEqual(ok(await read(manager)).summary,{covered:4,signed:2,needsNewVersion:0,notSigned:2});
 pass('one Sign records the agreement for each child and the face consent for the ticked child in one transaction; separate identifier-only trails; exact replay, key reuse and a second signing refused; the printable copy and staff summary follow');

 // 7. Parent photo upload: guardian only, metadata stripped, a replacement deletes the face template.
 const tagged=png(7,'GPS 41.88,-87.63');
 await denied(()=>photoSet(viewer,{studentProfileId:jun.studentProfileId,expectedVersion:null,mediaType:'image/png',data:tagged.toString('base64')}),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>photoSet(guardian,{studentProfileId:ana.studentProfileId,expectedVersion:null,mediaType:'image/png',data:tagged.toString('base64')}),404,'MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND');
 await denied(()=>photoSet(guardian,{studentProfileId:teen.studentProfileId,expectedVersion:null,mediaType:'image/png',data:tagged.toString('base64')}),400,'MEMBERSHIP_AGREEMENT_ADULT_SIGNS');
 await denied(()=>photoSet(guardian,{studentProfileId:jun.studentProfileId,expectedVersion:null,mediaType:'image/jpeg',data:tagged.toString('base64')}),400,'MEMBERSHIP_AGREEMENT_IMAGE_REFUSED');
 await denied(()=>photoSet(guardian,{studentProfileId:jun.studentProfileId,expectedVersion:null,mediaType:'image/png',data:tagged.toString('base64')},{command:SIGN}),403,'HUMAN_UI_REQUIRED');
 const phKey=K(),added=ok(await photoSet(guardian,{studentProfileId:jun.studentProfileId,expectedVersion:null,mediaType:'image/png',data:tagged.toString('base64')},{key:phKey}));
 assert.deepEqual([added.replaced,added.templatesDeleted,added.photo.version],[false,0,1]);
 const stored=(await q('SELECT content FROM hon.person_photos WHERE person_id=$1',[jun.personId]))[0].content;assert(!stored.includes(Buffer.from('GPS')));assert(stored.length<tagged.length);
 assert.equal(ok(await photoSet(guardian,{studentProfileId:jun.studentProfileId,expectedVersion:null,mediaType:'image/png',data:tagged.toString('base64')},{key:phKey})).replayed,true);
 assert(!JSON.stringify((await q('SELECT response FROM hon.membership_agreement_requests WHERE idempotency_key=$1',[phKey]))[0].response).includes(stored.toString('base64').slice(0,40)));
 assert.equal((await q("SELECT count(*)::int n FROM hon.outbox_events WHERE event_type='people.photo.set' AND aggregate_id=$1",[jun.personId]))[0].n,1);
 // Mina is enrolled (synthetic template from her photo); her guardian replaces the photo and the template goes at once.
 const minaPhoto=(await q('SELECT checksum,version FROM hon.person_photos WHERE person_id=$1',[mina.personId]))[0];
 await q("INSERT INTO hon.face_templates(student_profile_id,organization_id,school_id,consent_id,activation,photo_checksum,template,matcher,enrolled_by_principal_id) VALUES($1,$2,$3,$4,1,$5,decode($5,'hex'),'SYNTHETIC',$6)",[mina.studentProfileId,A.organizationId,A.schoolId,faceId,minaPhoto.checksum,managerPrincipal]);
 await denied(()=>photoSet(guardian,{studentProfileId:mina.studentProfileId,expectedVersion:null,mediaType:'image/png',data:png(8).toString('base64')}),409,'MEMBERSHIP_AGREEMENT_VERSION_CONFLICT');
 const replaced=ok(await photoSet(guardian,{studentProfileId:mina.studentProfileId,expectedVersion:minaPhoto.version,mediaType:'image/png',data:png(8).toString('base64')}));
 assert.deepEqual([replaced.replaced,replaced.templatesDeleted,replaced.photo.version],[true,1,2]);
 assert.equal((await q("SELECT reason FROM hon.face_template_deletions WHERE student_profile_id=$1 ORDER BY deleted_at DESC LIMIT 1",[mina.studentProfileId]))[0].reason,'PHOTO_CHANGED');
 await denied(()=>photoRemove(guardian,{studentProfileId:jun.studentProfileId,expectedVersion:2}),409,'MEMBERSHIP_AGREEMENT_VERSION_CONFLICT');
 const removed=ok(await photoRemove(guardian,{studentProfileId:jun.studentProfileId,expectedVersion:1}));assert.equal(removed.photo,null);
 assert.equal((await q('SELECT count(*)::int n FROM hon.person_photos WHERE person_id=$1',[jun.personId]))[0].n,0);
 pass('a guardian adds, replaces and removes a child\'s photo (metadata stripped by the API, version-checked, exact replay, image never in the receipt); a replacement deletes the face template at once; VIEWER, adult, other-family and wrong-type uploads refused');

 // 8. A new version: earlier signatures stay and show "needs signing"; the face box is refused while the school is OFF.
 const d3=ok(await draft(manager,{language:'en',title:'Membership agreement',body:body1+'\n3. Refunds.\n4. Photos.',expectedVersion:2}));
 const v2=ok(await publish(manager,{expectedNumber:1,drafts:[{language:'en',version:d3.draft.version}]}));assert.equal(v2.number,2);
 assert.deepEqual(ok(await read(manager)).summary,{covered:4,signed:0,needsNewVersion:2,notSigned:2});
 assert.equal((await q('SELECT count(*)::int n FROM hon.membership_agreement_signatures WHERE version_id=$1',[v1.versionId]))[0].n,2);
 const fam2=ok(await familyRead(guardian));assert.deepEqual(fam2.children.filter(c=>c.covered).map(c=>[c.givenName,c.agreement.status,c.agreement.versionNumber]),[['Jun','NEEDS_NEW_VERSION',1],['Mina','NEEDS_NEW_VERSION',1],['Tae','NOT_SIGNED',null]]);
 assert.deepEqual(fam2.signings,[]);
 await denied(()=>sign(guardian,sb([mina.studentProfileId])),409,'MEMBERSHIP_AGREEMENT_CHANGED');
 await q("UPDATE hon.face_checkin_settings SET status='OFF',profile_code=NULL,acknowledgements='{}',off_reason='OWNER',version=version+1 WHERE school_id=$1",[A.schoolId]);
 const en2=fam2.agreement.texts[0];
 const sb2=(ids,faces=[])=>sb(ids,faces,{versionId:v2.versionId,digest:en2.digest});
 assert.equal(ok(await familyRead(guardian)).face.available,false);
 await denied(()=>sign(guardian,sb2([jun.studentProfileId,mina.studentProfileId],[opt(mina)])),403,'FACE_CHECKIN_OFF');
 const s2=ok(await sign(guardian,sb2([jun.studentProfileId,mina.studentProfileId])));assert(s2.children.every(c=>c.faceConsent===null));
 assert.deepEqual(ok(await read(manager)).summary,{covered:4,signed:2,needsNewVersion:0,notSigned:2});
 pass('a new version never edits earlier signatures, which show "needs signing (new version)"; the old version can no longer be signed; with face check-in OFF the face box is refused and the agreement alone signs');

 // 9. The database refuses unguarded changes even for the owner.
 for(const st of ["UPDATE hon.membership_agreement_signatures SET signer_name='x'","DELETE FROM hon.membership_agreement_signatures","UPDATE hon.membership_agreement_texts SET body='x'",
  "DELETE FROM hon.membership_agreement_texts","UPDATE hon.membership_agreement_versions SET number=number+10","DELETE FROM hon.membership_agreement_versions",
  "UPDATE hon.membership_agreement_drafts SET title='x'","DELETE FROM hon.membership_agreement_drafts","UPDATE hon.membership_agreement_requests SET response='{}'::jsonb",
  "TRUNCATE hon.membership_agreement_signatures","TRUNCATE hon.membership_agreement_versions","TRUNCATE hon.membership_agreement_requests",
  "INSERT INTO hon.membership_agreement_texts(version_id,organization_id,school_id,language,title,body,digest) SELECT version_id,organization_id,school_id,'es',title,body,digest FROM hon.membership_agreement_texts LIMIT 1",
  "INSERT INTO hon.membership_agreement_signatures(organization_id,school_id,signing_id,version_id,language,digest,student_profile_id,family_id,signer_kind,signer_name,esign_consent,method,signer_principal_id) SELECT organization_id,school_id,signing_id,version_id,language,digest,student_profile_id,family_id,'GUARDIAN',signer_name,false,method,signer_principal_id FROM hon.membership_agreement_signatures LIMIT 1"]){
  await admin.query('BEGIN');await assert.rejects(()=>admin.query(st),e=>['42501','23503','23514','23505','0A000'].includes(e.code),st);await admin.query('ROLLBACK');}
 pass('versions, texts and signatures are immutable; a text digest must match its words; a signature needs e-sign consent; drafts change only by version; receipts record once');

 // 10. Authority is decided again after the last write.
 const waitFor=async()=>{for(let i=0;i<300;i++){if((await q("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND NOT granted"))[0].n!=='0')return;await new Promise(r=>setTimeout(r,10));}throw new Error('never waited');};
 async function whileBlocked(start,revoke){
  const blocker=new pg.Client({connectionString:owner.toString(),ssl:false});await blocker.connect();
  try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['membership-agreement:'+A.schoolId]);
   const c=await counts();const waiting=start();await waitFor();await revoke();
   await blocker.query('ROLLBACK');const res=await waiting;assert.equal(res.status,403,JSON.stringify(res.body));assert.equal(res.body.code,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
   assert.deepEqual(await counts(),c);}
  finally{await blocker.end();}
 }
 await whileBlocked(()=>sign(leeParent,{...sb2([ana.studentProfileId]),signerName:'Min Lee'}),
  ()=>q("UPDATE hon.family_access_grants SET effective_until=clock_timestamp() WHERE id=$1",[grants[leeParent.externalSubject]]));
 const enDraft=ok(await read(manager)).drafts.find(d=>d.language==='en');
 await whileBlocked(()=>draft(manager,{language:'en',title:'Membership agreement',body:'Changed while waiting',expectedVersion:enDraft.version}),
  ()=>q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[managerGrant]));
 await denied(()=>read(manager),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 pass('a signing whose family grant ends, and a draft whose staff grant is revoked, while they wait commit nothing');
 console.log('Membership agreement proof (0454): '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
