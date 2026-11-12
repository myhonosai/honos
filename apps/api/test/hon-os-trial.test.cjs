const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {HonOsTrialService}=require('../dist/accounts/hon-os-trial.service.js');
const {HonOsTrialHumanGuard}=require('../dist/accounts/hon-os-trial.controller.js');
const c=require('@hon/contracts');
const school=randomUUID(),input={schoolId:school,campaignId:randomUUID(),confirmation:c.TRIAL_CONFIRMATION};
const start=new Date('2026-11-09T10:00:00.123456Z');
const trial={enrollmentId:randomUUID(),organizationId:randomUUID(),schoolId:school,campaignId:input.campaignId,durationDays:14,
 startsAt:'2026-11-09T10:00:00.123456Z',endsAt:'2026-11-23T10:00:00.123456Z',status:'TRIAL_ACTIVE',
 automaticCharge:false,paymentMethodRequired:false,aiIncluded:false,aiCredits:null,creativeCreditsIncluded:false};
const aiCredits={credits:100,dailyCap:20,perRequestCap:10,expiresAt:'2026-11-16T10:00:00.123456Z',used:7};
const funded={...trial,aiIncluded:true,aiCredits};
const offer={campaignId:input.campaignId,name:'Founding schools trial',durationDays:14,automaticCharge:false,paymentMethodRequired:false,aiIncluded:false,aiCredits:null};
const fundedOffer={...offer,aiIncluded:true,aiCredits:{credits:100,dailyCap:20,perRequestCap:10,expiryDays:7}};
const req={honIdentity:{externalSubject:'oidc:fixture:owner'}};
test('closed trial input: no organization, plan, duration, price, credits or AI can be supplied',()=>{
 assert.deepEqual(c.validateTrialStartInput(input),input);
 for(const patch of [{organizationId:randomUUID()},{plan:'COMPLETE'},{durationDays:90},{priceMinor:0},{aiIncluded:true},{credits:100},{subject:'oidc:x'}])
  assert.throws(()=>c.validateTrialStartInput({...input,...patch}));
 for(const patch of [{schoolId:'school'},{campaignId:''},{confirmation:'YES'},{confirmation:c.SIGNUP_CONFIRMATION}])assert.throws(()=>c.validateTrialStartInput({...input,...patch}));
 assert(start);
});
test('closed trial receipt: never claims a charge, a payment method or creative credits; AI only with its HQ-set credit; window matches its length',()=>{
 assert.deepEqual(c.validateHonOsTrial(trial),trial);
 assert.deepEqual(c.validateHonOsTrial(funded),funded);
 for(const patch of [{aiIncluded:false},{aiCredits:null},{aiCredits:{...aiCredits,dailyCap:101}},{aiCredits:{...aiCredits,perRequestCap:21}},{aiCredits:{...aiCredits,credits:0}},
   {aiCredits:{...aiCredits,used:-1}},{aiCredits:{...aiCredits,used:1.5}},{aiCredits:{...aiCredits,expiresAt:'2026-11-24T10:00:00.123456Z'}},{aiCredits:{...aiCredits,expiresAt:'2026-11-09T10:00:00.123456Z'}},
   {aiCredits:{...aiCredits,creative:1}},{creativeCreditsIncluded:true}]) assert.throws(()=>c.validateHonOsTrial({...funded,...patch}));
 for(const status of ['TRIAL_ENDED','SUPERSEDED'])assert.equal(c.validateHonOsTrial({...trial,status}).status,status);
 for(const patch of [{automaticCharge:true},{paymentMethodRequired:true},{aiIncluded:true},{aiCredits},{creativeCreditsIncluded:true},{status:'PAYMENT_ACTIVE'},
   {durationDays:15},{endsAt:'2026-11-24T10:00:00.123456Z'},{startsAt:'soon'},{extra:1}]) assert.throws(()=>c.validateHonOsTrial({...trial,...patch}));
});
test('trial status: an offer only for a registered school with no trial while the program is open',()=>{
 const open={trialStatus:'TEST_MODE',schoolId:school,available:offer,trial:null};
 assert.deepEqual(c.validateTrialStatus(open),open);
 assert.deepEqual(c.validateTrialStatus({...open,available:fundedOffer}),{...open,available:fundedOffer});
 assert.deepEqual(c.validateTrialStatus({trialStatus:'CLOSED',schoolId:null,available:null,trial:null}).schoolId,null);
 assert.equal(c.validateTrialStatus({...open,available:null,trial}).trial.status,'TRIAL_ACTIVE');
 for(const bad of [{...open,trialStatus:'LIVE'},{...open,trialStatus:'CLOSED'},{...open,trial},{...open,schoolId:null},{...open,available:{...offer,automaticCharge:true}},
   {...open,available:{...offer,paymentMethodRequired:true}},{...open,available:{...offer,durationDays:3}},{...open,available:{...offer,aiIncluded:true}},
   {...open,available:{...fundedOffer,aiCredits:{...fundedOffer.aiCredits,expiryDays:15}}},{...open,available:{...fundedOffer,aiCredits:{...fundedOffer.aiCredits,dailyCap:101}}},{...open,available:null,trial:{...trial,schoolId:randomUUID()}}])
  assert.throws(()=>c.validateTrialStatus(bad));
});
test('start passes only the session subject, the closed input and the key; a lying receipt is refused',async()=>{
 const calls=[],service=new HonOsTrialService({callHonOsTrial:async(...a)=>{calls.push(a);return trial;}});
 await assert.rejects(()=>service.start(req,{...input,plan:'COMPLETE'},randomUUID()),e=>e.status===400);
 await assert.rejects(()=>service.start(req,input,'not-a-key'),e=>e.status===400);assert.equal(calls.length,0);
 const key=randomUUID();assert.deepEqual(await service.start(req,input,key),trial);
 assert.deepEqual(calls,[['start',['oidc:fixture:owner',JSON.stringify(input),key]]]);
 const lying=new HonOsTrialService({callHonOsTrial:async()=>({...trial,aiIncluded:true})});
 assert.deepEqual(await new HonOsTrialService({callHonOsTrial:async()=>funded}).start(req,input,randomUUID()),funded);
 await assert.rejects(()=>lying.start(req,input,randomUUID()),e=>e.status===503);
});
test('database refusals map to closed codes; business refusals keep their own code; SQL never leaks',async()=>{
 for(const [code,message,status,closed]of [['55000','TRIAL_CLOSED',409,'TRIAL_CLOSED'],['23505','TRIAL_ALREADY_USED',409,'TRIAL_ALREADY_USED'],
   ['23514','TRIAL_CAMPAIGN_UNAVAILABLE',409,'TRIAL_CAMPAIGN_UNAVAILABLE'],['23514','TRIAL_CAMPAIGN_FULL',409,'TRIAL_CAMPAIGN_FULL'],['23514','TRIAL_NOT_ELIGIBLE',409,'TRIAL_NOT_ELIGIBLE'],
   ['23505','TRIAL_KEY_REUSED',409,'TRIAL_KEY_REUSED'],['23514','TRIAL_CAPACITY_REACHED',409,'TRIAL_CAPACITY_REACHED'],['23514','SECRET SQL',409,'ACCOUNT_CONFLICT'],['42501','TRIAL_FORBIDDEN',403,'ACCOUNT_FORBIDDEN'],['55P03','SECRET',503,'TRIAL_BUSY'],
   ['22023','SECRET',400,'ACCOUNT_INPUT_INVALID'],['40001','SECRET',409,'ACCOUNT_CONFLICT'],['XX000','TRIAL_CLOSED',503,'ACCOUNT_UNAVAILABLE']]){
  const recorded=[],service=new HonOsTrialService({callHonOsTrial:async()=>{throw Object.assign(new Error(message),{code});}},{recordRefusal:async kind=>{recorded.push(kind);}});
  await assert.rejects(()=>service.start(req,input,randomUUID()),e=>e.status===status&&e.getResponse().code===closed&&!JSON.stringify(e.getResponse()).includes('SECRET'));
  // 0274: only a capacity refusal is passed on for HQ to see.
  assert.deepEqual(recorded,closed==='TRIAL_CAPACITY_REACHED'?['TRIAL']:[]);
 }
});
test('status read passes only the session subject and validates the closed response',async()=>{
 const calls=[],service=new HonOsTrialService({callHonOsTrial:async(...a)=>{calls.push(a);return {trialStatus:'CLOSED',schoolId:null,available:null,trial:null};}});
 assert.equal((await service.status(req)).trialStatus,'CLOSED');assert.deepEqual(calls,[['read',['oidc:fixture:owner']]]);
 const bad=new HonOsTrialService({callHonOsTrial:async()=>({trialStatus:'CLOSED',schoolId:null,available:offer,trial:null})});
 await assert.rejects(()=>bad.status(req),e=>e.status===503);
});
test('trial human guard needs its own command header and refuses forged context',()=>{
 const saved={...process.env};process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const guard=new HonOsTrialHumanGuard(),headers={origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','content-type':'application/json','x-hon-human-command':c.TRIAL_HUMAN_COMMAND};
 const check=patch=>{const r={method:'POST',headers:{...headers},query:{},originalUrl:'/v1/account/trial',...patch};assert.equal(guard.canActivate({switchToHttp:()=>({getRequest:()=>r,getResponse:()=>({setHeader(){}})})}),true);};
 try{check({});for(const patch of [{headers:{...headers,origin:'https://evil.invalid'}},{headers:{...headers,'x-hon-human-command':c.SIGNUP_HUMAN_COMMAND}},{headers:{...headers,'x-hon-school-id':randomUUID()}},
   {headers:{...headers,authorization:'Bearer x'}},{originalUrl:'/v1/account/trial?plan=x',query:{plan:'x'}},{source:'AI'}])assert.throws(()=>check(patch));}finally{process.env=saved;}
});
