const { test }=require('node:test');
const assert=require('node:assert/strict');
const { randomBytes, randomUUID }=require('node:crypto');
require('reflect-metadata');
const { KioskService }=require('../dist/kiosk/kiosk.service.js');
const { KioskStaffController,KioskPublicController }=require('../dist/kiosk/kiosk.controller.js');
const { KioskHumanUiGuard }=require('../dist/kiosk/kiosk.dto.js');
const scope={organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID()};
const id=randomUUID(),secret=()=>randomBytes(32).toString('base64url');
const context=(patch={})=>{const requestId=randomUUID();return {...scope,externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId,correlationId:requestId,idempotencyKey:'',...patch};};
const status=n=>e=>e.getStatus?.()===n;
test('Kiosk service rejects forged human modes and public submission stays generic',async()=>{
 let calls=0;const service=new KioskService({withTenantTransaction:async()=>{calls++;},submitKioskHandoff:async()=>{calls++;throw new Error('SQL_SECRET');}});
 for(const patch of [{principalType:'AI_EMPLOYEE'},{source:'AUTOMATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{externalSubject:''}]){
  await assert.rejects(()=>service.recover(context(patch),id),status(403));
 }
 assert.deepEqual(await service.submit({terminalSession:secret(),claim:secret()}),{result:'NEEDS_STAFF_ASSISTANCE'});
 assert.deepEqual(await service.submit({terminalSession:'bad',claim:'bad'}),{result:'NEEDS_STAFF_ASSISTANCE'});
 assert.equal(calls,1);
});
test('Kiosk staff controller derives exact verified scopes and public controller exposes no state',async()=>{
 const calls=[];const db={resolveAuthorizedScope:async(...args)=>{calls.push(args);return scope;}};
 const service={activate:async(c,terminal,input)=>{assert.equal(c.externalSubject,'verified');assert.equal(c.source,'HUMAN_UI');assert.equal(terminal,id);assert.equal(input.terminalSession,terminalSecret);return {terminalId:id,state:'ACTIVE'};},provision:async(c,claim,input)=>{assert.equal(c.principalType,'HUMAN_USER');assert.equal(claim,id);assert.equal(input.claim,claimSecret);return {claimId:id,studentProfileId:id,classSessionId:id,state:'ISSUED'};},recover:async()=>({claimId:id,state:'CONSUMED'}),retire:async()=>({terminalId:id,state:'RETIRED'}),submit:async()=>({result:'NEEDS_STAFF_ASSISTANCE'})};
 const staff=new KioskStaffController(db,service),publicController=new KioskPublicController(service);
 const terminalSecret=secret(),claimSecret=secret(),request={honIdentity:{externalSubject:'verified'}};
 assert.equal((await staff.activate(scope.organizationId,scope.schoolId,id,{terminalSessionId:id,terminalSession:terminalSecret},request)).data.state,'ACTIVE');
 assert.equal((await staff.provision(scope.organizationId,scope.schoolId,id,{studentProfileId:id,classSessionId:id,claim:claimSecret},request)).data.state,'ISSUED');
 assert.deepEqual(calls,[['verified',scope.schoolId,'kiosk.terminal.manage'],['verified',scope.schoolId,'kiosk.handoff.provision']]);
 const headers=[];assert.deepEqual(await publicController.submit({terminalSession:terminalSecret,claim:claimSecret},{setHeader:(...args)=>headers.push(args)}),{result:'NEEDS_STAFF_ASSISTANCE'});
 assert.deepEqual(headers,[['Cache-Control','private, no-store']]);
 await assert.rejects(()=>staff.recover(randomUUID(),scope.schoolId,id,request),status(403));
});
test('Kiosk direct-human guard allows only its exact marker and rejects source delegation headers',()=>{
 const guard=new KioskHumanUiGuard(),old=process.env.HON_PUBLIC_ORIGIN;
 const run=patch=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method:'POST',originalUrl:'/v1/organizations/x/schools/y/kiosk/claims/z/provision',headers:{origin:'https://hon.example.test','x-hon-human-command':'kiosk','content-type':'application/json','sec-fetch-site':'same-origin'},...patch}),getResponse:()=>({setHeader:()=>{}})})});
 try {
  process.env.HON_PUBLIC_ORIGIN='https://hon.example.test';assert.equal(run({}),true);
  for(const patch of [{headers:{origin:'https://hon.example.test','x-hon-human-command':'other','content-type':'application/json'}},{headers:{origin:'https://hon.example.test','x-hon-human-command':'kiosk','content-type':'application/json','x-hon-source':'AI'}},{headers:{origin:'https://hon.example.test','x-hon-human-command':'kiosk','content-type':'application/json',authorization:'Bearer x'}},{headers:{origin:'https://evil.example.test','x-hon-human-command':'kiosk','content-type':'application/json'}},{originalUrl:'/v1/kiosk?scope=x'}])assert.throws(()=>run(patch),status(403));
 } finally {if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
