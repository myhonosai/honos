import pg from 'pg';
import assert from 'node:assert/strict';
import {randomUUID as K} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import {verifyA2pPreparationSecurity} from './a2p-preparation-security.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const u of [owner,runtime])assert(u.protocol==='postgresql:'&&u.hostname==='localhost'&&u.port==='5432'&&u.pathname==='/hon_champions_validation'&&!u.search&&!u.hash&&u.password);
assert(owner.username==='hon_champions_owner'&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^PG[A-Z_]*$|^NODE_OPTIONS$|^(?:TWILIO|ZERNIO|STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:AI|PROVIDER|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const api=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const {Test}=api('@nestjs/testing'),{json}=api('express'),c=api('@hon/contracts'),auth=api('@hon/auth');
const {RuntimeDatabaseService}=api('./dist/foundation/runtime-database.service.js');
const {A2pPreparationService}=api('./dist/a2p/a2p-preparation.service.js');
const {A2pPreparationController,A2pPreparationHumanGuard}=api('./dist/a2p/a2p-preparation.controller.js');
const {A2P_WEBSITE_INSPECTOR,UnavailableA2pWebsiteInspector}=api('./dist/a2p/a2p-inspector.js');
const {HonIdentityService}=api('./dist/foundation/hon-identity.service.js');
const {draft,review}=api('./test/fixtures/a2p-fixtures.cjs');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const db=new RuntimeDatabaseService(),service=new A2pPreparationService(db,new UnavailableA2pWebsiteInspector());
const ids=Object.fromEntries(['org','school','second','foreignOrg','foreignSchool','user','principal','role','grant'].map(k=>[k,K()]));
const subject='a2p-proof-'+K();let groups=0,app;
const pass=label=>console.log('PASS A2P '+(++groups)+': '+label);
const deny=(promise,status,code)=>assert.rejects(promise,e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const ctx=(patch={})=>({organizationId:ids.org,schoolId:ids.school,principalId:ids.principal,principalType:'HUMAN_USER',externalSubject:subject,requestId:K(),...patch});
async function counts(){return(await admin.query("SELECT jsonb_object_agg(table_name,n) value FROM (SELECT table_name,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) n FROM hon.%I',table_name),false,true,'')))[1]::text::bigint n FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE') t")).rows[0].value;}
async function gates(){return(await admin.query("SELECT (SELECT status FROM hon.saas_access_program) paid,(SELECT status FROM hon.saas_credit_program) credits,(SELECT status FROM hon.saas_payment_program) payment")).rows[0];}
async function direct(patch={},subjectOverride=subject){
 const x={...ctx(),source:'HUMAN_UI',action:'',delegation:'',...patch};await restricted.query('BEGIN READ ONLY');
 try{await restricted.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_external_subject',$5,true),set_config('app.hon_source',$6,true),set_config('app.hon_action_request_id',$7,true),set_config('app.hon_delegated_by_principal_id',$8,true),set_config('app.hon_request_id',$9,true)",
 [x.organizationId,x.schoolId,x.principalId,x.principalType,subject,x.source,x.action,x.delegation,x.requestId]);return(await restricted.query('SELECT hon.read_a2p_preparation_scope($1) data',[subjectOverride])).rows[0].data;}
 finally{await restricted.query('ROLLBACK');}
}
const send=(url,headers,body)=>new Promise((accept,reject)=>{const q=request(url,{method:'POST',headers},r=>{let text='';r.on('data',v=>text+=v);r.on('end',()=>accept({status:r.statusCode,data:JSON.parse(text),headers:r.headers}));});q.on('error',reject);q.end(JSON.stringify(body));});
await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.deepEqual((await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0],{owner:'hon_champions_owner',marker:'HON disposable Champions Club validation'});
 await verifyA2pPreparationSecurity(admin,runtime.username);
 await admin.query('BEGIN');
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'A2P Synthetic Organization','A2P Synthetic Organization'),($2,'Other Synthetic Organization','Other Synthetic Organization')",[ids.org,ids.foreignOrg]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic Dojo',$3),($4,$2,'Second Synthetic School',$5),($6,$7,'Foreign Synthetic School',$8)",[ids.school,ids.org,'a2p-'+ids.school,ids.second,'a2p-'+ids.second,ids.foreignSchool,ids.foreignOrg,'a2p-'+ids.foreignSchool]);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')",[ids.org]);
 await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'A2P Synthetic Owner')",[ids.user,subject,ids.user+'@example.test']);
 await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','A2P Synthetic Owner')",[ids.principal,ids.user]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'OWNER','A2P Synthetic Owner')",[ids.role,ids.org]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'communication.a2p.prepare')",[ids.role,ids.org]);
 await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 hour')",[ids.grant,ids.org,ids.school,ids.principal,ids.role]);
 await admin.query('COMMIT');
 const footprint=await counts(),posture=await gates();
 assert.deepEqual(posture,{paid:'INACTIVE',credits:'INACTIVE',payment:'DISABLED'});
 const scope=await direct();assert.equal(scope.schoolId,ids.school);assert.equal(scope.canConfirmOwnerFacts,true);
 pass('0190 exact function/hash/ACL and direct-human exact-school scope; all activation gates inactive');
 for(const patch of [{schoolId:ids.second},{organizationId:ids.foreignOrg,schoolId:ids.foreignSchool},{principalId:K()},
  {principalType:'AI_EMPLOYEE'},{source:'AI'},{source:'HQ_SUPPORT'},{action:K()},{delegation:K()}])await assert.rejects(direct(patch),e=>e.code==='42501');
 await assert.rejects(direct({},'another-subject'),e=>e.code==='42501');
 for(const table of ['users','principals','hq_operator_grants'])await assert.rejects(restricted.query('SELECT * FROM hon.'+table),e=>e.code==='42501');
 pass('cross-school/organization, forged principal/source/delegation and direct private-table access refused');
 const rows=await Promise.all(Array.from({length:6},()=>service.draft(subject,ids.org,ids.school,draft())));
 assert(rows.every(r=>r.computationDigest===rows[0].computationDigest));assert.equal(rows[0].draft.messagesSent,0);assert.equal(rows[0].draft.saved,false);
 const copy=await service.copy(subject,ids.org,ids.school,{input:draft(),expectedDigest:rows[0].computationDigest,acknowledgement:c.A2P_COPY_CONFIRMATION});
 assert.equal(copy.submitted,false);assert.equal(copy.persistence,'NONE');assert.match(copy.content,/external owner review/);
 assert.deepEqual(await counts(),footprint);pass('six concurrent deterministic drafts and explicit copy have identical lineage and no DB/idempotency/audit/outbox/credit effects');
 const website=await service.website(subject,ids.org,ids.school,review());assert(website.review.findings.every(f=>f.status==='UNAVAILABLE'));
 await deny(service.draft(subject,ids.org,ids.second,draft()),403);await deny(service.draft(subject,ids.foreignOrg,ids.foreignSchool,draft()),403);
 pass('production inspection remains unavailable and service rejects foreign scopes');
 for(const [status,from,to]of[['SUSPENDED',"clock_timestamp()-interval '1 day'",'NULL'],['ACTIVE',"clock_timestamp()+interval '1 hour'","clock_timestamp()+interval '2 hours'"],['ACTIVE',"clock_timestamp()-interval '2 hours'","clock_timestamp()-interval '1 hour'"]]){
  await admin.query(`UPDATE hon.organization_entitlements SET status=$1,effective_from=${from},effective_until=${to} WHERE organization_id=$2`,[status,ids.org]);
  await deny(service.draft(subject,ids.org,ids.school,draft()),403);await assert.rejects(direct(),e=>e.code==='42501');
 }
 await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[ids.org]);
 pass('suspended, future and expired entitlement windows independently denied by the API/database boundary');
 await admin.query("UPDATE hon.roles SET code='A2P_ASSISTANT' WHERE id=$1",[ids.role]);
 assert.equal((await direct()).canConfirmOwnerFacts,false);await deny(service.draft(subject,ids.org,ids.school,draft()),403,'A2P_OWNER_FACT_CONFIRMATION_REQUIRED');
 assert.equal((await service.draft(subject,ids.org,ids.school,{...draft(),ownerConfirmation:'NOT_CONFIRMED'})).draft.state,'NEEDS_INPUT');
 await admin.query("UPDATE hon.roles SET code='OWNER' WHERE id=$1",[ids.role]);
 pass('delegated preparation staff cannot assert owner fact confirmation or obtain copy-ready output');
 let settle;const pending=new Promise(r=>settle=r);
 let inspected;const reached=new Promise(r=>inspected=r);const waitingInspector={async inspect(){inspected();return pending;}};
 const waiting=new A2pPreparationService(db,waitingInspector).website(subject,ids.org,ids.school,review());await reached;
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[ids.grant,ids.principal]);settle({kind:'UNAVAILABLE',reason:'LIVE_INSPECTION_DISABLED'});
 await deny(waiting,403);await deny(service.copy(subject,ids.org,ids.school,{input:draft(),expectedDigest:rows[0].computationDigest,acknowledgement:c.A2P_COPY_CONFIRMATION}),403);
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]);
 pass('revocation while inspection is pending hides results and refuses repeated copy; no lock held across waits');
 process.env.HON_AUTH_MODE='OIDC';process.env.HON_SESSION_JWT_SECRET='synthetic-a2p-disposable-signed-session-secret';process.env.HON_SESSION_AUDIENCE='hon-a2p-disposable';process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const mod=await Test.createTestingModule({controllers:[A2pPreparationController],providers:[A2pPreparationService,A2pPreparationHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:db},{provide:A2P_WEBSITE_INSPECTOR,useValue:new UnavailableA2pWebsiteInspector()}]}).compile();
 app=mod.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${ids.org}/schools/${ids.school}/a2p/`;
 const headers=(expired=false)=>({'content-type':'application/json',origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':'a2p-prepare',
  cookie:`${auth.HON_SESSION_COOKIE}=${auth.issueSession({externalSubject:subject},auth.sessionConfig(),Math.floor(Date.now()/1000)-(expired?43201:0))}`});
 let receipt;
 for(const [path,body]of[['website-review',review()],['finding-details',{review:review(),findingCode:'HELP'}],['registration-draft',draft()],['draft-validation',draft()]]){
  const r=await send(base+path,headers(),body);assert.equal(r.status,200,JSON.stringify(r.data));assert.match(r.headers['cache-control'],/no-store/);assert.equal(r.data.data.scope.schoolId,ids.school);if(path==='registration-draft')receipt=r.data.data;
 }
 assert.equal((await send(base+'copy-preparation',headers(),{input:draft(),expectedDigest:receipt.computationDigest,acknowledgement:c.A2P_COPY_CONFIRMATION})).status,200);
 assert.equal((await send(base+'registration-draft',headers(true),draft())).status,401);
 assert.equal((await send(base.replace(ids.school,ids.second)+'registration-draft',headers(),draft())).status,403);
 assert.equal((await send(base+'registration-draft',{...headers(),origin:'https://evil.invalid'},draft())).status,403);
 assert.equal((await send(base+'website-review',headers(),{...review(),websiteUrl:'https://169.254.169.254/'})).status,400);
 pass('all five real signed-session HTTP endpoints use actual PostgreSQL scope; expired/cross-school/cross-origin/private URL calls refused');
 assert.deepEqual(await counts(),footprint);assert.deepEqual(await gates(),posture);await verifyA2pPreparationSecurity(admin,runtime.username);
 pass('all table counts unchanged; no consent, registration, message, audit, outbox, idempotency, payment, trial or AI credit record created');
 console.log(JSON.stringify({groups,realSignedSession:true,realPostgreSQL:true,mockedIdentity:false,mockedDatabase:false,websiteFetching:'DISABLED',providerCalls:0,persistentPreparations:0}));
}finally{if(app)await app.close();else await db.onModuleDestroy();await restricted.end();await admin.end();}
