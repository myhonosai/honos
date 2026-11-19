/** 0499 membership agreement signing link by email and text. Real signed HON sessions -> Nest/guard -> fixed runtime SQL, and the public link through its strict transport -> marked disposable PostgreSQL (Champions Club fixture). */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {membershipFixtureQuery} from './membership-activation-test-support.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER|SMS|EMAIL).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {MembershipAgreementService}=require('./dist/membership-agreement/membership-agreement.service.js');
const {MembershipAgreementController,MembershipAgreementHumanGuard,FamilyMembershipAgreementController,FamilyMembershipAgreementSignGuard,FamilyPersonPhotoGuard,
 MembershipAgreementLinkController,MembershipAgreementLinkHumanGuard,PublicMembershipAgreementLinkController}=require('./dist/membership-agreement/membership-agreement.controller.js');
const {publicAgreementLinkTransport}=require('./dist/membership-agreement/public-agreement-link-transport.js');
const {MEMBERSHIP_AGREEMENT_HUMAN_COMMAND:MANAGE,MEMBERSHIP_AGREEMENT_LINK_COMMAND:LINK,FAMILY_MEMBERSHIP_AGREEMENT_SIGN_COMMAND:SIGN,
 MEMBERSHIP_AGREEMENT_LINK_CONFIRMATION:CONFIRM}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'membership-agreement-link-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS MEMBERSHIP-AGREEMENT-LINK '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:agreement-link:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
const SVC='00000000-0000-4000-8000-000000000499';
function http(path,{identity,body,key=K(),method='POST',command=LINK,headers={},raw}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key?{'idempotency-key':key}:{})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(raw!==undefined?raw:body===undefined?undefined:JSON.stringify(body));});
}
// The public side: no cookie, no command header, no origin.
function pub(path,{body,method='POST',raw,headers={}}={}){
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/public/membership-agreement-links/'+path,{method,headers:{...(method==='POST'?{'content-type':'application/json'}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(raw!==undefined?raw:body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['membership_agreement_links','membership_agreement_signatures','membership_agreement_requests','communication_messages','audit_events','outbox_events'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status,code){
 const before=await counts();const r=await work();
 assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code??r.body.result,code,JSON.stringify(r.body));
 assert.deepEqual(await counts(),before);assert(!('data' in r.body));
 assert(!JSON.stringify(r.body).match(/SQLSTATE|SELECT |external_subject|hon\./));return r;
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
const sha=s=>createHash('sha256').update(s).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
let A,B;

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');

 // 1. Runtime ACL: one private forced-RLS table, exactly four runtime entry points, helpers owner-only, the deployment verifier section passes.
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.membership_agreement_links',p]))[0].ok,false,p);
 assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid='hon.membership_agreement_links'::regclass"))[0],{r:true,f:true,n:0});
 const entries=['read_membership_agreement_send','send_membership_agreement_link','read_membership_agreement_link','sign_membership_agreement_link'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND (p.proname LIKE 'membership\\_agreement\\_link%' OR p.proname='guard_membership_agreement_link' OR p.proname=ANY($1))",[entries]);
 assert.equal(fns.length,entries.length+5);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.membership_agreement_links'),e=>e.code==='42501');
 assert.equal((await q("SELECT count(*)::int n FROM hon.principals WHERE id=$1 AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active",[SVC]))[0].n,1);
 {const verify=readFileSync(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Membership agreement signing link exact verification (0499)')[1]?.split('-- End membership agreement signing link exact verification.')[0];
  assert(section);await q(section.replaceAll('hon_runtime',runtime.username));}
 pass('one private forced-RLS link table; the runtime executes only the four entry points; helpers owner-only; the deployment verifier section passes');

 // Fixture: two schools with paid access; a family with a guardian (email consent, no text consent), a second guardian with no address.
 const hq={subject:'agreement-link-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Agreement link synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Agreement link synthetic','Agreement link synthetic','Link school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'agreement-link-'+K(),K(),K()]))[0];
 A=await provision();B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const role=await customRole(A,'CUSTOM_AGREEMENT_SEND',['school.view','membership.agreement.manage','communication.message.queue']);
 const manager=person('manager'),managerPrincipal=await human(manager,'Manager');const managerGrant=await grant(A,managerPrincipal,role);
 const writer=person('writer');await grant(A,await human(writer,'Writer'),await customRole(A,'CUSTOM_AGREEMENT_ONLY',['school.view','membership.agreement.manage']));
 const desk=person('desk');await grant(A,await human(desk,'Desk'),await customRole(A,'CUSTOM_DESK',['school.view','people.read','communication.message.queue']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_AGREEMENT_SEND',['school.view','membership.agreement.manage','communication.message.queue']));
 const [park,lee]=[K(),K()];await q("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Park Family'),($2,$3,$4,'Lee Family')",[park,lee,A.organizationId,A.schoolId]);
 const addPerson=async(given,family,{email=null,phone=null}={})=>(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[A.organizationId,A.schoolId,given,family,email,phone]))[0].id;
 const member=(family,p,role)=>q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,$5)",[A.organizationId,A.schoolId,family,p,role]);
 const consent=(p,channel,status)=>q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,$4,$5,'STAFF',clock_timestamp(),$6)",[A.organizationId,A.schoolId,p,channel,status,managerPrincipal]);
 const hana=await addPerson('Hana','Park',{email:'hana-'+K()+'@example.invalid',phone:'+15555550123'});await member(park,hana,'GUARDIAN');
 await consent(hana,'EMAIL','OPTED_IN');await consent(hana,'SMS','OPTED_OUT');
 const joon=await addPerson('Joon','Park');await member(park,joon,'GUARDIAN');await consent(joon,'SMS','OPTED_IN');
 const leeMom=await addPerson('Min','Lee',{email:'min-'+K()+'@example.invalid'});await member(lee,leeMom,'GUARDIAN');
 const account=(await q("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,'USD') RETURNING id",[A.organizationId,A.schoolId,hana]))[0].id;
 const addStudent=async(given,family,{birth=null,familyId=null,membership=null}={})=>{
  const p=await addPerson(given,family);
  if(familyId)await member(familyId,p,'STUDENT');
  if(membership)await membershipFixtureQuery(admin,"INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,'SYNTHETIC_PLAN',$5,$6,$7)",[A.organizationId,A.schoolId,account,p,membership,membership==='DRAFT'?null:'2026-01-01T00:00:00Z',membership==='DRAFT'?null:'2027-01-01T00:00:00Z']);
  return {personId:p,studentProfileId:(await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5) RETURNING id',[A.organizationId,A.schoolId,p,familyId,birth]))[0].id};
 };
 const mina=await addStudent('Mina','Park',{birth:'2016-03-01',familyId:park,membership:'ACTIVE'});
 const jun=await addStudent('Jun','Park',{familyId:park,membership:'DRAFT'});
 const tae=await addStudent('Tae','Park',{birth:'2000-01-01',familyId:park,membership:'ACTIVE'});
 const sora=await addStudent('Sora','Park',{birth:'2018-01-01',familyId:park,membership:'CANCELLED'});
 const ana=await addStudent('Ana','Lee',{birth:'2015-01-01',familyId:lee,membership:'ACTIVE'});
 const loner=await addStudent('Solo','Kim',{birth:'2015-01-01',membership:'ACTIVE'});
 const module=await Test.createTestingModule({controllers:[MembershipAgreementController,FamilyMembershipAgreementController,MembershipAgreementLinkController,PublicMembershipAgreementLinkController],
  providers:[MembershipAgreementService,MembershipAgreementHumanGuard,MembershipAgreementLinkHumanGuard,FamilyMembershipAgreementSignGuard,FamilyPersonPhotoGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false,bodyParser:false});app.use(publicAgreementLinkTransport());app.use(require('express').json());app.setGlobalPrefix('v1');
 await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const readSend=(identity,student,s=A.schoolId)=>http('school/schools/'+s+'/people/'+student+'/membership-agreement-link',{identity,method:'GET'});
 const sendLink=(identity,b,o={})=>http('school/membership-agreement-link/send',{identity,body:{schoolId:A.schoolId,confirmation:CONFIRM,...b},...o});

 // 2. Staff read: membership.agreement.manage AND communication.message.queue at this exact school. Before a publish no child is offered.
 for(const who of [writer,desk,managerB])await denied(()=>readSend(who,mina.personId),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>readSend(managerB,mina.personId,B.schoolId),404,'MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND');
 const before=ok(await readSend(manager,mina.personId));
 assert.deepEqual(before,{current:null,familyId:park,guardians:[
  {personId:hana,givenName:'Hana',familyName:'Park',email:{address:true,consent:true},text:{address:true,consent:false}},
  {personId:joon,givenName:'Joon',familyName:'Park',email:{address:false,consent:false},text:{address:false,consent:true}}],children:[],latestLink:null});
 assert.deepEqual(ok(await readSend(manager,loner.personId)),{current:null,familyId:null,guardians:[],children:[],latestLink:null});
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL'],token:token()}),400,'MEMBERSHIP_AGREEMENT_NOT_PUBLISHED');
 // Publish version 1 directly (the 0463 proof covers publishing).
 const publishVersion=async(n,body)=>{const v=(await q("INSERT INTO hon.membership_agreement_versions(organization_id,school_id,number,published_by_principal_id) VALUES($1,$2,$3,$4) RETURNING id",[A.organizationId,A.schoolId,n,managerPrincipal]))[0].id;
  await q("INSERT INTO hon.membership_agreement_texts(version_id,organization_id,school_id,language,title,body,digest) VALUES($1,$2,$3,'en','Membership agreement',$4,$5)",[v,A.organizationId,A.schoolId,body,sha('Membership agreement\n\n'+body)]);
  return {versionId:v,digest:sha('Membership agreement\n\n'+body)};};
 await admin.query('BEGIN');const v1=await publishVersion(1,'1. Synthetic test text only.');await admin.query('COMMIT');
 const read1=ok(await readSend(manager,mina.personId));
 assert.equal(read1.current.versionId,v1.versionId);
 assert.deepEqual(read1.children.map(c=>c.givenName),['Jun','Mina']);
 pass('staff need membership.agreement.manage and communication.message.queue at the exact school; the read lists the family guardians with address and consent per channel and only the children who still need to sign (covered, under 18, not signed)');

 // 3. Send: refusals write nothing; a guardian of the family receives the link by each channel they opted in to.
 const t1=token(),key1=K();
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:leeMom,channels:['EMAIL'],token:t1}),400,'MEMBERSHIP_AGREEMENT_RECIPIENT_NOT_ALLOWED');
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:mina.personId,channels:['EMAIL'],token:t1}),400,'MEMBERSHIP_AGREEMENT_RECIPIENT_NOT_ALLOWED');
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL'],token:'short'}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL','EMAIL'],token:t1}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['PUSH'],token:t1}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL'],token:t1,confirmation:'yes'}),400,'MEMBERSHIP_AGREEMENT_INVALID');
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL'],token:t1},{command:MANAGE}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>sendLink(writer,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL'],token:t1}),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>sendLink(manager,{personId:tae.personId,recipientPersonId:hana,channels:['EMAIL'],token:t1,schoolId:B.schoolId}),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 const s1=ok(await sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL','SMS'],token:t1},{key:key1}));
 assert.equal(s1.replayed,false);assert.equal(s1.link.state,'OPEN');assert.equal(s1.link.recipientPersonId,hana);
 assert.deepEqual([...s1.link.studentProfileIds].sort(),[jun.studentProfileId,mina.studentProfileId].sort());
 assert.deepEqual(s1.deliveries.map(d=>[d.channel,d.outcome,d.messageId!==null]),[['EMAIL','QUEUED',true],['SMS','NO_CONSENT',false]]);
 assert(!JSON.stringify(s1).includes(t1));
 const msg=(await q('SELECT * FROM hon.communication_messages WHERE id=$1',[s1.deliveries[0].messageId]))[0];
 assert.equal(msg.recipient_person_id,hana);assert.equal(msg.channel,'EMAIL');assert.equal(msg.lifecycle,'QUEUED');assert.equal(msg.origin_kind,'MEMBERSHIP_AGREEMENT');
 assert.equal(msg.origin_id,s1.link.linkId);assert.equal(msg.email_subject,'Membership agreement from Link school');assert.equal(msg.created_by_principal_id,managerPrincipal);
 assert(msg.content.includes(origin+'/agreement/'+t1),msg.content);assert(msg.content.includes('Jun, Mina'));
 const link1=(await q('SELECT * FROM hon.membership_agreement_links WHERE id=$1',[s1.link.linkId]))[0];
 assert.equal(link1.token_hash,sha(t1));assert(!JSON.stringify(link1).includes(t1));
 const audit=(await q("SELECT next_state FROM hon.audit_events WHERE action_code='membership_agreement.link_send' AND entity_id=$1",[s1.link.linkId]))[0].next_state;
 const outbox=(await q("SELECT payload FROM hon.outbox_events WHERE event_type='membership_agreement.link_send' AND aggregate_id=$1",[s1.link.linkId]))[0].payload;
 for(const x of [audit,outbox]){assert(!JSON.stringify(x).includes(t1));assert(!JSON.stringify(x).includes('Hana'));assert.equal(x.internalOnly,true);}
 assert(!JSON.stringify((await q("SELECT response FROM hon.membership_agreement_requests WHERE operation='link_send'"))).includes(t1));
 const replay=ok(await sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL','SMS'],token:t1},{key:key1}));
 assert.equal(replay.replayed,true);assert.deepEqual(replay.link,s1.link);
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL'],token:t1},{key:key1}),409,'MEMBERSHIP_AGREEMENT_KEY_REUSED');
 // A text to the second guardian: opted in, but no phone number, so nothing is queued and staff can copy the link.
 const t2=token(),s2=ok(await sendLink(manager,{personId:jun.personId,recipientPersonId:joon,channels:['SMS','EMAIL'],token:t2}));
 assert.deepEqual(s2.deliveries.map(d=>[d.channel,d.outcome]),[['EMAIL','NO_CONSENT'],['SMS','NO_ADDRESS']]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.communication_messages WHERE origin_id=$1",[s2.link.linkId]))[0].n,0);
 assert.equal((await q('SELECT state FROM hon.membership_agreement_links WHERE id=$1',[s1.link.linkId]))[0].state,'REPLACED');
 const read2=ok(await readSend(manager,mina.personId));assert.equal(read2.latestLink.linkId,s2.link.linkId);assert.equal(read2.latestLink.state,'OPEN');
 pass('a send makes one link for the family (only its SHA-256 stored), queues each opted-in channel with an address (origin MEMBERSHIP_AGREEMENT, link in the text) and reports the rest; exact replay, key reuse refused; a new send replaces the open link; other families, students, schools and bad input refused with nothing written; the token never reaches a receipt, audit or outbox');

 // 4. Public read through the strict transport: unknown and malformed tokens, a replaced link, the open link.
 const gone=await pub(token(),{method:'GET'});assert.equal(gone.status,404);assert.equal(gone.headers['cache-control'],'no-store');assert.equal(gone.headers['x-robots-tag'],'noindex');
 assert.equal((await pub('not-a-token',{method:'GET'})).status,400);
 assert.equal((await pub(t2+'?x=1',{method:'GET'})).status,400);
 assert.deepEqual((await pub(t1,{method:'GET'})).body,{data:{state:'REPLACED',schoolName:'Link school'}});
 const view=(await pub(t2,{method:'GET'})).body.data;
 assert.equal(view.state,'OPEN');assert.equal(view.schoolName,'Link school');assert.equal(view.recipientGivenName,'Joon');
 assert.equal(view.agreement.versionId,v1.versionId);assert.deepEqual(view.children.map(c=>c.givenName),['Jun','Mina']);
 assert(!JSON.stringify(view).match(/familyName|Park|email|phone|@/));
 pass('the public link read (strict transport, no cookie, never cached or indexed) shows only the school, the guardian\'s given name, the agreement and the children\'s given names; unknown, malformed and replaced links show nothing more');

 // 5. Public sign: binds the current version and digest; a subset of the link's children; signs once.
 const base={versionId:v1.versionId,language:'en',digest:v1.digest,signerName:'Joon Park',eSignConsent:true};
 await denied(()=>pub(t2+'/sign',{body:{...base,eSignConsent:false,studentProfileIds:[mina.studentProfileId]}}),400,'INVALID');
 await denied(()=>pub(t2+'/sign',{body:{...base,studentProfileIds:[ana.studentProfileId]}}),400,'INVALID');
 await denied(()=>pub(t2+'/sign',{body:{...base,studentProfileIds:[tae.studentProfileId]}}),400,'INVALID');
 await denied(()=>pub(t2+'/sign',{body:{...base,signerName:'<b>',studentProfileIds:[mina.studentProfileId]}}),400,'INVALID');
 await denied(()=>pub(t2+'/sign',{body:{...base,digest:'0'.repeat(64),studentProfileIds:[mina.studentProfileId]}}),409,'CHANGED');
 await denied(()=>pub(t2+'/sign',{raw:'{"a":1,"a":2}'}),400,'INVALID');
 await denied(()=>pub(t1+'/sign',{body:{...base,studentProfileIds:[mina.studentProfileId]}}),410,'GONE');
 const signed=await pub(t2+'/sign',{body:{...base,studentProfileIds:[mina.studentProfileId]}});
 assert.equal(signed.status,201);assert.deepEqual(signed.body,{result:'SIGNED'});
 const sig=(await q('SELECT * FROM hon.membership_agreement_signatures WHERE link_id=$1',[s2.link.linkId]));
 assert.equal(sig.length,1);assert.equal(sig[0].student_profile_id,mina.studentProfileId);assert.equal(sig[0].method,'SIGNING_LINK');assert.equal(sig[0].signer_principal_id,SVC);
 assert.equal(sig[0].signer_kind,'GUARDIAN');assert.equal(sig[0].family_id,park);assert.equal(sig[0].face_consent_id,null);assert.equal(sig[0].version_id,v1.versionId);assert.equal(sig[0].digest,v1.digest);
 const sAudit=(await q("SELECT actor_principal_id,source,next_state FROM hon.audit_events WHERE action_code='membership_agreement.link_sign' AND entity_id=$1",[sig[0].signing_id]))[0];
 assert.equal(sAudit.actor_principal_id,SVC);assert.equal(sAudit.source,'PUBLIC_API');assert(!JSON.stringify(sAudit).includes('Joon'));
 assert.equal((await q('SELECT state FROM hon.membership_agreement_links WHERE id=$1',[s2.link.linkId]))[0].state,'SIGNED');
 const again=await pub(t2+'/sign',{body:{...base,studentProfileIds:[mina.studentProfileId]}});assert.equal(again.status,200);assert.deepEqual(again.body,{result:'ALREADY_SIGNED'});
 assert.deepEqual((await pub(t2,{method:'GET'})).body,{data:{state:'SIGNED',schoolName:'Link school'}});
 const read3=ok(await readSend(manager,mina.personId));assert.deepEqual(read3.children.map(c=>c.givenName),['Jun']);assert.equal(read3.latestLink.state,'SIGNED');
 assert.equal((await q("SELECT status FROM (SELECT hon.membership_agreement_status_json($1,$2,$3,$4)->>'status' status) x",[A.organizationId,A.schoolId,mina.studentProfileId,v1.versionId]))[0].status,'SIGNED');
 pass('signing from the link binds the current version, language and digest for a subset of the link\'s children (method SIGNING_LINK, the link principal, no face consent), closes the link, and a retry reads ALREADY_SIGNED; bad input, other children, a changed digest and a replaced link sign nothing');

 // 6. A new version after the send: the old text is refused and the link shows the new one. An expired link is gone.
 const t3=token(),s3=ok(await sendLink(manager,{personId:jun.personId,recipientPersonId:hana,channels:['EMAIL'],token:t3}));
 assert.deepEqual(s3.link.studentProfileIds,[jun.studentProfileId]);
 await admin.query('BEGIN');const v2=await publishVersion(2,'2. Synthetic test text, second version.');await admin.query('COMMIT');
 await denied(()=>pub(t3+'/sign',{body:{...base,studentProfileIds:[jun.studentProfileId]}}),409,'CHANGED');
 assert.equal((await pub(t3,{method:'GET'})).body.data.agreement.versionId,v2.versionId);
 // Mina signed only version 1, so version 2 offers her again; the link made before stays limited to its own children.
 assert.deepEqual((await pub(t3,{method:'GET'})).body.data.children.map(c=>c.givenName),['Jun']);
 const t4=token();await q("INSERT INTO hon.membership_agreement_links(organization_id,school_id,family_id,recipient_person_id,student_profile_ids,token_hash,created_by_principal_id,created_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,t,t+interval '14 days' FROM (SELECT clock_timestamp()-interval '15 days' t) x",
  [A.organizationId,A.schoolId,lee,leeMom,[ana.studentProfileId],sha(t4),managerPrincipal]);
 assert.deepEqual((await pub(t4,{method:'GET'})).body,{data:{state:'EXPIRED',schoolName:'Link school'}});
 await denied(()=>pub(t4+'/sign',{body:{...base,versionId:v2.versionId,digest:v2.digest,studentProfileIds:[ana.studentProfileId]}}),410,'GONE');
 assert.equal((await pub(t3+'/sign',{body:{...base,versionId:v2.versionId,digest:v2.digest,studentProfileIds:[jun.studentProfileId]}})).status,201);
 pass('a version published after the send is the one the link shows and signs (the old digest is refused); an expired link shows EXPIRED and signs nothing');

 // 7. Evidence: links only close, once; link signatures need their link and the link principal; nothing is removed.
 const lid=s3.link.linkId;
 for(const sql of ["UPDATE hon.membership_agreement_links SET state='OPEN',closed_at=NULL WHERE id=$1","UPDATE hon.membership_agreement_links SET token_hash=repeat('a',64) WHERE id=$1",
   "DELETE FROM hon.membership_agreement_links WHERE id=$1"])await assert.rejects(()=>q(sql,[lid]),e=>e.message==='MEMBERSHIP_AGREEMENT_IMMUTABLE');
 await assert.rejects(()=>q('TRUNCATE hon.membership_agreement_links CASCADE'),e=>e.message==='MEMBERSHIP_AGREEMENT_IMMUTABLE');
 await assert.rejects(()=>q("UPDATE hon.membership_agreement_signatures SET link_id=NULL WHERE link_id=$1",[lid]),e=>e.message==='MEMBERSHIP_AGREEMENT_IMMUTABLE');
 const sigCols="organization_id,school_id,signing_id,version_id,language,digest,student_profile_id,family_id,signer_kind,signer_name,esign_consent,method,signer_principal_id,link_id";
 await assert.rejects(()=>q(`INSERT INTO hon.membership_agreement_signatures(${sigCols}) VALUES($1,$2,gen_random_uuid(),$3,'en',$4,$5,$6,'GUARDIAN','Synthetic',true,'SIGNING_LINK',$7,NULL)`,
  [A.organizationId,A.schoolId,v2.versionId,v2.digest,mina.studentProfileId,park,SVC]),e=>e.code==='23514');
 await assert.rejects(()=>q(`INSERT INTO hon.membership_agreement_signatures(${sigCols}) VALUES($1,$2,gen_random_uuid(),$3,'en',$4,$5,$6,'GUARDIAN','Synthetic',true,'SIGNING_LINK',$7,$8)`,
  [A.organizationId,A.schoolId,v2.versionId,v2.digest,mina.studentProfileId,park,managerPrincipal,lid]),e=>e.code==='23514');
 await assert.rejects(()=>q(`INSERT INTO hon.membership_agreement_signatures(${sigCols}) VALUES($1,$2,gen_random_uuid(),$3,'en',$4,$5,$6,'GUARDIAN','Synthetic',true,'PARENT_PORTAL',$7,$8)`,
  [A.organizationId,A.schoolId,v2.versionId,v2.digest,mina.studentProfileId,park,managerPrincipal,lid]),e=>e.code==='23514');
 await assert.rejects(()=>q("INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,created_by_principal_id,queued_by_principal_id,origin_kind) VALUES($1,$2,$3,'EMAIL','x','QUEUED',$4,$4,'MEMBERSHIP_AGREEMENT')",
  [A.organizationId,A.schoolId,hana,managerPrincipal]),e=>e.code==='23514');
 pass('links only close once (no reopen, token change, delete or truncate); a link signature needs its link and the link principal and a portal signature cannot name a link; an agreement message must name its link');

 // 8. A link works only while it still could have been sent: the recipient is still a GUARDIAN of the family and the
 // organization, school, family and entitlement are live, at read, at sign and again after the last sign write.
 const t5=token();await q("UPDATE hon.membership_agreement_links SET state='REPLACED',closed_at=clock_timestamp() WHERE token_hash=$1",[sha(t4)]);
 await q("INSERT INTO hon.membership_agreement_links(organization_id,school_id,family_id,recipient_person_id,student_profile_ids,token_hash,created_by_principal_id,created_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,t,t+interval '14 days' FROM (SELECT clock_timestamp() t) x",
  [A.organizationId,A.schoolId,lee,leeMom,[ana.studentProfileId],sha(t5),managerPrincipal]);
 const signAna={...base,signerName:'Min Lee',versionId:v2.versionId,digest:v2.digest,studentProfileIds:[ana.studentProfileId]};
 const goneNow=async label=>{const r=await pub(t5,{method:'GET'});assert.equal(r.status,404,label);assert.deepEqual(r.body,{result:'GONE'},label);
  await denied(()=>pub(t5+'/sign',{body:signAna}),410,'GONE');};
 assert.equal((await pub(t5,{method:'GET'})).body.data.state,'OPEN');
 const lapses=[
  ["UPDATE hon.family_members SET member_role='OTHER' WHERE family_id=$1 AND person_id=$2",[lee,leeMom],"UPDATE hon.family_members SET member_role='GUARDIAN' WHERE family_id=$1 AND person_id=$2"],
  ["UPDATE hon.families SET status='SUSPENDED' WHERE id=$1",[lee],"UPDATE hon.families SET status='ACTIVE' WHERE id=$1"],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1",[A.schoolId],"UPDATE hon.schools SET status='ACTIVE' WHERE id=$1"],
  ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1",[A.organizationId],"UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1"],
  ["UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1",[A.organizationId],"UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1"]];
 for(const [stop,args,restore] of lapses){await q(stop,args);await goneNow(stop);await q(restore,args);assert.equal((await pub(t5,{method:'GET'})).body.data.state,'OPEN',restore);}
 // A guardian removed while the signing waits (simulated in the same transaction, after the signature row): nothing commits.
 await q(`CREATE FUNCTION hon.fixture_remove_link_guardian() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
   UPDATE hon.family_members SET member_role='OTHER' WHERE family_id=NEW.family_id AND person_id='${leeMom}'; RETURN NEW; END $f$`);
 await q('CREATE TRIGGER fixture_remove_link_guardian AFTER INSERT ON hon.membership_agreement_signatures FOR EACH ROW WHEN (NEW.link_id IS NOT NULL) EXECUTE FUNCTION hon.fixture_remove_link_guardian()');
 try{await denied(()=>pub(t5+'/sign',{body:signAna}),410,'GONE');}
 finally{await q('DROP TRIGGER fixture_remove_link_guardian ON hon.membership_agreement_signatures');await q('DROP FUNCTION hon.fixture_remove_link_guardian()');}
 assert.equal((await q("SELECT member_role FROM hon.family_members WHERE family_id=$1 AND person_id=$2",[lee,leeMom]))[0].member_role,'GUARDIAN');
 assert.equal((await q('SELECT count(*)::int n FROM hon.membership_agreement_signatures WHERE student_profile_id=$1',[ana.studentProfileId]))[0].n,0);
 assert.equal((await q('SELECT state FROM hon.membership_agreement_links WHERE token_hash=$1',[sha(t5)]))[0].state,'OPEN');
 assert.equal((await pub(t5+'/sign',{body:signAna})).status,201);
 pass('a link shows and signs nothing once its guardian is no longer a GUARDIAN of the family or the family, school, organization or entitlement is not live, and works again when restored; a guardian removed after the signature write commits nothing');

 // 9. Authority is decided live: a revoked grant reads and sends nothing.
 await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[managerGrant]);
 await denied(()=>readSend(manager,mina.personId),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 await denied(()=>sendLink(manager,{personId:mina.personId,recipientPersonId:hana,channels:['EMAIL'],token:token()}),403,'MEMBERSHIP_AGREEMENT_FORBIDDEN');
 pass('a revoked staff grant reads and sends nothing');
 console.log('Membership agreement signing link proof (0499): '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
