const { test }=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
require('reflect-metadata');
const {ClassPassService}=require('../dist/classpass/classpass.service.js');
const {ClassPassController}=require('../dist/classpass/classpass.controller.js');
const scope={organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID()},target=randomUUID();
const context=(patch={})=>{const id=randomUUID();return{...scope,externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:'key',...patch};};
const projection={id:target,version:1,status:'ACTIVE',paymentProviderOutcome:'UNAVAILABLE',attendanceOutcome:'NOT_RECORDED_BY_CLASSPASS',parentProjection:'UNAVAILABLE'};
const status=n=>e=>e.getStatus?.()===n;
test('ClassPass read uses only the read-only tenant wrapper and safe GUC setup',async()=>{
 const calls=[];const service=new ClassPassService({withTenantTransaction:async()=>assert.fail('Normal tenant transaction used for read'),withTenantReadOnlyTransaction:async(c,work)=>work({query:async(sql,args)=>{calls.push([sql,args]);return{rows:[{data:projection}]};}})});
 assert.deepEqual(await service.read(context(),'PASS',target),projection);
 assert(calls.some(([sql,args])=>sql==='SELECT hon.read_classpass($1,$2,$3::uuid) data'&&args[0]==='verified'&&args[1]==='PASS'&&args[2]===target));
 assert(calls.some(([sql,args])=>sql.includes("set_config('app.hon_external_subject'")&&args[1]==='verified'));
 assert(!calls.some(([sql])=>/INSERT|UPDATE|DELETE|SET TRANSACTION/i.test(sql)));
});
test('ClassPass services reject forged human mode before SQL and map read failures safely',async()=>{
 let calls=0;const service=new ClassPassService({withTenantReadOnlyTransaction:async()=>{calls++;},withTenantTransaction:async()=>{calls++;}});
 for(const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{source:'AUTOMATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{externalSubject:''}]){
  await assert.rejects(()=>service.read(context(patch),'PRODUCT',target),status(403));
  await assert.rejects(()=>service.command(context(patch),'ADMIT',target,{expectedVersion:1,passId:target}),status(403));
 }
 await assert.rejects(()=>service.read(context(),'PRODUCT','invalid'),status(400));
 await assert.rejects(()=>service.command(context(),'ADMIT',target,{expectedVersion:1,passId:target,amount:1}),status(400));assert.equal(calls,0);
 for(const [code,n]of[['42501',403],['P0002',404],['22023',400]])await assert.rejects(()=>new ClassPassService({withTenantReadOnlyTransaction:async()=>{throw Object.assign(new Error('SQL_SECRET'),{code});}}).read(context(),'PASS',target),status(n));
});
test('ClassPass commands remain normal transactions, invoking only the fixed nonfinancial command',async()=>{
 const calls=[];const receipt={...projection,externalEffects:'NONE',replayed:false};
 const service=new ClassPassService({withTenantReadOnlyTransaction:async()=>assert.fail('Command used read-only wrapper'),withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>{calls.push([sql,args]);return{rows:[{data:receipt}]};}})});
 assert.deepEqual(await service.command(context(),'ADMIT',target,{expectedVersion:1,passId:target}),receipt);
 assert(calls.some(([sql,args])=>sql.includes('SELECT hon.command_classpass(')&&args[0]==='verified'&&args[1]==='ADMIT'));
});
test('ClassPass controller derives verified subject and exact permission and marks reads private no-store',async()=>{
 const calls=[],headers=[];const db={resolveAuthorizedScope:async(...args)=>{calls.push(args);return scope;}};
 const controller=new ClassPassController(db,{read:async(c,kind,id)=>{assert.equal(c.externalSubject,'verified');assert.equal(c.principalType,'HUMAN_USER');assert.equal(c.source,'HUMAN_UI');assert.equal(kind,'PASS');assert.equal(id,target);return projection;}});
 const request={honIdentity:{externalSubject:'verified'},headers:{'external-subject':'forged'}};
 assert.deepEqual((await controller.read(scope.organizationId,scope.schoolId,'PASS',target,request,{setHeader:(...args)=>headers.push(args)})).data,projection);
 assert.deepEqual(calls[0],['verified',scope.schoolId,'classpass.read']);assert.deepEqual(headers[0],['Cache-Control','private, no-store']);
 await assert.rejects(()=>controller.read(randomUUID(),scope.schoolId,'PASS',target,request,{setHeader:()=>{}}),status(403));
});
test('ClassPass controller command preserves exact permission, verified human context, receipt and no-store metadata',async()=>{
 const calls=[];const request={honIdentity:{externalSubject:'verified'},headers:{'external-subject':'forged'}},response={setHeader:(...a)=>calls.push(['header',...a])};
 const controller=new ClassPassController({resolveAuthorizedScope:async(...a)=>{calls.push(a);return scope;}},{command:async(c,action,id,input)=>{assert.equal(c.externalSubject,'verified');assert.equal(c.source,'HUMAN_UI');assert.equal(c.principalType,'HUMAN_USER');assert.equal(c.idempotencyKey,'human-key');assert.equal(c.requestId,c.correlationId);assert.equal(id,target);return{...projection,replayed:false,externalEffects:'NONE'};}});
 for(const [action,input,permission]of[['ADMIT',{expectedVersion:1,passId:target},'classpass.admit'],['REVERSE_ISSUANCE',{expectedVersion:1,reason:'Correction'},'classpass.reverse'],['ISSUE',{expectedVersion:1,studentProfileId:target,issuanceKind:'MANUAL_NONFINANCIAL',reason:'Grant'},'classpass.manage']]){const r=await controller.command(scope.organizationId,scope.schoolId,action,target,'human-key',input,request,response);assert.equal(r.meta.replayed,false);assert(calls.some(a=>a[0]==='verified'&&a[2]===permission));}
 assert(calls.some(a=>a[0]==='header'&&a[1]==='Cache-Control'&&a[2]==='private, no-store'));
 assert.equal(Reflect.getMetadata('path',ClassPassController),'organizations/:organizationId/schools/:schoolId/classpass');assert.equal(Reflect.getMetadata('path',controller.command),'commands/:action/:target');
});
test('ClassPass direct-human guard requires configured same origin, exact command marker and JSON POST',()=>{
 const {ClassPassHumanUiGuard}=require('../dist/classpass/classpass.dto.js');const guard=new ClassPassHumanUiGuard(),old=process.env.HON_PUBLIC_ORIGIN;
 const run=patch=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method:'POST',headers:{origin:'https://hon.example.test','x-hon-human-command':'classpass','content-type':'application/json','sec-fetch-site':'same-origin'},...patch})})});
 try{
  process.env.HON_PUBLIC_ORIGIN='https://hon.example.test';assert.equal(run({}),true);
  for(const patch of[{method:'PUT'},{headers:{}},{headers:{origin:'https://evil.example.test','x-hon-human-command':'classpass','content-type':'application/json'}},{headers:{origin:'https://hon.example.test','x-hon-human-command':'classpass','content-type':'application/json','sec-fetch-site':'cross-site'}},{headers:{origin:'https://hon.example.test','x-hon-human-command':'other','content-type':'application/json'}}])assert.throws(()=>run(patch),status(403));
  delete process.env.HON_PUBLIC_ORIGIN;assert.throws(()=>run({}),status(503));
 }finally{if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
