const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {HonOsAdmissionService}=require('../dist/hon-os-admission/hon-os-admission.service.js');
const {HonOsAdmissionHumanGuard}=require('../dist/hon-os-admission/hon-os-admission.controller.js');
const c=require('@hon/contracts');
const id=()=>randomUUID();
const limits=(over={})=>({versionId:id(),version:2,signupsPerHour:12,signupsPerDay:150,trialsPerHour:8,trialsPerDay:90,reason:'Tighten limits before opening',recordedBy:'HQ_OWNER',actorPrincipalId:id(),recordedAt:'2026-11-12T06:00:00.000Z',...over});
const input={expectedVersion:1,signupsPerHour:12,signupsPerDay:150,trialsPerHour:8,trialsPerDay:90,reason:'Tighten limits before opening'};
const req={honIdentity:{externalSubject:'oidc:fixture:hq'}};

test('the change input is closed: no actor, organization or program can be supplied, and per hour never exceeds per day',()=>{
 assert.deepEqual(c.validateAdmissionLimitsInput(input),input);
 for(const patch of [{actorPrincipalId:id()},{program:'TEST_MODE'},{organizationId:id()},{signupsPerHour:151},{trialsPerHour:0},{trialsPerDay:100001},{reason:'short'},{reason:' padded reason here '},{expectedVersion:0},{signupsPerHour:'12'}])
  assert.throws(()=>c.validateAdmissionLimitsInput({...input,...patch}));
});
test('the change passes only the session subject, the closed body and the key, with fresh request ids',async()=>{
 const calls=[],key=id(),service=new HonOsAdmissionService({callHonOsAdmission:async(...a)=>{calls.push(a);return {limits:limits(),replayed:false};}});
 const r=await service.set(req,input,key);
 assert.equal(r.limits.version,2);
 assert.equal(calls[0][0],'set');assert.equal(calls[0][1][0],'oidc:fixture:hq');assert.deepEqual(JSON.parse(calls[0][1][1]),input);assert.equal(calls[0][1][2],key);
 assert.notEqual(calls[0][1][3],calls[0][1][4]);
 await assert.rejects(()=>service.set(req,{...input,extra:1},key),e=>e.status===400);
 await assert.rejects(()=>service.set(req,input,'not-a-key'),e=>e.status===400);
 const lying=new HonOsAdmissionService({callHonOsAdmission:async()=>({limits:limits({recordedBy:'MIGRATION_OWNER',actorPrincipalId:null,reason:null}),replayed:false})});
 await assert.rejects(()=>lying.set(req,input,key),e=>e.status===503);
});
test('database refusals map to closed codes and SQL never leaks',async()=>{
 for(const [code,status,closed] of [['42501',403,'ADMISSION_FORBIDDEN'],['40001',409,'ADMISSION_LIMITS_CHANGED'],['23505',409,'IDEMPOTENCY_KEY_REUSED'],['55P03',503,'ADMISSION_OUTCOME_UNKNOWN'],
   ['22023',400,'ADMISSION_INPUT_INVALID'],['XX000',503,'ADMISSION_UNAVAILABLE']]){
  const service=new HonOsAdmissionService({callHonOsAdmission:async()=>{throw Object.assign(new Error('SECRET SQL'),{code});}});
  await assert.rejects(()=>service.set(req,input,id()),e=>e.status===status&&e.getResponse().code===closed&&!JSON.stringify(e.getResponse()).includes('SECRET'));
  await assert.rejects(()=>service.status(req),e=>e.status===status);
 }
});
test('recording a refusal never throws and passes only the kind',async()=>{
 const calls=[];await new HonOsAdmissionService({callHonOsAdmission:async(...a)=>{calls.push(a);return true;}}).recordRefusal('TRIAL');
 assert.deepEqual(calls,[['refused',['TRIAL']]]);
 await new HonOsAdmissionService({callHonOsAdmission:async()=>{throw new Error('down');}}).recordRefusal('SIGNUP');
});
test('the change needs the exact human command header from the configured origin',()=>{
 const saved=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example.invalid';
 try{
  const ctx=(headers,method='POST')=>({switchToHttp:()=>({getRequest:()=>({method,headers,query:{},originalUrl:'/v1/hq/admission/limits'}),getResponse:()=>({setHeader(){}})})});
  const good={origin:'https://hon.example.invalid','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':c.ADMISSION_LIMITS_COMMAND,'content-type':'application/json'};
  assert.equal(new HonOsAdmissionHumanGuard().canActivate(ctx(good)),true);
  for(const bad of [{...good,'x-hon-human-command':'hon-os-sign-up'},{...good,origin:'https://evil.example.invalid'},{...good,'sec-fetch-site':'cross-site'}])
   assert.throws(()=>new HonOsAdmissionHumanGuard().canActivate(ctx(bad)),e=>e.status===403);
 }finally{if(saved===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=saved;}
});
