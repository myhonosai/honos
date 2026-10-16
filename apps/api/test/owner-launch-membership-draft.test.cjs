require('reflect-metadata');
const assert=require('node:assert/strict');const {test}=require('node:test');
const {OwnerLaunchService}=require('../dist/owner-launch/owner-launch.service.js');
const {OwnerLaunchController}=require('../dist/owner-launch/owner-launch.controller.js');
const {OwnerLaunchMembershipDraftHumanUiGuard,OwnerLaunchFirstClassBookingHumanUiGuard}=require('../dist/owner-launch/owner-launch-human-ui.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const context={organizationId:id('1'),schoolId:id('2'),principalId:id('3'),requestId:id('4'),correlationId:id('4'),idempotencyKey:id('5'),externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI'};
const input={registrationId:id('6'),expectedReceiptVersion:1,planCode:'OPAQUE',termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z',currency:'USD'};
const receipt={registrationId:input.registrationId,membershipId:id('7'),state:'DRAFT',membershipVersion:1,planCode:input.planCode,termStartedAt:input.termStartedAt,termEndsAt:input.termEndsAt,currency:'USD',billingAccountCreated:true,recordedAt:'2026-10-16T00:00:00.000Z'};
const status=n=>e=>e.getStatus()===n;
test('membership draft closes selectors, explicit terms/currency and all nonhuman/delegated contexts before database access',async()=>{
 let calls=0;const service=new OwnerLaunchService({draftOwnerLaunchMembership:async(c,v)=>{calls++;assert.deepEqual(c,context);assert.deepEqual(v,input);return{...receipt,replayed:false};}});
 assert.deepEqual(await service.draftMembership(context,input),{receipt,replayed:false});
 for(const patch of [{payerPersonId:id('8')},{participantPersonId:id('8')},{billingAccountId:id('8')},{familyId:id('8')},{programId:id('8')},{classSessionId:id('8')},{schoolId:id('8')},{price:1},{paymentSchedule:{}},{paymentMethodId:id('8')},{activation:true},{invoice:true},{currency:'usd'},{currency:'ZZZ'},{termStartedAt:'2027-01-01T00:00:00+23:59'},{termStartedAt:'0000-01-01T00:00:00Z'},{termEndsAt:'9999-12-31T23:59:59-14:00'},{currency:null},{planCode:' x'},{planCode:'x'.repeat(81)},{expectedReceiptVersion:2},{termEndsAt:input.termStartedAt},{termStartedAt:'2027-02-30T00:00:00.000Z'}])await assert.rejects(()=>service.draftMembership(context,{...input,...patch}),status(400));
 for(const key of Object.keys(input)){const value={...input};delete value[key];await assert.rejects(()=>service.draftMembership(context,value),status(400));}
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{delegatedByPrincipalId:id('8')},{actionRequestId:id('8')}])await assert.rejects(()=>service.draftMembership({...context,...patch},input),status(403));
 for(const key of ['', ' x', 'x'.repeat(201), 'x\n'])await assert.rejects(()=>service.draftMembership({...context,idempotencyKey:key},input),status(409));assert.equal(calls,1);
});
test('membership receipt redaction, exact declaration linkage, replay and honest failures are enforced',async()=>{
 assert.deepEqual(await new OwnerLaunchService({draftOwnerLaunchMembership:async()=>({...receipt,replayed:true})}).draftMembership(context,input),{receipt,replayed:true});
 for(const patch of [{payerPersonId:id('8')},{participantPersonId:id('8')},{billingAccountId:id('8')},{state:'ACTIVE'},{currency:'CAD'},{registrationId:id('8')},{planCode:'OTHER'},{termEndsAt:'2029-01-01T00:00:00.000Z'},{paymentOutcome:'SUCCEEDED'},{membershipVersion:0},{billingAccountCreated:'true'},{replayed:'true'}])await assert.rejects(()=>new OwnerLaunchService({draftOwnerLaunchMembership:async()=>({...receipt,replayed:false,...patch})}).draftMembership(context,input),status(503));
 for(const [code,n]of [['42501',403],['23505',409],['40001',409],['22023',400],['P0002',404],['XX000',503]])await assert.rejects(()=>new OwnerLaunchService({draftOwnerLaunchMembership:async()=>{throw{code};}}).draftMembership(context,input),status(n));
 await assert.rejects(()=>new OwnerLaunchService({draftOwnerLaunchMembership:async()=>{throw{code:'22023',message:'MEMBERSHIP_DRAFT_NEEDS_STAFF'};}}).draftMembership(context,input),e=>e.getResponse().code==='MEMBERSHIP_DRAFT_NEEDS_STAFF');
});
test('membership draft route derives live school scope, has no selector and returns only the redacted receipt',async()=>{
 const calls=[];const controller=new OwnerLaunchController({resolveOwnerLaunchScope:async()=>({organizationId:context.organizationId,schoolId:context.schoolId,principalId:context.principalId})},{draftMembership:async(c,v)=>{calls.push([c,v]);return{receipt,replayed:false};}});
 const response={setHeader(k,v){assert.equal(k,'Cache-Control');assert.equal(v,'private, no-store');},status(n){assert.equal(n,201);}};const request={honIdentity:{externalSubject:'verified'},headers:{},query:{}};
 const result=await controller.draftMembership(context.idempotencyKey,input,request,response);assert.deepEqual(result.data,receipt);assert.deepEqual(calls[0][1],input);assert.equal(calls[0][0].schoolId,context.schoolId);assert.equal(calls[0][0].source,'HUMAN_UI');
 assert.equal(Reflect.getMetadata('path',OwnerLaunchController.prototype.draftMembership),'owner-launch/membership-draft');
 for(const req of [{...request,query:{schoolId:id('8')}},{...request,headers:{'x-hon-action-request-id':id('8')}},{...request,headers:{'x-hon-delegated-by-principal-id':id('8')}},{...request,headers:{'x-hon-source':'AI'}}])await assert.rejects(()=>controller.draftMembership(context.idempotencyKey,input,req,response),status(400));
 await assert.rejects(()=>controller.draftMembership(undefined,input,request,response),status(400));assert.equal(calls.length,1);
});
test('membership marker requires exact configured origin/JSON and cannot authorize booking',()=>{
 const prior=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example.test';
 const headers={origin:'https://hon.example.test','sec-fetch-site':'same-origin','content-type':'application/json','x-hon-human-command':'owner-launch-membership-draft'};
 const run=(h,Guard=OwnerLaunchMembershipDraftHumanUiGuard)=>new Guard().canActivate({switchToHttp:()=>({getRequest:()=>({method:'POST',headers:h})})});
 try{assert.equal(run(headers),true);for(const patch of [{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'},{'x-hon-human-command':'owner-launch-first-class-booking'},{'x-hon-human-command':undefined}])assert.throws(()=>run({...headers,...patch}));assert.throws(()=>run(headers,OwnerLaunchFirstClassBookingHumanUiGuard));}finally{if(prior===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=prior;}
});
test('membership runtime adapter uses only one fixed definer with scoped context, not raw billing mutation',async()=>{
 const seen=[];const db=new RuntimeDatabaseService();db.withTenantTransaction=async(c,work)=>{assert.deepEqual(c,context);return work({query:async(sql,args)=>{seen.push([sql,args]);return{rows:[{data:{...receipt,replayed:false}}]};}});};
 assert.deepEqual(await db.draftOwnerLaunchMembership(context,input),{...receipt,replayed:false});assert.match(seen.at(-1)[0],/^SELECT hon\.draft_owner_launch_membership\(/);assert.deepEqual(seen.at(-1)[1],['verified',JSON.stringify(input),context.idempotencyKey,context.requestId,context.correlationId]);assert(seen.some(([sql])=>sql.includes("app.hon_delegated_by_principal_id")));assert(seen.every(([sql])=>!/(INSERT INTO|UPDATE|DELETE FROM) hon\./i.test(sql)));
});
