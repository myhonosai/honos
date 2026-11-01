const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID:K}=require('node:crypto'),{request}=require('node:http');
require('reflect-metadata');
const c=require('@hon/contracts'),{Test}=require('@nestjs/testing'),{json}=require('express');
const {issueSession,sessionConfig,HON_SESSION_COOKIE}=require('@hon/auth');
const {A2pPreparationService}=require('../dist/a2p/a2p-preparation.service.js');
const {A2pPreparationController,A2pPreparationHumanGuard}=require('../dist/a2p/a2p-preparation.controller.js');
const {UnavailableA2pWebsiteInspector,A2P_WEBSITE_INSPECTOR}=require('../dist/a2p/a2p-inspector.js');
const {HonIdentityService}=require('../dist/foundation/hon-identity.service.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const {draft,review,LocalWebsiteFixtureInspector}=require('./fixtures/a2p-fixtures.cjs');
const scope={organizationId:K(),schoolId:K(),principalId:K(),schoolName:'Synthetic Dojo',canConfirmOwnerFacts:true};
function setup(inspector=new UnavailableA2pWebsiteInspector(),onRead=()=>{}){
 let allowed=true,owner=true,entitled=true,reads=0;
 const database={async resolveAuthorizedScope(subject,school,permission){assert.equal(permission,c.A2P_PERMISSION);return allowed&&subject==='owner'&&school===scope.schoolId?scope:undefined;},
  async readA2pPreparationScope(context){++reads;assert.equal(context.principalType,'HUMAN_USER');onRead(reads);return allowed&&entitled?{...scope,canConfirmOwnerFacts:owner}:null;}};
 return {database,service:new A2pPreparationService(database,inspector),revoke:()=>{allowed=false;},staff:()=>{owner=false;},expire:()=>{entitled=false;},reads:()=>reads};
}
const deny=(promise,status,code)=>assert.rejects(promise,e=>e.getStatus?.()===status&&(!code||e.getResponse().code===code));
test('A2P production website inspection is unconditionally unavailable, even with provider-shaped environment switches',async()=>{
 const before=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{++calls;throw Error('forbidden');};
 try{const s=setup(),r=await s.service.website('owner',scope.organizationId,scope.schoolId,review());
 assert(r.review.findings.every(f=>f.status==='UNAVAILABLE'&&f.evidence.length===0));assert.equal(calls,0);assert.equal(r.persistence,'NONE');assert.equal(s.reads(),2);}finally{globalThis.fetch=before;}
});
for(const kind of ['complete','missing-policies','missing-disclosures','dynamic','contradictory'])test('A2P local website snapshot '+kind+' retains exact synthetic evidence and rule outcomes',async()=>{
 const s=setup(new LocalWebsiteFixtureInspector(kind)),r=await s.service.website('owner',scope.organizationId,scope.schoolId,review());
 assert.equal(r.review.inspection,'SYNTHETIC_FIXTURE');assert.notEqual(r.review.overallStatus,'PASS');
 assert(r.review.findings.every(f=>f.evidence.every(e=>e.provenance==='SYNTHETIC_FIXTURE')));
 if(kind==='missing-policies')assert(r.review.findings.filter(f=>['PRIVACY_PUBLIC','TERMS_PUBLIC'].includes(f.code)).every(f=>f.status==='NEEDS_FIX'));
 if(kind==='missing-disclosures')assert.equal(r.review.findings.find(f=>f.code==='RATES').status,'NEEDS_FIX');
 if(kind==='dynamic')assert.equal(r.review.findings.find(f=>f.code==='CONSENT_OPTIONAL_UNCHECKED').status,'REVIEW_REQUIRED');
 if(kind==='contradictory')assert.equal(r.review.findings.find(f=>f.code==='SMS_DATA_SHARING').status,'NEEDS_FIX');
});
test('A2P unsafe redirects, thrown inspections and corrupt evidence remain unavailable without false findings',async()=>{
 for(const inspector of [new LocalWebsiteFixtureInspector('unsafe-redirect'),{async inspect(){throw Error('private provider error');}},
  {async inspect(){return{kind:'SYNTHETIC_FIXTURE',observations:[{code:'PRIVACY_PUBLIC',outcome:'PRESENT',evidence:[]}]};}}]){
  const s=setup(inspector),r=await s.service.website('owner',scope.organizationId,scope.schoolId,review());assert(r.review.findings.every(f=>f.status==='UNAVAILABLE'));}
});
test('A2P cannot accept client HTML, live inspection flags, fixture selectors or approval evidence',async()=>{
 const s=setup();for(const extra of [{html:'<form>'},{fixture:'complete'},{inspectLive:true},{approved:true},{evidence:[]},{schoolId:K()}])await deny(s.service.website('owner',scope.organizationId,scope.schoolId,{...review(),...extra}),400);
});
test('A2P cross-school and cross-organization calls fail before an inspection or copy result',async()=>{
 const inspector=new LocalWebsiteFixtureInspector(),s=setup(inspector);
 for(const [org,school]of[[K(),scope.schoolId],[scope.organizationId,K()]]){
  await deny(s.service.website('owner',org,school,review()),403);await deny(s.service.draft('owner',org,school,draft()),403);
 }assert.equal(inspector.calls,0);s.revoke();await deny(s.service.draft('owner',scope.organizationId,scope.schoolId,draft()),403);
});
test('A2P rechecks revoked permission after the inspector settles; unknown outcome never reveals old results',async()=>{
 let finish,reached;const entered=new Promise(r=>reached=r),waiting=new Promise(r=>finish=r),s=setup({inspect:()=>{reached();return waiting;}});
 const p=s.service.website('owner',scope.organizationId,scope.schoolId,review());await entered;s.revoke();finish({kind:'UNAVAILABLE',reason:'LIVE_INSPECTION_DISABLED'});await deny(p,403);
});
test('A2P explicit owner fact confirmation cannot be asserted by delegated preparation staff',async()=>{
 const s=setup();s.staff();await deny(s.service.draft('owner',scope.organizationId,scope.schoolId,draft()),403,'A2P_OWNER_FACT_CONFIRMATION_REQUIRED');
 const r=await s.service.draft('owner',scope.organizationId,scope.schoolId,{...draft(),ownerConfirmation:'NOT_CONFIRMED'});assert.equal(r.draft.state,'NEEDS_INPUT');assert.equal(r.scope.canConfirmOwnerFacts,false);
});
const unconfirmedDraft=()=>({...draft(),ownerConfirmation:'NOT_CONFIRMED'});
const prepare=(service,method)=>service[method]('owner',scope.organizationId,scope.schoolId,
 method==='finding'?{review:review(),findingCode:'HELP'}:method==='website'?review():unconfirmedDraft());
for(const method of ['website','finding','draft','validate'])test('A2P '+method+' returns final OWNER capability and final-scope digest after downgrade',async()=>{
 const changing=setup(undefined,n=>{if(n===2)changing.staff();});
 const result=await prepare(changing.service,method);
 assert.equal(changing.reads(),2);assert.equal(result.scope.canConfirmOwnerFacts,false);
 const stationary=setup();stationary.staff();
 assert.deepEqual(result,await prepare(stationary.service,method));
 if('computationDigest' in result){
  const before=await prepare(setup().service,method);
  assert.notEqual(result.computationDigest,before.computationDigest);
 }
 assert.equal(result.persistence,'NONE');assert.equal(result.readOnly,true);
});
for(const method of ['draft','validate','copy'])test('A2P '+method+' refuses owner-confirmed output when OWNER is lost at final authorization',async()=>{
 const accepted=await setup().service.draft('owner',scope.organizationId,scope.schoolId,draft());
 const changing=setup(undefined,n=>{if(n===2)changing.staff();});
 const input=method==='copy'?{input:draft(),expectedDigest:accepted.computationDigest,acknowledgement:c.A2P_COPY_CONFIRMATION}:draft();
 await deny(changing.service[method]('owner',scope.organizationId,scope.schoolId,input),403,'A2P_OWNER_FACT_CONFIRMATION_REQUIRED');
 assert.equal(changing.reads(),2);
});
test('A2P entitlement expiration during pending inspection hides the result even while IAM still resolves',async()=>{
 let reached,finish;const entered=new Promise(r=>reached=r),pending=new Promise(r=>finish=r);
 const s=setup({async inspect(){reached();return pending;}});
 const request=s.service.website('owner',scope.organizationId,scope.schoolId,review());
 await entered;s.expire();finish({kind:'UNAVAILABLE',reason:'LIVE_INSPECTION_DISABLED'});
 await deny(request,403,'A2P_PREPARATION_FORBIDDEN');assert.equal(s.reads(),2);
 assert(await s.database.resolveAuthorizedScope('owner',scope.schoolId,c.A2P_PERMISSION));
});
test('A2P deterministic concurrent draft/copy calls have stable scope-bound digests and zero saved or sent state',async()=>{
 const s=setup(),args=['owner',scope.organizationId,scope.schoolId,draft()];
 const [a,b]=await Promise.all([s.service.draft(...args),s.service.draft(...args)]);assert.deepEqual(a,b);assert.equal(a.draft.saved,false);assert.equal(a.draft.messagesSent,0);
 const copied=await s.service.copy('owner',scope.organizationId,scope.schoolId,{input:draft(),expectedDigest:a.computationDigest,acknowledgement:c.A2P_COPY_CONFIRMATION});
 assert(copied.content.includes('not configured'));assert(copied.content.includes('external owner review'));assert.equal(copied.submitted,false);
 const changed=draft();changed.facts.messageFrequency='Two messages monthly';await deny(s.service.copy('owner',scope.organizationId,scope.schoolId,{input:changed,expectedDigest:a.computationDigest,acknowledgement:c.A2P_COPY_CONFIRMATION}),409,'A2P_DRAFT_CHANGED');
});
test('A2P incomplete facts and absent copy acknowledgement never become copy-ready claims',async()=>{
 const s=setup(),v=draft();v.facts.businessName=null;const r=await s.service.validate('owner',scope.organizationId,scope.schoolId,v);
 assert.equal(r.validation.readyForCopyPreparation,false);assert.equal(r.draft.answers,null);
 await deny(s.service.copy('owner',scope.organizationId,scope.schoolId,{input:v,expectedDigest:r.computationDigest,acknowledgement:c.A2P_COPY_CONFIRMATION}),409,'A2P_DRAFT_INCOMPLETE');
 await deny(s.service.copy('owner',scope.organizationId,scope.schoolId,{input:draft(),expectedDigest:r.computationDigest,acknowledgement:'APPROVE'}),400);
});
test('A2P finding details recompute authorized scope and return only the requested code',async()=>{
 const s=setup(),r=await s.service.finding('owner',scope.organizationId,scope.schoolId,{review:review(),findingCode:'PRIVACY_PUBLIC'});
 assert.equal(r.finding.code,'PRIVACY_PUBLIC');assert.equal(r.finding.status,'UNAVAILABLE');assert.equal(r.readOnly,true);
});
function send(url,{headers={},body}={}){return new Promise((resolve,reject)=>{const q=request(url,{method:'POST',headers},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>resolve({status:r.statusCode,body,headers:r.headers}));});q.on('error',reject);q.end(JSON.stringify(body));});}
async function app(){
 process.env.HON_AUTH_MODE='OIDC';process.env.HON_SESSION_JWT_SECRET='a2p-synthetic-signed-session-secret-long-enough';process.env.HON_SESSION_AUDIENCE='hon-a2p-fixtures';process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const s=setup(),mod=await Test.createTestingModule({controllers:[A2pPreparationController],providers:[A2pPreparationService,A2pPreparationHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:s.database},{provide:A2P_WEBSITE_INSPECTOR,useValue:new UnavailableA2pWebsiteInspector()}]}).compile();
 const app=mod.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/a2p/`;
 const headers=(expired=false)=>({'content-type':'application/json',origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':'a2p-prepare',
  cookie:`${HON_SESSION_COOKIE}=${issueSession({externalSubject:'owner'},sessionConfig(),Math.floor(Date.now()/1000)-(expired?43201:0))}`});
 return{...s,app,base,headers};
}
test('A2P HTTP all five closed routes use signed sessions and honest read-only responses',async()=>{const f=await app();try{
 let saved;for(const [path,body]of[['website-review',review()],['finding-details',{review:review(),findingCode:'HELP'}],['registration-draft',draft()],['draft-validation',draft()]]){
  const r=await send(f.base+path,{headers:f.headers(),body});assert.equal(r.status,200,r.body);assert.match(r.headers['cache-control'],/no-store/);const d=JSON.parse(r.body).data;assert.equal(d.scope.schoolId,scope.schoolId);assert.equal(d.persistence,'NONE');if(path==='registration-draft')saved=d;}
 const r=await send(f.base+'copy-preparation',{headers:f.headers(),body:{input:draft(),expectedDigest:saved.computationDigest,acknowledgement:c.A2P_COPY_CONFIRMATION}});assert.equal(r.status,200);assert.equal(JSON.parse(r.body).data.submitted,false);
 }finally{await f.app.close();}});
test('A2P HTTP expired sessions, cross-school and revoked permission are refused',async()=>{const f=await app();try{
 assert.equal((await send(f.base+'registration-draft',{headers:f.headers(true),body:draft()})).status,401);
 assert.equal((await send(f.base.replace(scope.schoolId,K())+'registration-draft',{headers:f.headers(),body:draft()})).status,403);
 f.revoke();assert.equal((await send(f.base+'registration-draft',{headers:f.headers(),body:draft()})).status,403);
 }finally{await f.app.close();}});
test('A2P HTTP cross-origin, forged authority, private URL and unreviewed payloads cannot reach generation',async()=>{const f=await app();try{
 for(const patch of [{origin:'https://evil.invalid'},{'x-hon-school-id':K()},{authorization:'Bearer not-a-real-provider-key'},{'sec-fetch-site':'cross-site'}])assert.equal((await send(f.base+'registration-draft',{headers:{...f.headers(),...patch},body:draft()})).status,403);
 assert.equal((await send(f.base+'website-review',{headers:f.headers(),body:{...review(),websiteUrl:'https://127.0.0.1/'}})).status,400);
 assert.equal((await send(f.base+'registration-draft',{headers:f.headers(),body:{...draft(),approved:true}})).status,400);
 }finally{await f.app.close();}});
