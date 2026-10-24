const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID:K}=require('node:crypto');
const {request}=require('node:http');
require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{json}=require('express'),{UnauthorizedException}=require('@nestjs/common');
const c=require('@hon/contracts');
const {SaasPriceScheduleHqController,SaasPriceAcceptanceSchoolController}=require('../dist/saas-pricing/saas-price-acceptance.controller.js');
const {SaasPriceAcceptanceService}=require('../dist/saas-pricing/saas-price-acceptance.service.js');
const {SaasBillingService}=require('../dist/saas-billing/saas-billing.service.js');
const {SaasCommandGuard,SaasReadGuard}=require('../dist/saas-billing/saas-billing.guards.js');
const {HonIdentityGuard}=require('../dist/foundation/hon-identity.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const f=()=>import('../../../packages/database/scripts/price-acceptance-fixture.mjs');
const send=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=request(url,{method,headers},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),headers:res.headers}));});req.on('error',reject);req.end(body);});
const human=command=>({'content-type':'application/json',origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':command,'idempotency-key':K()});
async function appWith(callSaasBilling){const module=await Test.createTestingModule({controllers:[SaasPriceScheduleHqController,SaasPriceAcceptanceSchoolController],providers:[SaasPriceAcceptanceService,SaasBillingService,SaasCommandGuard,SaasReadGuard,{provide:RuntimeDatabaseService,useValue:{callSaasBilling}}]})
 .overrideGuard(HonIdentityGuard).useValue({canActivate(ctx){const req=ctx.switchToHttp().getRequest();if(req.headers['x-test-session']==='expired')throw new UnauthorizedException();req.honIdentity={externalSubject:'verified-school-subject'};return true;}}).compile();
 const app=module.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');return {app,base:`http://127.0.0.1:${app.getHttpServer().address().port}/v1`};}
test('A2: all four schedules preserve A1 exact amounts, paid period rules and annual reference',async()=>{
 const {sampleSchedule}=await f();
 for(const [kind,initial,periods,renewal] of [['FOUNDER_MONTHLY',19920,12,24900],['FOUNDER_ANNUAL',149400,1,209700],['REGULAR_MONTHLY',24900,0,24900],['REGULAR_ANNUAL',209700,0,209700]]){
  const s=c.validateSaasPriceSchedule(sampleSchedule(c.proposedHonOsLaunchPriceSchedule(kind)));
  assert.deepEqual([s.terms.initialPriceMinor,s.terms.introductoryPaidPeriods,s.terms.renewalPriceMinor],[initial,periods,renewal]);
  assert.equal(s.terms.monthlyListReferenceMinor*12,298800);assert.equal(s.billingEnabled,false);
 }
});
test('A2: purchaser cannot set amounts, eligibility, intervals, discounts, founder allocations or activation',()=>{
 const body={scheduleId:K(),scheduleDigest:'a'.repeat(64),acceptanceDigest:'b'.repeat(64),confirmation:c.SAAS_PRICE_SCHEDULE_CONFIRMATION};
 assert(Object.isFrozen(c.validateSaasPriceAcceptanceInput(body)));
 for(const p of [{initialPriceMinor:100},{renewalPriceMinor:100},{introductoryPaidPeriods:999},{eligible:true},{founderAllocationId:K()},{discountPercent:20},{discounts:[]},{activate:true},{charge:true},{grantCredits:1},{offerKind:'LIFETIME'},{organizationId:K()},{actorPrincipalId:K()},{scheduleDigest:'bad'},{confirmation:'ACCEPT'}])assert.throws(()=>c.validateSaasPriceAcceptanceInput({...body,...p}));
});
test('A2: HQ record input is closed and supplies no purchaser price calculation',async()=>{
 const {scheduleInput}=await f(),body=scheduleInput({offerId:K()},{offerId:K()});assert(c.validateSaasPriceScheduleRecordInput(body));
 for(const p of [{expectedVersion:-1},{expectedOfferSetRevision:0},{priceMinor:209160},{discountPercent:30},{renewalPriceMinor:24900},{confirmation:'PUBLISH'},{disclosureVersion:'CUSTOM'},{reason:'short'},{offerId:'bad'}])assert.throws(()=>c.validateSaasPriceScheduleRecordInput({...body,...p}));
});
test('A2: response validators reject money drift and false payment, billing, access and founder claims',async()=>{
 const {sampleSchedule}=await f();const s=sampleSchedule(c.proposedHonOsLaunchPriceSchedule('REGULAR_MONTHLY'));
 for(const p of [{billingEnabled:true},{providerBinding:'READY'},{terms:{...s.terms,discountStacking:'ALLOWED'}},{terms:{...s.terms,initialPriceMinor:1.5}},{terms:{...s.terms,offerKind:'LIFETIME'}},{acceptedOffer:{...s.acceptedOffer,priceMinor:1}},{refundTerms:{...s.refundTerms,windowDays:1000}}])assert.throws(()=>c.validateSaasPriceSchedule({...s,...p}));
 const preview={organizationId:K(),schoolId:K(),schedule:s,acceptanceDigest:'d'.repeat(64),canAcknowledge:true,blockers:[],purchaseAvailable:false,paymentAuthorized:false,accessGranted:false,asOf:s.recordedAt};assert(c.validateSaasPriceAcceptancePreview(preview));
 for(const p of [{purchaseAvailable:true},{paymentAuthorized:true},{accessGranted:true},{blockers:['UNKNOWN']},{canAcknowledge:false}])assert.throws(()=>c.validateSaasPriceAcceptancePreview({...preview,...p}));
});
test('A2 HTTP: fixed routes, verified subject, exact school and immutable commands',async()=>{
 const {sampleSchedule,scheduleInput}=await f(),old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const s=sampleSchedule(c.proposedHonOsLaunchPriceSchedule('REGULAR_MONTHLY')),school=K(),org=K(),calls=[];
 const preview={organizationId:org,schoolId:school,schedule:s,acceptanceDigest:'d'.repeat(64),canAcknowledge:true,blockers:[],purchaseAvailable:false,paymentAuthorized:false,accessGranted:false,asOf:s.recordedAt};
 const body={scheduleId:s.scheduleId,scheduleDigest:s.scheduleDigest,acceptanceDigest:preview.acceptanceDigest,confirmation:c.SAAS_PRICE_SCHEDULE_CONFIRMATION};
 const a={acceptanceId:K(),organizationId:org,schoolId:school,schedule:s,scheduleDigest:s.scheduleDigest,acceptanceDigest:preview.acceptanceDigest,disclosureVersion:s.disclosureVersion,disclosureText:s.disclosureText,confirmation:body.confirmation,founderAllocationId:null,actorPrincipalId:K(),idempotencyKey:K(),acceptedAt:s.recordedAt,paymentStatus:'NOT_AUTHORIZED',subscriptionStatus:'NOT_CREATED',accessGranted:false,paidPeriodEvidence:'NOT_IMPLEMENTED_COMMERCIAL_B'};
 const {app,base}=await appWith(async(op,p)=>{calls.push([op,p]);return {readPriceSchedule:s,previewPriceAcceptance:preview,readPriceAcceptance:a,recordPriceSchedule:{schedule:s,replayed:false},acceptPriceSchedule:{acceptance:a,replayed:false}}[op];});
 try{
  for(const [path,op,header,b]of [['hq/saas/price-schedules','recordPriceSchedule',c.SAAS_COMMANDS.recordPriceSchedule,scheduleInput(s,s)],['schools/'+school+'/hon-os-price-acceptances','acceptPriceSchedule',c.SAAS_COMMANDS.acceptPriceSchedule,body]]){
   const key=K(),r=await send(base+'/'+path,{method:'POST',headers:{...human(header),'idempotency-key':key},body:JSON.stringify(b)});assert.equal(r.status,200,r.body);const [actual,p]=calls.at(-1);assert.equal(actual,op);assert.equal(p[0],'verified-school-subject');assert.deepEqual(p.slice(1,-2),op==='recordPriceSchedule'?[JSON.stringify(b),key]:[school,JSON.stringify(b),key]);
  }
  for(const path of ['hq/saas/price-schedules/'+s.scheduleId,'schools/'+school+'/hon-os-price-acceptances/preview/'+s.scheduleId,'schools/'+school+'/hon-os-price-acceptances/'+a.acceptanceId]){const r=await send(base+'/'+path);assert.equal(r.status,200,r.body);assert.equal(r.headers['cache-control'],'private, no-store');}
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('A2 HTTP: same-origin, closed inputs, invalid identity and expired session never reach database',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';let n=0;const {app,base}=await appWith(async()=>{n++;throw Error('must not call');});
 const school=K(),path=base+'/schools/'+school+'/hon-os-price-acceptances',body={scheduleId:K(),scheduleDigest:'a'.repeat(64),acceptanceDigest:'b'.repeat(64),confirmation:c.SAAS_PRICE_SCHEDULE_CONFIRMATION};
 try{for(const [h,b]of [[{...human(c.SAAS_COMMANDS.acceptPriceSchedule),origin:'https://evil.example'},body],[human(c.SAAS_COMMANDS.recordPriceSchedule),body],[human(c.SAAS_COMMANDS.acceptPriceSchedule),{...body,priceMinor:1}],[{...human(c.SAAS_COMMANDS.acceptPriceSchedule),'idempotency-key':'bad'},body],[{...human(c.SAAS_COMMANDS.acceptPriceSchedule),'x-hon-organization-id':K()},body]])assert([400,403].includes((await send(path,{method:'POST',headers:h,body:JSON.stringify(b)})).status));
  assert.equal((await send(path,{method:'POST',headers:{...human(c.SAAS_COMMANDS.acceptPriceSchedule),'x-test-session':'expired'},body:JSON.stringify(body)})).status,401);
  assert.equal((await send(path+'/preview/'+K()+'?organizationId='+K())).status,400);assert.equal((await send(base+'/schools/not-a-uuid/hon-os-price-acceptances/preview/'+K())).status,400);assert.equal(n,0);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('A2 HTTP: database refusals and unknown failures never become successful acceptance',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';let err={code:'40001',message:'SAAS_PRICE_PREVIEW_STALE'};
 const {app,base}=await appWith(async()=>{throw Object.assign(new Error(err.message),{code:err.code});});const body={scheduleId:K(),scheduleDigest:'a'.repeat(64),acceptanceDigest:'b'.repeat(64),confirmation:c.SAAS_PRICE_SCHEDULE_CONFIRMATION};
 try{for(const [code,message,status]of [['40001','SAAS_PRICE_PREVIEW_STALE',409],['23514','SAAS_PRICE_ACCEPTANCE_BLOCKED',422],['42501','SAAS_FORBIDDEN',403],['55P03','busy',409],['08006','private database details',503]]){err={code,message};const r=await send(base+'/schools/'+K()+'/hon-os-price-acceptances',{method:'POST',headers:human(c.SAAS_COMMANDS.acceptPriceSchedule),body:JSON.stringify(body)});assert.equal(r.status,status,r.body);assert(!r.body.includes('private database details'));}
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
