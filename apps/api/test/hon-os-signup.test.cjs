const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto');
const {HonOsSignupService}=require('../dist/accounts/hon-os-signup.service.js');
const {HonOsSignupHumanGuard}=require('../dist/accounts/hon-os-signup.controller.js');
const c=require('@hon/contracts'),auth=require('@hon/auth');
const input={ownerName:'Dana Kim',schoolName:'Blue Dragon Taekwondo',legalName:'Blue Dragon LLC',timezone:'America/Los_Angeles',
 location:{country:'US',region:'IL',city:'Chicago',postalCode:'60601',addressLine1:'1 Synthetic Way',addressLine2:null},termsVersionId:randomUUID(),confirmation:c.SIGNUP_CONFIRMATION};
const registration={registrationId:randomUUID(),organizationId:randomUUID(),schoolId:randomUUID(),schoolName:'Blue Dragon Taekwondo',timezone:'America/Los_Angeles',
 registeredAt:new Date().toISOString(),lifecycle:'REGISTERED',accessGranted:false,billingActivated:false,aiCreditsGranted:false};
const notice={profile:'US_IL_BIPA',status:'AVAILABLE_WITH_CONSENT',laws:['Illinois Biometric Information Privacy Act (740 ILCS 14)'],addOns:['WRITTEN_RELEASE','PUBLIC_RETENTION_SCHEDULE','PRIVATE_RIGHT_OF_ACTION'],reviewStatus:'TEST_ONLY_DRAFT',rulesVersion:1};
const result={registration,location:{...input.location,version:1,updatedAt:'2026-11-16T04:00:00.000Z'},faceCheckInNotice:notice};
const terms={termsVersionId:randomUUID(),version:1,status:'TEST_ONLY_DRAFT',title:'HON OS sign-up terms',documentDigest:'a'.repeat(64)};
test('closed sign-up input: no subject, email, organization, role, price or plan can be supplied',()=>{
 assert.deepEqual(c.validateSignupInput(input),input);
 for(const patch of [{email:'x@example.invalid'},{subject:'oidc:x'},{organizationId:randomUUID()},{role:'OWNER'},{plan:'COMPLETE'},{priceMinor:0},{trial:true}])
  assert.throws(()=>c.validateSignupInput({...input,...patch}));
 for(const patch of [{ownerName:''},{ownerName:' Dana'},{schoolName:'x'.repeat(121)},{legalName:'Line\nbreak'},{timezone:'posix/UTC'},{timezone:'Not a zone!'},
   {termsVersionId:'v1'},{confirmation:'YES'},{ownerName:42}]) assert.throws(()=>c.validateSignupInput({...input,...patch}));
});
test('0392: sign-up needs the school address in a closed shape (state required in the US and Canada)',()=>{
 const {location,...withoutLocation}=input;
 assert.throws(()=>c.validateSignupInput(withoutLocation));
 assert.deepEqual(c.validateSignupInput({...input,location:{country:'KR',region:null,city:'Seoul',postalCode:null,addressLine1:null,addressLine2:null}}).location.country,'KR');
 for(const patch of [{region:null},{region:'ZZ'},{country:'us'},{country:'USA'},{city:''},{city:' Chicago'},{city:'<b>x</b>'},{city:'x'.repeat(101)},
   {postalCode:'x'.repeat(21)},{addressLine1:null,addressLine2:'Suite 2'},{street:'1 Main'},{addressLine1:'a\nb'}]) {
  assert.throws(()=>c.validateSignupInput({...input,location:{...location,...patch}}),JSON.stringify(patch));
 }
 const {city,...noCity}=location; assert.throws(()=>c.validateSignupInput({...input,location:noCity}));
 assert.throws(()=>c.validateSignupInput({...input,location:{...location,country:'CA',region:'IL'}}));
 assert.equal(c.validateSignupInput({...input,location:{...location,country:'CA',region:'QC'}}).location.region,'QC');
});
test('0392: the sign-up answer carries the recorded address and a consistent face check-in notice',()=>{
 assert.deepEqual(c.validateSignupResult(result),result);
 for(const bad of [{...result,location:null},{...result,faceCheckInNotice:{...notice,reviewStatus:'LAWYER_APPROVED'}},{...result,faceCheckInNotice:{...notice,status:'BLOCKED'}},
   {...result,faceCheckInNotice:{...notice,profile:'NOT_REVIEWED'}},{...result,faceCheckInNotice:{...notice,laws:[]}},{...result,faceCheckInNotice:{...notice,addOns:['SELL_DATA']}},
   {...result,registration:{...registration,accessGranted:true}},{...result,extra:1},{registration}]) assert.throws(()=>c.validateSignupResult(bad));
 const blocked={...notice,profile:'US_PORTLAND_BAN',status:'BLOCKED',laws:['x'],addOns:['CITY_BAN']};
 assert.equal(c.validateSignupResult({...result,faceCheckInNotice:blocked}).faceCheckInNotice.status,'BLOCKED');
 const none={...notice,profile:'NOT_REVIEWED',status:'NOT_REVIEWED',laws:[],addOns:[]};
 assert.equal(c.validateSignupResult({...result,faceCheckInNotice:none}).faceCheckInNotice.status,'NOT_REVIEWED');
});
test('closed responses: a registration never claims access, billing or AI credits',()=>{
 assert.deepEqual(c.validateSignupRegistration(registration),registration);
 for(const patch of [{accessGranted:true},{billingActivated:true},{aiCreditsGranted:true},{lifecycle:'TRIAL_ACTIVE'},{registeredAt:'soon'},{extra:1}])
  assert.throws(()=>c.validateSignupRegistration({...registration,...patch}));
 const ok={signupStatus:'TEST_MODE',terms,eligibility:'ELIGIBLE',registration:null};
 assert.deepEqual(c.validateSignupStatus(ok),ok);
 assert.deepEqual(c.validateSignupStatus({...ok,eligibility:'ALREADY_REGISTERED',registration}).registration,registration);
 for(const bad of [{...ok,signupStatus:'LIVE'},{...ok,eligibility:'ALREADY_REGISTERED'},{...ok,registration},{...ok,terms:{...terms,status:'APPROVED'}},
   {...ok,terms:{...terms,documentDigest:'x'}},{...ok,eligibility:'MAYBE'}]) assert.throws(()=>c.validateSignupStatus(bad));
});
function oidc(){return {HON_AUTH_MODE:'OIDC',HON_SESSION_AUDIENCE:'signup-unit',HON_SESSION_JWT_SECRET:randomBytes(32).toString('hex'),HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'};}
test('sign-up takes subject and verified email only from the signed OIDC session',async()=>{
 const saved={...process.env};try{
 Object.assign(process.env,oidc());
 const config=auth.sessionConfig(),calls=[],service=new HonOsSignupService({callHonOsSignup:async(...args)=>{calls.push(args);return result;}});
 const identity={externalSubject:'oidc:fixture:owner',email:'Owner@Example.invalid'};
 const req=proof=>({honIdentity:identity,headers:{cookie:auth.HON_SESSION_COOKIE+'='+auth.issueSession({...identity,...proof},config)}});
 await assert.rejects(()=>service.register(req({}),input,randomUUID()),e=>e.status===403);assert.equal(calls.length,0);
 await assert.rejects(()=>service.register(req({emailVerified:true}),{...input,email:'evil@example.invalid'},randomUUID()),e=>e.status===400);
 await assert.rejects(()=>service.register(req({emailVerified:true}),input,'not-a-key'),e=>e.status===400);assert.equal(calls.length,0);
 const key=randomUUID();assert.deepEqual(await service.register(req({emailVerified:true}),input,key),result);
 assert.deepEqual(calls[0],['register',[identity.externalSubject,'owner@example.invalid',JSON.stringify(input),key]]);
 const lying=new HonOsSignupService({callHonOsSignup:async()=>({...result,registration:{...registration,accessGranted:true}})});
 await assert.rejects(()=>lying.register(req({emailVerified:true}),input,randomUUID()),e=>e.status===503);
 }finally{process.env=saved;}
});
test('sign-up refuses a non-OIDC session even with a verified-looking proof',async()=>{
 const saved={...process.env};try{
 Object.assign(process.env,{...oidc(),HON_AUTH_MODE:'DEVELOPMENT'});let calls=0;
 const service=new HonOsSignupService({callHonOsSignup:async()=>{calls++;return registration;}});
 let config;try{config=auth.sessionConfig();}catch{return;}
 const identity={externalSubject:'dev:owner',email:'owner@example.invalid'};
 await assert.rejects(()=>service.register({honIdentity:identity,headers:{cookie:auth.HON_SESSION_COOKIE+'='+auth.issueSession({...identity,emailVerified:true},config)}},input,randomUUID()),e=>e.status===403);
 assert.equal(calls,0);
 }finally{process.env=saved;}
});
test('database refusals map to closed codes; business refusals keep their own code; SQL never leaks',async()=>{
 const saved={...process.env};try{
 Object.assign(process.env,oidc());const config=auth.sessionConfig();
 const identity={externalSubject:'oidc:fixture:owner',email:'owner@example.invalid'};
 const req={honIdentity:identity,headers:{cookie:auth.HON_SESSION_COOKIE+'='+auth.issueSession({...identity,emailVerified:true},config)}};
 for(const [code,message,status,closed]of [['55000','SIGNUP_CLOSED',409,'SIGNUP_CLOSED'],['23505','SIGNUP_ALREADY_REGISTERED',409,'SIGNUP_ALREADY_REGISTERED'],
   ['23514','SIGNUP_TERMS_CHANGED',409,'SIGNUP_TERMS_CHANGED'],['23514','SIGNUP_REVIEW_REQUIRED',409,'SIGNUP_REVIEW_REQUIRED'],['23514','SIGNUP_OWNER_NOT_ELIGIBLE',409,'SIGNUP_OWNER_NOT_ELIGIBLE'],
   ['23505','SIGNUP_KEY_REUSED',409,'SIGNUP_KEY_REUSED'],['23514','SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED',409,'SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED'],['23514','SIGNUP_CAPACITY_REACHED',409,'SIGNUP_CAPACITY_REACHED'],['23514','SECRET SQL',409,'ACCOUNT_CONFLICT'],['42501','SECRET SQL',403,'ACCOUNT_FORBIDDEN'],['55P03','SECRET',503,'SIGNUP_BUSY'],
   ['22023','SECRET',400,'ACCOUNT_INPUT_INVALID'],['XX000','SIGNUP_CLOSED',503,'ACCOUNT_UNAVAILABLE']]){
  const recorded=[],service=new HonOsSignupService({callHonOsSignup:async()=>{throw Object.assign(new Error(message),{code});}},{recordRefusal:async kind=>{recorded.push(kind);}});
  await assert.rejects(()=>service.register(req,input,randomUUID()),e=>e.status===status&&e.getResponse().code===closed&&!JSON.stringify(e.getResponse()).includes('SECRET'));
  // 0274: only a capacity refusal is passed on for HQ to see.
  assert.deepEqual(recorded,closed==='SIGNUP_CAPACITY_REACHED'?['SIGNUP']:[]);
 }
 }finally{process.env=saved;}
});
test('status read passes only the session subject and validates the closed response',async()=>{
 const calls=[],service=new HonOsSignupService({callHonOsSignup:async(...a)=>{calls.push(a);return {signupStatus:'CLOSED',terms,eligibility:'ELIGIBLE',registration:null};}});
 assert.equal((await service.status({honIdentity:{externalSubject:'oidc:x'}})).signupStatus,'CLOSED');assert.deepEqual(calls,[['read',['oidc:x']]]);
 const bad=new HonOsSignupService({callHonOsSignup:async()=>({signupStatus:'LIVE',terms,eligibility:'ELIGIBLE',registration:null})});
 await assert.rejects(()=>bad.status({honIdentity:{externalSubject:'oidc:x'}}),e=>e.status===503);
});
test('sign-up human guard needs its own command header and refuses forged context',()=>{
 const saved={...process.env};process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const guard=new HonOsSignupHumanGuard(),headers={origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','content-type':'application/json','x-hon-human-command':c.SIGNUP_HUMAN_COMMAND};
 const check=patch=>{const r={method:'POST',headers:{...headers},query:{},originalUrl:'/v1/account/sign-up',...patch};assert.equal(guard.canActivate({switchToHttp:()=>({getRequest:()=>r,getResponse:()=>({setHeader(){}})})}),true);};
 try{check({});for(const patch of [{headers:{...headers,origin:'https://evil.invalid'}},{headers:{...headers,'x-hon-human-command':c.STAFF_ACCOUNT_HUMAN_COMMAND}},{headers:{...headers,'x-hon-school-id':randomUUID()}},
   {headers:{...headers,authorization:'Bearer x'}},{originalUrl:'/v1/account/sign-up?plan=x',query:{plan:'x'}},{source:'AI'}])assert.throws(()=>check(patch));}finally{process.env=saved;}
});
