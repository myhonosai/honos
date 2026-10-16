require('reflect-metadata');
const assert=require('node:assert/strict');const {test}=require('node:test');
const {OwnerLaunchService}=require('../dist/owner-launch/owner-launch.service.js');
const {OwnerLaunchController}=require('../dist/owner-launch/owner-launch.controller.js');
const {OwnerLaunchHumanUiGuard}=require('../dist/owner-launch/owner-launch-human-ui.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const context={organizationId:id('1'),schoolId:id('2'),principalId:id('3'),requestId:id('4'),correlationId:id('4'),idempotencyKey:'read:'+id('4'),externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI'};
const receipt={registrationId:id('5'),membershipId:id('6'),state:'DRAFT',membershipVersion:1,planCode:'OPAQUE',termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z',currency:'USD',recordedAt:'2026-10-16T00:00:00.000Z'};
const projection={state:'RECORDED_DRAFT',receipt};const status=n=>e=>e.getStatus()===n;
test('confirmation service accepts exact redacted DRAFT only and truthful empty/unavailable without mutating',async()=>{
 let calls=0;const service=new OwnerLaunchService({readOwnerLaunchMembershipDraft:async c=>{calls++;assert.deepEqual(c,context);return projection;}});
 assert.deepEqual(await service.readMembershipDraft(context),projection);
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{delegatedByPrincipalId:id('7')},{actionRequestId:id('7')}])await assert.rejects(()=>service.readMembershipDraft({...context,...patch}),status(403));assert.equal(calls,1);
 for(const state of ['NO_RECORDED_DRAFT','DRAFT_UNAVAILABLE'])assert.deepEqual(await new OwnerLaunchService({readOwnerLaunchMembershipDraft:async()=>({state,receipt:null})}).readMembershipDraft(context),{state,receipt:null});
 for(const patch of [{billingAccountCreated:true},{billingAccountId:id('7')},{payerPersonId:id('7')},{participantPersonId:id('7')},{state:'ACTIVE'},{state:'CANCELLED'},{membershipVersion:0},{invoiceId:id('7')},{schedule:{}},{policyVersion:1},{source:'HUMAN_UI'}])await assert.rejects(()=>new OwnerLaunchService({readOwnerLaunchMembershipDraft:async()=>({state:'RECORDED_DRAFT',receipt:{...receipt,...patch}})}).readMembershipDraft(context),status(503));
 for(const [code,n]of [['42501',403],['P0002',503],['XX000',503]])await assert.rejects(()=>new OwnerLaunchService({readOwnerLaunchMembershipDraft:async()=>{throw{code};}}).readMembershipDraft(context),e=>status(n)(e)&&e.getResponse().code==='MEMBERSHIP_DRAFT_'+(n===403?'FORBIDDEN':'UNAVAILABLE'));
});
test('fixed GET derives live scope and rejects selectors/source/action/delegation without command marker',async()=>{
 let scopes=0,reads=0;const controller=new OwnerLaunchController({resolveOwnerLaunchScope:async sub=>{scopes++;assert.equal(sub,'verified');return{organizationId:context.organizationId,schoolId:context.schoolId,principalId:context.principalId};}},{readMembershipDraft:async c=>{reads++;assert.equal(c.externalSubject,'verified');assert.equal(c.source,'HUMAN_UI');assert.equal(c.principalType,'HUMAN_USER');return projection;}});
 const request={honIdentity:{externalSubject:'verified'},method:'GET',headers:{'sec-fetch-site':'same-origin'},query:{}};
 const response={setHeader(k,v){assert.equal(k,'Cache-Control');assert.equal(v,'private, no-store');}};
 assert.deepEqual(await controller.membershipDraft(request,response),{data:projection});
 assert.equal(Reflect.getMetadata('path',OwnerLaunchController.prototype.membershipDraft),'owner-launch/membership-draft');assert.equal(Reflect.getMetadata('method',OwnerLaunchController.prototype.membershipDraft),0);
 for(const req of [{...request,query:{registrationId:id('7')}},{...request,query:{membershipId:id('7')}},{...request,query:{schoolId:id('7')}},...['x-hon-source','x-hon-action-request-id','x-hon-delegated-by-principal-id'].map(h=>({...request,headers:{[h]:id('7')}}))])await assert.rejects(()=>controller.membershipDraft(req,response),status(400));
 assert.equal(reads,1);assert.equal(scopes,1);
 const guard=new OwnerLaunchHumanUiGuard();assert.equal(guard.canActivate({switchToHttp:()=>({getRequest:()=>request})}),true);
 assert.throws(()=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({...request,headers:{'sec-fetch-site':'cross-site'}})})}));
 const denied=new OwnerLaunchController({resolveOwnerLaunchScope:async()=>undefined},{});await assert.rejects(()=>denied.membershipDraft(request,response),status(403));
});
test('runtime confirmation passes external subject only to a fixed definer, scoped human context and no mutation',async()=>{
 const seen=[];const db=new RuntimeDatabaseService();db.withTenantTransaction=async(c,work)=>{assert.deepEqual(c,context);return work({query:async(sql,args)=>{seen.push([sql,args]);return{rows:[{data:projection}]};}});};
 assert.deepEqual(await db.readOwnerLaunchMembershipDraft(context),projection);
 assert.equal(seen.at(-1)[0],'SELECT hon.read_owner_launch_membership_draft($1) data');assert.deepEqual(seen.at(-1)[1],['verified']);
 assert(seen.some(([sql])=>sql.includes('app.hon_external_subject')));assert(seen.some(([sql])=>sql.includes('app.hon_delegated_by_principal_id')));assert(seen.every(([sql])=>!/(INSERT INTO|UPDATE|DELETE FROM|audit_events|outbox_events|idempotency_records|memberships)\b/i.test(sql)));
});
