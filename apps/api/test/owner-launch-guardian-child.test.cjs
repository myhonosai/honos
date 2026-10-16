require('reflect-metadata');
const assert=require('node:assert/strict');const {test}=require('node:test');
const {OwnerLaunchService}=require('../dist/owner-launch/owner-launch.service.js');
const {OwnerLaunchController}=require('../dist/owner-launch/owner-launch.controller.js');
const {OwnerLaunchHumanUiGuard,OwnerLaunchGuardianChildHumanUiGuard}=require('../dist/owner-launch/owner-launch-human-ui.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const context={organizationId:id('1'),schoolId:id('2'),principalId:id('3'),requestId:id('4'),correlationId:id('4'),idempotencyKey:id('5'),externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI'};
const input={programId:id('6'),expectedProgramVersion:1,classSessionId:id('7'),expectedClassSessionVersion:1,guardianGivenName:'Guardian',guardianFamilyName:'Family',guardianBirthDate:'1980-02-03',childGivenName:'Child',childFamilyName:'Family',childBirthDate:'2015-02-03',attestation:'NEW_CHILD_WITH_NEW_GUARDIAN'};
const receipt={registrationId:id('8'),studentProfileId:id('9'),enrollmentId:id('a'),familyId:id('b'),programId:input.programId,classSessionId:input.classSessionId,registrationKind:'NEW_CHILD_WITH_NEW_GUARDIAN',status:'REGISTERED_NO_BOOKING',createdAt:'2026-10-16T00:00:00.000Z'};
const status=n=>e=>e.getStatus()===n;
test('child service is a separate fixed command and adult service cannot accept pair input',async()=>{
 let calls=0;const service=new OwnerLaunchService({ownerLaunchGuardianChildCommand:async(c,v)=>{calls++;assert.deepEqual(c,context);assert.deepEqual(v,input);return {receipt,replayed:false};},ownerLaunchCommand:()=>{throw new Error('Adult boundary must not be invoked');}});
 assert.deepEqual(await service.registerGuardianChild(context,input),{receipt,replayed:false});
 await assert.rejects(()=>service.register(context,input),status(400));
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{delegatedByPrincipalId:id('c')},{actionRequestId:id('c')}])await assert.rejects(()=>service.registerGuardianChild({...context,...patch},input),status(403));
 for(const patch of [{familyId:id('c')},{guardianId:id('c')},{guardians:[]},{children:[]},{parentLogin:true},{attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED'},{guardianBirthDate:'2026-02-30'},{childGivenName:''},{guardianGivenName:'child',guardianFamilyName:'F a m i l y'}])await assert.rejects(()=>service.registerGuardianChild(context,{...input,...patch}),status(400));
 await assert.rejects(()=>service.registerGuardianChild({...context,idempotencyKey:''},input),status(409));assert.equal(calls,1);
});
test('child receipt redaction and errors never claim booking, readiness or unknown success',async()=>{
 for(const patch of [{guardianEmail:'private'},{guardianPersonId:id('c')},{status:'FAMILY_READY'},{classSessionId:id('c')},{programId:id('d')},{registrationKind:'NEW_ADULT'}])await assert.rejects(()=>new OwnerLaunchService({ownerLaunchGuardianChildCommand:async()=>({receipt:{...receipt,...patch},replayed:false})}).registerGuardianChild(context,input),status(503));
 for(const [code,n]of [['42501',403],['23505',409],['40001',409],['22023',400],['P0002',404],['XX000',503]])await assert.rejects(()=>new OwnerLaunchService({ownerLaunchGuardianChildCommand:async()=>{throw{code};}}).registerGuardianChild(context,input),status(n));
 assert.equal((await new OwnerLaunchService({ownerLaunchGuardianChildCommand:async()=>({receipt,replayed:true})}).registerGuardianChild(context,input)).replayed,true);
});
test('child controller uses fixed route, verified current scope and no selectors or delegated headers',async()=>{
 let calls=0;const controller=new OwnerLaunchController({resolveOwnerLaunchScope:async()=>({organizationId:context.organizationId,schoolId:context.schoolId,principalId:context.principalId})},{registerGuardianChild:async(c,v)=>{calls++;assert.equal(c.externalSubject,'verified');assert.equal(c.source,'HUMAN_UI');assert.equal(c.principalType,'HUMAN_USER');assert.deepEqual(v,input);return{receipt,replayed:true};}});
 const request={honIdentity:{externalSubject:'verified'},headers:{},query:{}};const response={setHeader(k,v){assert.equal(k,'Cache-Control');assert.equal(v,'private, no-store');},status(n){assert.equal(n,200);}};
 assert.deepEqual((await controller.registerGuardianChild(context.organizationId,context.schoolId,context.idempotencyKey,input,request,response)).data,receipt);
 for(const req of [{...request,query:{familyId:id('c')}},{...request,headers:{'x-hon-source':'HUMAN_UI'}},{...request,headers:{'x-hon-action-request-id':id('c')}},{...request,headers:{'x-hon-delegated-by-principal-id':id('c')}}])await assert.rejects(()=>controller.registerGuardianChild(context.organizationId,context.schoolId,context.idempotencyKey,input,req,response),status(400));
 await assert.rejects(()=>controller.registerGuardianChild(id('c'),context.schoolId,context.idempotencyKey,input,request,response),status(403));assert.equal(calls,1);
 assert.equal(Reflect.getMetadata('path',OwnerLaunchController.prototype.registerGuardianChild),'organizations/:organizationId/schools/:schoolId/guardian-child-registrations');
 assert(Reflect.getMetadata('__guards__',OwnerLaunchController.prototype.registerGuardianChild).includes(OwnerLaunchGuardianChildHumanUiGuard));
 assert(Reflect.getMetadata('__guards__',OwnerLaunchController.prototype.register).includes(OwnerLaunchHumanUiGuard));
});
test('the fixed child CSRF marker cannot authorize the adult route or vice versa',()=>{
 const prior=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example.test';
 const run=(Guard,headers)=>new Guard().canActivate({switchToHttp:()=>({getRequest:()=>({method:'POST',headers})})});
 const headers={origin:'https://hon.example.test','sec-fetch-site':'same-origin','content-type':'application/json','x-hon-human-command':'owner-launch-guardian-child-registration'};
 try{assert.equal(run(OwnerLaunchGuardianChildHumanUiGuard,headers),true);assert.throws(()=>run(OwnerLaunchHumanUiGuard,headers));for(const patch of [{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'},{'x-hon-human-command':'owner-launch-student-registration'},{'content-type':'text/plain'}])assert.throws(()=>run(OwnerLaunchGuardianChildHumanUiGuard,{...headers,...patch}));}finally{if(prior===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=prior;}
});
test('runtime child command uses exactly one transaction-scoped fixed SQL function, no raw writes',async()=>{
 const seen=[];const db=new RuntimeDatabaseService();db.withTenantTransaction=async(c,work)=>{assert.deepEqual(c,context);return work({query:async(sql,args)=>{seen.push([sql,args]);return{rows:[{data:{receipt,replayed:false}}]};}});};
 assert.deepEqual(await db.ownerLaunchGuardianChildCommand(context,input),{receipt,replayed:false});assert.match(seen.at(-1)[0],/^SELECT hon.register_owner_launch_guardian_child\(/);assert.equal(seen.at(-1)[1][0],'verified');assert(seen.some(([sql])=>sql.includes("set_config('app.hon_delegated_by_principal_id'")));assert(seen.every(([sql])=>!/(INSERT INTO|UPDATE|DELETE FROM|http|outbox)/i.test(sql)));
});
