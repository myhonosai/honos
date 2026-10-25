const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID:K}=require('node:crypto'),{request}=require('node:http');
require('reflect-metadata');
const c=require('@hon/contracts');
const {Test}=require('@nestjs/testing'),{json}=require('express'),{UnauthorizedException}=require('@nestjs/common');
const {subscriptionScheduleRequirements,verifyProviderScheduleParity,UnconfiguredSubscriptionScheduleProvider}=require('../dist/payments/subscription-schedule-provider.js');
const {DeterministicScheduleProvider}=require('./fixtures/subscription-schedule-provider.cjs');
const {SaasSubscriptionGenerationSchoolController,SaasSubscriptionGenerationHqController}=require('../dist/saas-pricing/saas-subscription-generation.controller.js');
const {SaasSubscriptionGenerationService}=require('../dist/saas-pricing/saas-subscription-generation.service.js');
const {SaasBillingService}=require('../dist/saas-billing/saas-billing.service.js');
const {SaasCommandGuard,SaasReadGuard}=require('../dist/saas-billing/saas-billing.guards.js');
const {HonIdentityGuard}=require('../dist/foundation/hon-identity.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const fixture=()=>import('../../../packages/database/scripts/subscription-generation-fixture.mjs');
const human=()=>({'content-type':'application/json',origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':c.SAAS_COMMANDS.recordSubscriptionGeneration,'idempotency-key':K()});
const send=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const q=request(url,{method,headers},r=>{let text='';r.on('data',v=>text+=v);r.on('end',()=>resolve({status:r.statusCode,body:text,headers:r.headers}));});q.on('error',reject);q.end(body);});
async function appWith(callSaasBilling){
 const mod=await Test.createTestingModule({controllers:[SaasSubscriptionGenerationSchoolController,SaasSubscriptionGenerationHqController],providers:[SaasSubscriptionGenerationService,SaasBillingService,SaasCommandGuard,SaasReadGuard,{provide:RuntimeDatabaseService,useValue:{callSaasBilling}}]})
  .overrideGuard(HonIdentityGuard).useValue({canActivate(ctx){const r=ctx.switchToHttp().getRequest();if(r.headers['x-test-session']==='expired')throw new UnauthorizedException();r.honIdentity={externalSubject:'verified-purchaser'};return true;}}).compile();
 const app=mod.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');return {app,base:`http://127.0.0.1:${app.getHttpServer().address().port}/v1`};
}
test('B1: closed generation request rejects all financial/provider/tenant/activation claims',()=>{
 const b={acceptanceId:K(),acceptanceDigest:'a'.repeat(64),confirmation:c.SAAS_GENERATION_CONFIRMATION};
 assert(Object.isFrozen(c.validateSaasSubscriptionGenerationInput(b)));
 for(const patch of [{amountMinor:1},{initialPriceMinor:1},{renewalPriceMinor:1},{discountPercent:20},{founderAllocationId:K()},
  {organizationId:K()},{schoolId:K()},{provider:'STRIPE'},{providerMode:'LIVE'},{phase:2},{paidPeriods:12},{activate:true},
  {acceptanceDigest:'bad'},{confirmation:'START_BILLING'},{acceptanceId:'bad'}])assert.throws(()=>c.validateSaasSubscriptionGenerationInput({...b,...patch}));
});
test('B1: requirements resolve exact accepted lineage, immutable terms and future price; not HQ current configuration',async()=>{
 const {sampleGeneration}=await fixture(),g=sampleGeneration(c.proposedHonOsLaunchPriceSchedule('REGULAR_ANNUAL'));
 assert(c.validateSaasSubscriptionGeneration(g));const r=subscriptionScheduleRequirements(g);
 assert.equal(r.acceptanceId,g.acceptance.acceptanceId);assert.equal(r.acceptanceDigest,g.acceptance.acceptanceDigest);
 assert.equal(r.offerId,g.acceptance.schedule.offerId);assert.equal(r.acceptedOfferDigest,g.acceptance.schedule.acceptedOfferDigest);
 assert.equal(r.disclosureText,g.acceptance.disclosureText);assert.equal(r.initialAmountMinor,209700);assert.equal(r.renewalAmountMinor,209700);
 assert.equal(r.periodCountingRule,'DISTINCT_VERIFIED_PAID_PERIODS');assert(Object.isFrozen(r)&&Object.isFrozen(r.refundTerms));
});
test('B1: receipt refuses foreign lineage, simulated binding, founder acceptance and false billing/access',async()=>{
 const {sampleGeneration}=await fixture(),g=sampleGeneration(c.proposedHonOsLaunchPriceSchedule('REGULAR_MONTHLY'));
 for(const patch of [{organizationId:K()},{schoolId:K()},{generationDigest:'bad'},{checkoutAvailable:true},{billingEnabled:true},{accessGranted:true},
  {paidPeriodEvidence:'VERIFIED'},{provider:{...g.provider,identity:'STRIPE'}},{provider:{...g.provider,bindingStatus:'VERIFIED'}},
  {provider:{...g.provider,subscriptionReference:'fake_subscription'}},{provider:{...g.provider,generationReference:K()}}])assert.throws(()=>c.validateSaasSubscriptionGeneration({...g,...patch}));
 assert.throws(()=>c.validateSaasSubscriptionGeneration(sampleGeneration(c.proposedHonOsLaunchPriceSchedule('FOUNDER_MONTHLY'))));
});
for(const [kind,initial,periods,renewal]of [['REGULAR_MONTHLY',24900,0,24900],['REGULAR_ANNUAL',209700,0,209700],['FOUNDER_MONTHLY',19920,12,24900],['FOUNDER_ANNUAL',149400,1,209700]]){
 test('B1 deterministic adapter: '+kind+' exact parity, never operational founder acceptance or payable checkout',async()=>{
  const {sampleGeneration}=await fixture();const regular=subscriptionScheduleRequirements(sampleGeneration(c.proposedHonOsLaunchPriceSchedule(kind.endsWith('ANNUAL')?'REGULAR_ANNUAL':'REGULAR_MONTHLY')));
  // Founder adapter requirements are synthetic contract examples only. A2/B1 founder acceptance remains blocked.
  const terms=c.proposedHonOsLaunchPriceSchedule(kind),expected={...regular,initialAmountMinor:terms.initialPriceMinor,
   renewalAmountMinor:terms.renewalPriceMinor,introductoryPaidPeriods:terms.introductoryPaidPeriods};
  assert.deepEqual([expected.initialAmountMinor,expected.introductoryPaidPeriods,expected.renewalAmountMinor],[initial,periods,renewal]);
  const fake=new DeterministicScheduleProvider(),o=await fake.inspectSchedule(expected),p=verifyProviderScheduleParity(expected,o);
  assert.equal(p.status,'PARITY_VERIFIED_TEST_ONLY');assert.equal(p.checkoutAvailable,false);assert.equal(p.billingEnabled,false);
  assert.deepEqual(verifyProviderScheduleParity(expected,await fake.inspectSchedule(expected)),p);assert.equal(fake.calls,2);
  for(const patch of [{initialAmountMinor:initial+1},{renewalAmountMinor:renewal+1},{billingInterval:'WEEKLY'},
   {introductoryPaidPeriods:periods+1},{periodCountingRule:'ELAPSED_MONTHS'},{acceptanceDigest:'0'.repeat(64)},
   {scheduleDigest:'0'.repeat(64)},{acceptedOfferDigest:'0'.repeat(64)},{offerId:K()},{offerSetVersion:999},
   {organizationId:K()},{schoolId:K()},{generationId:K()},{disclosureText:'different undisclosed price'},
   {refundTerms:{...expected.refundTerms,windowDays:0}},{cancellationTerms:{...expected.cancellationTerms,timing:'IMMEDIATE'}}]){
    assert.equal(verifyProviderScheduleParity(expected,{...o,requirements:{...expected,...patch}}).status,'REVIEW_REQUIRED');
  }
 });
}
test('B1: calendar schedules, collection, unknown/unconfigured providers and live evidence fail closed',async()=>{
 const {sampleGeneration}=await fixture(),r={...subscriptionScheduleRequirements(sampleGeneration(c.proposedHonOsLaunchPriceSchedule('REGULAR_MONTHLY'))),initialAmountMinor:19920,introductoryPaidPeriods:12};
 const o=await new DeterministicScheduleProvider().inspectSchedule(r);
 for(const patch of [{phaseControl:'CALENDAR_ONLY'},{automaticCalendarTransition:true},{automaticCollectionEnabled:true},
  {outcome:'UNKNOWN'},{outcome:'UNAVAILABLE'},{mode:'LIVE'},{identity:'STRIPE'},{evidenceKind:'PROVIDER_VERIFIED'},{extra:true},
  {accountReference:''},{subscriptionReference:'real_subscription'}])assert.equal(verifyProviderScheduleParity(r,{...o,...patch}).status,'REVIEW_REQUIRED');
 await assert.rejects(new UnconfiguredSubscriptionScheduleProvider().inspectSchedule(r),/SAAS_SCHEDULE_PROVIDER_UNAVAILABLE/);
});
test('B1 HTTP: all three fixed routes preserve verified subject/exact school and no-store receipts',async()=>{
 const {sampleGeneration,generationInput}=await fixture(),g=sampleGeneration(c.proposedHonOsLaunchPriceSchedule('REGULAR_MONTHLY'));
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';const calls=[];
 const {app,base}=await appWith(async(op,p)=>{calls.push([op,p]);return op==='recordSubscriptionGeneration'?{generation:g,replayed:false}:g;});
 try{
  const b=generationInput(g.acceptance),key=K(),path=base+'/schools/'+g.schoolId+'/hon-os-subscription-generations';
  const r=await send(path,{method:'POST',headers:{...human(),'idempotency-key':key},body:JSON.stringify(b)});assert.equal(r.status,200,r.body);
  assert.deepEqual(calls[0][1].slice(0,-2),['verified-purchaser',g.schoolId,JSON.stringify(b),key]);
  for(const url of [path+'/'+g.generationId,base+'/hq/saas/subscription-generations/'+g.generationId]){const read=await send(url);assert.equal(read.status,200,read.body);assert.equal(read.headers['cache-control'],'private, no-store');}
  assert.deepEqual(calls.map(x=>x[0]),['recordSubscriptionGeneration','readSubscriptionGeneration','readSubscriptionGenerationHq']);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('B1 HTTP: expired sessions, cross-origin requests, forged authority and closed payloads refuse before database',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';let calls=0;
 const {app,base}=await appWith(async()=>{calls++;throw Error('must not call');});
 const b={acceptanceId:K(),acceptanceDigest:'a'.repeat(64),confirmation:c.SAAS_GENERATION_CONFIRMATION},path=base+'/schools/'+K()+'/hon-os-subscription-generations';
 try{
  for(const [patch,body,status]of [[{origin:'https://evil.test'},b,403],[{'x-hon-human-command':'wrong'},b,403],[{}, {...b,amountMinor:1},400],
   [{'idempotency-key':'bad'},b,400],[{'x-test-session':'expired'},b,401],[{'x-hon-organization-id':K()},b,403]]){
   const r=await send(path,{method:'POST',headers:{...human(),...patch},body:JSON.stringify(body)});assert.equal(r.status,status,r.body);
  }
  assert.equal((await send(path+'/'+K()+'?actor=owner')).status,400);assert.equal(calls,0);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('B1 HTTP: stale evidence, permission denial and unknown outcomes never become a successful generation',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';let error;
 const {app,base}=await appWith(async()=>{throw Object.assign(Error(error.message),{code:error.code});});
 const body={acceptanceId:K(),acceptanceDigest:'a'.repeat(64),confirmation:c.SAAS_GENERATION_CONFIRMATION};
 try{for(const [code,message,status]of [['40001','SAAS_GENERATION_ACCEPTANCE_STALE',409],['40001','SAAS_GENERATION_EXISTS',409],['23514','SAAS_GENERATION_EVIDENCE_REQUIRED',422],['42501','private',403],['55P03','private',409],['08006','private',503]]){
  error={code,message};const r=await send(base+'/schools/'+K()+'/hon-os-subscription-generations',{method:'POST',headers:human(),body:JSON.stringify(body)});assert.equal(r.status,status,r.body);assert(!r.body.includes('private'));
 }}finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
