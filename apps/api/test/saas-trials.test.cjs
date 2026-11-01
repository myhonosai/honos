const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID:U}=require('node:crypto');
const {request}=require('node:http');
require('reflect-metadata');
const {Test}=require('@nestjs/testing');
const {json}=require('express');
const {UnauthorizedException}=require('@nestjs/common');
const contracts=require('@hon/contracts');
const {SaasTrialsHqController}=require('../dist/saas-trials/saas-trials.controller.js');
const {SaasTrialsService}=require('../dist/saas-trials/saas-trials.service.js');
const {SaasBillingService}=require('../dist/saas-billing/saas-billing.service.js');
const {SaasCommandGuard,SaasReadGuard}=require('../dist/saas-billing/saas-billing.guards.js');
const {HonIdentityGuard}=require('../dist/foundation/hon-identity.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const fixtures=()=>import('../../../packages/database/scripts/trial-governance-fixture.mjs');
const T='2026-10-24T00:00:00.000Z',T2='2026-12-24T00:00:00.000Z',reason='Synthetic governance test only';
const empty=()=>({scope:'CUSTOMER_TRIAL_GOVERNANCE_ONLY',program:{status:'INACTIVE',signupEnabled:false,enrollmentEnabled:false,promotionalIssuanceEnabled:false},policyVersions:[],policyDecisions:[],campaignVersions:[],publications:[],limit:100,hasMore:{policyVersions:false,policyDecisions:false,campaignVersions:false,publications:false},existingPrograms:{paidAccess:'INACTIVE',aiCredits:'INACTIVE',payments:'DISABLED'},asOf:T});
const send=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=request(url,{method,headers},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body);});
async function appWith(callSaasBilling){const module=await Test.createTestingModule({controllers:[SaasTrialsHqController],providers:[SaasTrialsService,SaasBillingService,SaasCommandGuard,SaasReadGuard,{provide:RuntimeDatabaseService,useValue:{callSaasBilling}}]})
 .overrideGuard(HonIdentityGuard).useValue({canActivate(ctx){const req=ctx.switchToHttp().getRequest();if(req.headers['x-test-session']==='expired')throw new UnauthorizedException();req.honIdentity={externalSubject:'verified-hq-subject'};return true;}}).compile();
 const app=module.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');return {app,base:`http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/saas/trials`};}
const human=command=>({'content-type':'application/json',origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':command,'idempotency-key':U()});
test('D11-A contracts: no proposed duration is automatically approved; policy and campaign inputs are closed',async()=>{
 const {trialTerms,trialDefinition}=await fixtures();
 for(const day of [7,14,30,60,90])assert.equal(contracts.validateTrialCampaignDraftInput({campaignId:null,expectedVersion:0,definition:trialDefinition({durationDays:day}),reason}).definition.durationDays,day);
 assert.equal(contracts.validateTrialPolicyProposalInput({expectedVersion:0,terms:trialTerms(),reason}).terms.promotionalLimits,null);
 for(const patch of [{allowedDurationsDays:[]},{allowedDurationsDays:[7,7]},{allowedDurationsDays:[8]},{allowedCapabilityProfiles:['ESSENTIAL']},{allowedEligibilityCodes:['EVERYONE']},{allowedLinkModes:['UNAUTHENTICATED']},{maxEnrollmentCapacity:0},{maxEnrollmentWindowDays:0},{maxTotalEnrollmentCapacity:1},{maxPublishedCampaigns:0},{approved:true}])
  assert.throws(()=>contracts.validateTrialPolicyProposalInput({expectedVersion:0,terms:trialTerms(patch),reason}));
 for(const patch of [{durationDays:8},{capabilityProfile:'ESSENTIAL'},{maximumEnrollments:0},{enrollmentClosesAt:T},{termsReference:' bad '},{ownerId:U()}])assert.throws(()=>contracts.validateTrialCampaignDraftInput({campaignId:null,expectedVersion:0,definition:trialDefinition(patch),reason}));
 assert.throws(()=>contracts.validateTrialCampaignDraftInput({campaignId:null,expectedVersion:1,definition:trialDefinition(),reason}));
});
test('D11-A contracts: explicit approval and publication confirmation cannot carry activation or grant fields',async()=>{
 const {trialApproval}=await fixtures();const body=trialApproval(U(),0);
 assert.equal(contracts.validateTrialPolicyDecisionInput(body).decision,'APPROVED');
 for(const p of [{confirmation:'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY'},{confirmation:undefined},{validUntil:body.validFrom},{expectedRevision:-1},{activate:true}])assert.throws(()=>contracts.validateTrialPolicyDecisionInput({...body,...p}));
 const publication={versionId:U(),expectedRevision:0,previewDigest:'a'.repeat(64),confirmation:contracts.TRIAL_PUBLICATION_CONFIRMATION,reason};assert.equal(contracts.validateTrialCampaignPublishInput(publication).expectedRevision,0);
 for(const p of [{previewDigest:'x'},{confirmation:'PUBLISH'},{schoolId:U()},{grantCredits:1}])assert.throws(()=>contracts.validateTrialCampaignPublishInput({...publication,...p}));
 assert.equal(contracts.validateTrialCampaignWithdrawInput({expectedRevision:1,reason}).expectedRevision,1);
 assert.throws(()=>contracts.validateTrialPolicyDecisionInput({decision:'WITHDRAWN',expectedRevision:1,reason,policyId:U()}));
});
test('D11-A contracts: promotional metadata is explicit, USD-only, bounded and never an issuance instruction',async()=>{
 const {trialTerms,trialDefinition,trialPromoLimits,trialPromoBudget}=await fixtures();
 assert(contracts.validateTrialPolicyProposalInput({expectedVersion:0,terms:trialTerms({promotionalLimits:trialPromoLimits()}),reason}));
 assert(contracts.validateTrialCampaignDraftInput({campaignId:null,expectedVersion:0,definition:trialDefinition({promotionalBudget:trialPromoBudget()}),reason}));
 for(const patch of [{currency:'KRW'},{creditExpiryDays:8},{perRequestCreditCap:21},{dailyCreditCap:101},{creditsPerEnrollment:0},{maximumCampaignCostMinor:0},{issueNow:true}])assert.throws(()=>contracts.validateTrialCampaignDraftInput({campaignId:null,expectedVersion:0,definition:trialDefinition({promotionalBudget:trialPromoBudget(patch)}),reason}));
 assert.throws(()=>contracts.validateTrialPolicyProposalInput({expectedVersion:0,terms:trialTerms({promotionalLimits:trialPromoLimits({maxTotalCampaignCostMinor:1})}),reason}));
});
test('D11-A response contracts fail closed on activation, malformed history and fabricated counters',()=>{
 assert.equal(contracts.validateTrialGovernanceView(empty()).program.enrollmentEnabled,false);
 for(const p of [{scope:'ACCESS_EXCEPTIONS_ONLY'},{program:{...empty().program,status:'ACTIVE'}},{program:{...empty().program,promotionalIssuanceEnabled:true}},{trialSchools:100}])assert.throws(()=>contracts.validateTrialGovernanceView({...empty(),...p}));
 const preview={campaignId:U(),versionId:U(),version:1,expectedRevision:0,policyDecisionId:null,policyId:null,digest:'a'.repeat(64),ready:false,blockers:['TRIAL_POLICY_REQUIRED'],activationAvailable:false,promotionalCreditsAvailable:false,plannedExposure:{enrollments:50,promotionalCostMinor:0,currency:'USD'},asOf:T};
 assert.equal(contracts.validateTrialPublicationPreview(preview).ready,false);
 for(const p of [{ready:true},{activationAvailable:true},{promotionalCreditsAvailable:true},{digest:'invalid'}])assert.throws(()=>contracts.validateTrialPublicationPreview({...preview,...p}));
});
test('D11-A HTTP: guarded HQ reads never accept unverified scope, body, query or expired session',async()=>{
 const calls=[];const {app,base}=await appWith(async(op,p)=>{calls.push([op,p]);if(op==='readTrialGovernance')return empty();const e=new Error('SAAS_FORBIDDEN');e.code='42501';throw e;});
 try{assert.equal((await send(base+'/governance')).status,200);assert.deepEqual(calls[0],['readTrialGovernance',['verified-hq-subject']]);const n=calls.length;
  assert.equal((await send(base+'/governance?schoolId='+U())).status,400);
  assert.equal((await send(base+'/campaigns/not-a-uuid')).status,400);
  assert.equal((await send(base+'/governance',{headers:{'x-test-session':'expired'}})).status,401);assert.equal(calls.length,n);
  assert.equal((await send(base+'/campaigns/'+U())).status,403);
  assert.equal((await send(base+'/campaign-versions/'+U()+'/publication-preview')).status,403);
  for(const path of ['/signup','/enroll','/redeem','/program/activate'])assert.equal((await send(base+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
 }finally{await app.close();}
});
test('D11-A HTTP: exact human marker, same-origin, immutable key and closed policy proposal bind to the verified subject',async()=>{
 const {trialTerms}=await fixtures(),old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';const calls=[];
 const {app,base}=await appWith(async(op,p)=>{calls.push([op,p]);const b=JSON.parse(p[1]);return {policyVersion:{policyId:U(),version:1,status:'PROPOSED',terms:b.terms,reason:b.reason,actorPrincipalId:U(),recordedAt:T},replayed:false};});
 const body={expectedVersion:0,terms:trialTerms(),reason},header=()=>human(contracts.SAAS_COMMANDS.proposeTrialPolicy);
 try{const key=U();assert.equal((await send(base+'/policy-versions',{method:'POST',headers:{...header(),'idempotency-key':key},body:JSON.stringify(body)})).status,200);
  assert.deepEqual(calls[0][1].slice(0,3),['verified-hq-subject',JSON.stringify(body),key]);const n=calls.length;
  for(const [h,b] of [[{...header(),origin:'https://evil.example'},body],[{...header(),'x-hon-human-command':contracts.SAAS_COMMANDS.decideExceptionPolicy},body],[{...header(),'idempotency-key':'bad'},body],[header(),{...body,actorPrincipalId:U()}]])assert([400,403].includes((await send(base+'/policy-versions',{method:'POST',headers:h,body:JSON.stringify(b)})).status));
  assert.equal(calls.length,n);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('D11-A HTTP: refusal codes and receipt validation preserve safe publication semantics',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';let errorCode='40001',errorMessage='SAAS_TRIAL_PREVIEW_STALE';const {app,base}=await appWith(async()=>{const e=new Error(errorMessage);e.code=errorCode;throw e;});
 const body={versionId:U(),expectedRevision:0,previewDigest:'a'.repeat(64),confirmation:contracts.TRIAL_PUBLICATION_CONFIRMATION,reason};
 try{for(const [code,message,status] of [['40001','SAAS_TRIAL_PREVIEW_STALE',409],['40001','SAAS_VERSION_CONFLICT',409],['23514','SAAS_TRIAL_PUBLICATION_BLOCKED',422],['42501','SAAS_FORBIDDEN',403],['55P03','busy',409]]){
  errorCode=code;errorMessage=message;const result=await send(base+'/campaigns/'+U()+'/publish',{method:'POST',headers:human(contracts.SAAS_COMMANDS.publishTrialCampaign),body:JSON.stringify(body)});assert.equal(result.status,status,result.body);
 }
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('D11-A HTTP: each fixed command uses its own marker and resource-bound request with metadata-only receipts',async()=>{
 const {trialTerms,trialDefinition,trialApproval}=await fixtures(),old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const campaign=U(),version=U(),policy=U(),decision=U(),actor=U(),calls=[];
 const policyRow={policyId:policy,version:1,status:'PROPOSED',terms:trialTerms(),reason,actorPrincipalId:actor,recordedAt:T};
 const campaignRow={versionId:version,campaignId:campaign,version:1,definition:trialDefinition(),reason,actorPrincipalId:actor,recordedAt:T};
 const decisionRow={decisionId:decision,revision:1,policyId:policy,decision:'APPROVED',validFrom:T,validUntil:T2,reason,actorPrincipalId:actor,recordedAt:T};
 const publication={publicationId:U(),campaignId:campaign,revision:1,kind:'PUBLISHED',versionId:version,policyDecisionId:decision,previewDigest:'a'.repeat(64),reason,actorPrincipalId:actor,recordedAt:T,activationAvailable:false};
 const {app,base}=await appWith(async(op,p)=>{calls.push([op,p]);if(op==='proposeTrialPolicy')return {policyVersion:policyRow,replayed:false};if(op==='decideTrialPolicy')return {decision:decisionRow,replayed:false};if(op==='draftTrialCampaign')return {campaignVersion:campaignRow,replayed:false};return {publication:op==='withdrawTrialCampaign'?{...publication,kind:'WITHDRAWN',previewDigest:null}:publication,replayed:false};});
 const commands=[['policy-versions','proposeTrialPolicy',contracts.SAAS_COMMANDS.proposeTrialPolicy,{expectedVersion:0,terms:trialTerms(),reason}],['policy-decisions','decideTrialPolicy',contracts.SAAS_COMMANDS.decideTrialPolicy,trialApproval(policy,0)],['campaign-versions','draftTrialCampaign',contracts.SAAS_COMMANDS.draftTrialCampaign,{campaignId:null,expectedVersion:0,definition:trialDefinition(),reason}],['campaigns/'+campaign+'/publish','publishTrialCampaign',contracts.SAAS_COMMANDS.publishTrialCampaign,{versionId:version,expectedRevision:0,previewDigest:'a'.repeat(64),confirmation:contracts.TRIAL_PUBLICATION_CONFIRMATION,reason}],['campaigns/'+campaign+'/withdraw','withdrawTrialCampaign',contracts.SAAS_COMMANDS.withdrawTrialCampaign,{expectedRevision:1,reason}]];
 try{for(const [path,op,marker,body]of commands){const key=U(),r=await send(base+'/'+path,{method:'POST',headers:{...human(marker),'idempotency-key':key},body:JSON.stringify(body)});assert.equal(r.status,200,r.body);const [actual,params]=calls.at(-1);assert.equal(actual,op);assert.equal(params[0],'verified-hq-subject');assert.deepEqual(params.slice(1,-2),path.startsWith('campaigns/')?[campaign,JSON.stringify(body),key]:[JSON.stringify(body),key]);const n=calls.length;assert.equal((await send(base+'/'+path,{method:'POST',headers:human('wrong-command'),body:JSON.stringify(body)})).status,403);assert.equal(calls.length,n);}}
 finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
