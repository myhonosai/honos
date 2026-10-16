require('reflect-metadata');
const assert=require('node:assert/strict');const {test}=require('node:test');
const {OwnerLaunchService}=require('../dist/owner-launch/owner-launch.service.js');
const {OwnerLaunchController}=require('../dist/owner-launch/owner-launch.controller.js');
const {OwnerLaunchHumanUiGuard,OwnerLaunchFirstClassBookingHumanUiGuard}=require('../dist/owner-launch/owner-launch-human-ui.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const {spawnSync}=require('node:child_process');const {join}=require('node:path');
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const context={organizationId:id('1'),schoolId:id('2'),principalId:id('3'),requestId:id('4'),correlationId:id('4'),idempotencyKey:id('5'),externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI'};
const input={programId:id('6'),expectedProgramVersion:1,classSessionId:id('7'),expectedClassSessionVersion:1,givenName:'Adult',familyName:'Student',birthDate:'1990-02-03',attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED'};
const receipt={registrationId:id('8'),studentProfileId:id('9'),enrollmentId:id('a'),programId:input.programId,classSessionId:input.classSessionId,status:'REGISTERED_NO_BOOKING',createdAt:'2026-10-16T00:00:00.000Z'};
const bookingInput={registrationId:receipt.registrationId,expectedReceiptVersion:1,expectedClassSessionVersion:1};
const bookingReceipt={registrationId:receipt.registrationId,bookingId:id('e'),classSessionId:input.classSessionId,status:'BOOKED',bookingVersion:1,recordedAt:'2026-10-16T00:00:00.000Z'};
const savedStudents={organizationId:context.organizationId,schoolId:context.schoolId,state:'RECORDED_REGISTRATIONS',registrations:[{registrationId:id('b'),studentProfileId:id('c'),displayName:'Saved Student',createdAt:'2026-10-16T00:00:00.000Z',registrationKind:'NEW_ADULT_NO_GUARDIAN',status:'REGISTERED_NO_BOOKING'}]};
const status=n=>e=>e.getStatus()===n;
test('registration service uses one narrow command; closes unexpected input and authority',async()=>{
 let calls=0;const service=new OwnerLaunchService({ownerLaunchCommand:async(c,value)=>{calls++;assert.deepEqual(c,context);assert.deepEqual(value,input);return{receipt,replayed:false};}});
 assert.deepEqual(await service.register(context,input),{receipt,replayed:false});
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{delegatedByPrincipalId:id('b')},{actionRequestId:id('b')}])await assert.rejects(()=>service.register({...context,...patch},input),status(403));
 for(const patch of [{guardianId:id('b')},{schoolId:id('2')},{parentLogin:true},{tier:'COMPLETE'},{givenName:''},{expectedProgramVersion:0},{birthDate:'2026-02-30'}])await assert.rejects(()=>service.register(context,{...input,...patch}),status(400));
 await assert.rejects(()=>service.register({...context,idempotencyKey:''},input),status(409));assert.equal(calls,1);
});
test('registration validates receipt and maps denial/conflict/needs-staff/unknown honestly',async()=>{
	for(const patch of [{email:'private'},{status:'BOOKED'},{programId:id('b')},{classSessionId:id('c')}])await assert.rejects(()=>new OwnerLaunchService({ownerLaunchCommand:async()=>({receipt:{...receipt,...patch},replayed:false})}).register(context,input),status(503));
	for(const [code,n]of [['42501',403],['23505',409],['40001',409],['22023',400],['P0002',404],['XX000',503]])await assert.rejects(()=>new OwnerLaunchService({ownerLaunchCommand:async()=>{throw{code};}}).register(context,input),status(n));
	await assert.rejects(()=>new OwnerLaunchService({ownerLaunchCommand:async()=>{throw{code:'22023',message:'REGISTRATION_NEEDS_STAFF'};}}).register(context,input),e=>e.getResponse().code==='REGISTRATION_NEEDS_STAFF');
});
test('saved-student confirmation is direct-human, bounded, and rejects any directory/private output',async()=>{
 let calls=0;const service=new OwnerLaunchService({readOwnerLaunchSavedStudents:async(c)=>{calls++;assert.deepEqual(c,context);return savedStudents;}});
 assert.deepEqual(await service.readSavedStudents(context),savedStudents);
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{delegatedByPrincipalId:id('d')},{actionRequestId:id('d')}])await assert.rejects(()=>service.readSavedStudents({...context,...patch}),status(403));
 for(const patch of [{registrations:[{...savedStudents.registrations[0],familyId:id('d')}]},{registrations:[{...savedStudents.registrations[0],email:'private'}]},{state:'NO_RECORDED_REGISTRATIONS'}])await assert.rejects(()=>new OwnerLaunchService({readOwnerLaunchSavedStudents:async()=>({...savedStudents,...patch})}).readSavedStudents(context),status(503));
 assert.equal(calls,1);
});
test('first-class booking is receipt-only, direct-human, and returns no membership/payment/attendance/parent success fields',async()=>{
 let calls=0;const service=new OwnerLaunchService({bookOwnerLaunchFirstClass:async(c,value)=>{calls++;assert.deepEqual(c,context);assert.deepEqual(value,bookingInput);return{...bookingReceipt,replayed:false};}});
 assert.deepEqual(await service.bookFirstClass(context,bookingInput),{receipt:bookingReceipt,replayed:false});
 for(const patch of [{studentProfileId:id('d')},{familyId:id('d')},{programId:id('d')},{classSessionId:id('d')},{schoolId:id('d')},{expectedReceiptVersion:2},{expectedClassSessionVersion:0}])await assert.rejects(()=>service.bookFirstClass(context,{...bookingInput,...patch}),status(400));
 for(const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{delegatedByPrincipalId:id('d')},{actionRequestId:id('d')}])await assert.rejects(()=>service.bookFirstClass({...context,...patch},bookingInput),status(403));
 for(const patch of [{studentProfileId:id('d')},{status:'CHECKED_IN'},{paymentOutcome:'SUCCEEDED'},{attendanceOutcome:'PRESENT'},{parentContacted:true}])await assert.rejects(()=>new OwnerLaunchService({bookOwnerLaunchFirstClass:async()=>({...bookingReceipt,...patch,replayed:false})}).bookFirstClass(context,bookingInput),status(503));
 for(const [code,n]of [['42501',403],['23505',409],['40001',409],['22023',400],['P0002',404],['XX000',503]])await assert.rejects(()=>new OwnerLaunchService({bookOwnerLaunchFirstClass:async()=>{throw{code};}}).bookFirstClass(context,bookingInput),status(n));
 assert.equal(calls,1);
});
test('controller derives one live scope and rejects selectors, foreign IDs and missing identity',async()=>{
 const calls=[];const controller=new OwnerLaunchController({resolveOwnerLaunchScope:async sub=>{assert.equal(sub,'verified');return{organizationId:context.organizationId,schoolId:context.schoolId,principalId:context.principalId};}},{register:async(c,v)=>{calls.push([c,v]);return{receipt,replayed:false};}});
 const response={setHeader(){},status(n){assert.equal(n,201);}};
 const request={honIdentity:{externalSubject:'verified'},headers:{},query:{}};
 const output=await controller.register(context.organizationId,context.schoolId,context.idempotencyKey,input,request,response);assert.deepEqual(output.data,receipt);assert.equal(calls[0][0].principalType,'HUMAN_USER');assert.equal(calls[0][0].source,'HUMAN_UI');assert.equal(calls[0][0].externalSubject,'verified');
 for(const req of [{...request,query:{schoolId:context.schoolId}},{...request,headers:{'x-hon-action-request-id':id('b')}},{...request,headers:{'x-hon-delegated-by-principal-id':id('b')}}])await assert.rejects(()=>controller.register(context.organizationId,context.schoolId,context.idempotencyKey,input,req,response),status(400));
	await assert.rejects(()=>controller.register(id('b'),context.schoolId,context.idempotencyKey,input,request,response),status(403));await assert.rejects(()=>controller.register(context.organizationId,context.schoolId,context.idempotencyKey,input,{headers:{}},response),status(403));assert.equal(calls.length,1);
});
test('saved-student GET has no selector and derives the same current direct-human scope',async()=>{
 const calls=[];const controller=new OwnerLaunchController({resolveOwnerLaunchScope:async()=>({organizationId:context.organizationId,schoolId:context.schoolId,principalId:context.principalId})},{readSavedStudents:async c=>{calls.push(c);return savedStudents;}});
 const response={setHeader(name,value){assert.equal(name,'Cache-Control');assert.equal(value,'private, no-store');}};
 const request={honIdentity:{externalSubject:'verified'},headers:{},query:{}};
 assert.deepEqual(await controller.savedStudents(request,response),{data:savedStudents});
 await assert.rejects(()=>controller.savedStudents({...request,query:{schoolId:context.schoolId}},response),status(400));
 await assert.rejects(()=>controller.savedStudents({...request,headers:{'x-hon-delegated-by-principal-id':id('d')}},response),status(400));
 assert.equal(calls.length,1);assert.equal(calls[0].organizationId,context.organizationId);
});
test('first-class booking has one fixed receipt-only route with no school path or query selector',async()=>{
 const calls=[];const controller=new OwnerLaunchController({resolveOwnerLaunchScope:async()=>({organizationId:context.organizationId,schoolId:context.schoolId,principalId:context.principalId})},{bookFirstClass:async(c,v)=>{calls.push([c,v]);return{receipt:bookingReceipt,replayed:false};}});
 const response={setHeader(k,v){assert.equal(k,'Cache-Control');assert.equal(v,'private, no-store');},status(n){assert.equal(n,201);}};const request={honIdentity:{externalSubject:'verified'},headers:{},query:{}};
 const output=await controller.bookFirstClass(context.idempotencyKey,bookingInput,request,response);assert.deepEqual(output.data,bookingReceipt);assert.deepEqual(calls[0][1],bookingInput);assert.equal(calls[0][0].schoolId,context.schoolId);
 for(const req of [{...request,query:{schoolId:context.schoolId}},{...request,headers:{'x-hon-action-request-id':id('d')}},{...request,headers:{'x-hon-delegated-by-principal-id':id('d')}}])await assert.rejects(()=>controller.bookFirstClass(context.idempotencyKey,bookingInput,req,response),status(400));
 assert.equal(Reflect.getMetadata('path',OwnerLaunchController.prototype.bookFirstClass),'owner-launch/first-class-booking');assert.equal(calls.length,1);
});
test('registration CSRF guard requires configured exact public origin and explicit direct-human marker',()=>{
 const prior=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example.test';
 const run=(method,headers)=>new OwnerLaunchHumanUiGuard().canActivate({switchToHttp:()=>({getRequest:()=>({method,headers})})});
 try{assert.equal(run('GET',{'sec-fetch-site':'same-origin'}),true);const headers={origin:'https://hon.example.test','sec-fetch-site':'same-origin','content-type':'application/json','x-hon-human-command':'owner-launch-student-registration'};assert.equal(run('POST',headers),true);for(const patch of [{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'},{'x-hon-human-command':'other'},{'content-type':'text/plain'}])assert.throws(()=>run('POST',{...headers,...patch}));assert.throws(()=>run('GET',{'sec-fetch-site':'cross-site'}));}finally{if(prior===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=prior;}
});
test('first-class booking marker cannot authorize registration commands',()=>{
 const prior=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example.test';const headers={origin:'https://hon.example.test','sec-fetch-site':'same-origin','content-type':'application/json','x-hon-human-command':'owner-launch-first-class-booking'};
 try{assert.equal(new OwnerLaunchFirstClassBookingHumanUiGuard().canActivate({switchToHttp:()=>({getRequest:()=>({method:'POST',headers})})}),true);assert.throws(()=>new OwnerLaunchHumanUiGuard().canActivate({switchToHttp:()=>({getRequest:()=>({method:'POST',headers})})}));}finally{if(prior===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=prior;}
});
test('runtime adapter uses fixed functions and transaction-scoped context, never raw mutation',async()=>{
	const seen=[];const db=new RuntimeDatabaseService();db.withTenantTransaction=async(c,work)=>work({query:async(sql,args)=>{seen.push([sql,args]);return{rows:[{data:{receipt,replayed:false}}]};}});
	assert.deepEqual(await db.ownerLaunchCommand(context,input),{receipt,replayed:false});assert.match(seen.at(-1)[0],/^SELECT hon.register_owner_launch_student/);assert.equal(seen.at(-1)[1][0],'verified');assert(seen.every(([sql])=>!/(INSERT INTO|UPDATE|DELETE FROM) hon\./.test(sql)));
});
test('saved-student runtime adapter calls only the selector-free fixed reader',async()=>{
 const seen=[];const db=new RuntimeDatabaseService();db.withTenantTransaction=async(c,work)=>work({query:async(sql,args)=>{seen.push([sql,args]);return{rows:[{data:savedStudents}]};}});
 assert.deepEqual(await db.readOwnerLaunchSavedStudents(context),savedStudents);assert.match(seen.at(-1)[0],/^SELECT hon\.read_owner_launch_saved_students\(\$1\)/);assert.deepEqual(seen.at(-1)[1],['verified']);assert(seen.every(([sql])=>!/(INSERT INTO|UPDATE|DELETE FROM) hon\./.test(sql)));
});
test('first-class booking runtime adapter calls only the fixed receipt wrapper',async()=>{
 const seen=[];const db=new RuntimeDatabaseService();db.withTenantTransaction=async(c,work)=>work({query:async(sql,args)=>{seen.push([sql,args]);return{rows:[{data:{...bookingReceipt,replayed:false}}]};}});
 assert.deepEqual(await db.bookOwnerLaunchFirstClass(context,bookingInput),{...bookingReceipt,replayed:false});assert.match(seen.at(-1)[0],/^SELECT hon\.book_owner_launch_first_class\(/);assert.equal(seen.at(-1)[1][0],'verified');assert(seen.every(([sql])=>!/(INSERT INTO|UPDATE|DELETE FROM) hon\.(class_bookings|student_profiles|families)/i.test(sql)));
});
test('local fixture refuses remote targets, provider/execution credentials and unsafe output paths before writes',()=>{
 const script=join(__dirname,'../../../packages/database/scripts/setup-owner-launch-validation.mjs');
 const base={PATH:process.env.PATH,HOME:'/home/ubuntu',LANG:'C.UTF-8',HON_OWNER_LAUNCH_VALIDATION_TARGET:'postgresql://localhost:5432/hon_owner_launch_validation',HON_OWNER_LAUNCH_ENV_FILE:'/home/ubuntu/jobs/owner-invalid.env'};
 for(const patch of [{HON_OWNER_LAUNCH_VALIDATION_TARGET:'postgresql://remote.test:5432/real'},{HON_OWNER_LAUNCH_ENV_FILE:'/tmp/private.env'},{HON_PROVIDER_KEY:'SENTINEL_SECRET'},{HON_ACTION_ENGINE_ENABLED:'1'},{STRIPE_SECRET_KEY:'SENTINEL_SECRET'},{HON_OWNER_LAUNCH_ENV_FILE:'/home/ubuntu/jobs/../outside.env'}]){const result=spawnSync(process.execPath,[script],{env:{...base,...patch},encoding:'utf8'});assert.notEqual(result.status,0);assert(!result.stderr.includes('SENTINEL_SECRET'));}
});
