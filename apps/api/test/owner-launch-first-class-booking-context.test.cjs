require('reflect-metadata');
const assert=require('node:assert/strict');const {test}=require('node:test');
const {OwnerLaunchService}=require('../dist/owner-launch/owner-launch.service.js');
const {OwnerLaunchController}=require('../dist/owner-launch/owner-launch.controller.js');
const {OwnerLaunchHumanUiGuard}=require('../dist/owner-launch/owner-launch-human-ui.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope={organizationId:id('1'),schoolId:id('2'),principalId:id('3')};
const context={...scope,requestId:id('4'),correlationId:id('4'),idempotencyKey:'read:'+id('4'),externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI'};
const saved={registrationId:id('5'),student:{studentProfileId:id('6'),displayName:'Saved Student'},classSession:{id:id('7'),name:'First class',startsAt:'2027-01-01T10:00:00.000Z',endsAt:'2027-01-01T11:00:00.000Z',status:'SCHEDULED',capacity:10,bookingPolicy:'OPTIONAL_BOOKING'},booking:{id:id('8'),bookingKind:'REGULAR',status:'BOOKED',version:1,recordedAt:'2026-10-16T00:00:00.000Z'}};
const projection={state:'RECORDED_BOOKING',context:saved};const status=n=>e=>e.getStatus()===n;
test('service parses exact redacted current canonical context and rejects nonhuman/delegated/action before persistence',async()=>{
 let calls=0;const service=new OwnerLaunchService({readOwnerLaunchFirstClassBookingContext:async c=>{calls++;assert.deepEqual(c,context);return projection;}});
 assert.deepEqual(await service.readFirstClassBookingContext(context),projection);
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{delegatedByPrincipalId:id('9')},{actionRequestId:id('9')}])await assert.rejects(()=>service.readFirstClassBookingContext({...context,...patch}),status(403));assert.equal(calls,1);
 for(const state of ['NO_RECORDED_BOOKING','BOOKING_UNAVAILABLE'])assert.deepEqual(await new OwnerLaunchService({readOwnerLaunchFirstClassBookingContext:async()=>({state,context:null})}).readFirstClassBookingContext(context),{state,context:null});
 for(const field of ['guardian','familyId','birthDate','contact','roster','attendance','membership','billing','payment','provider','eligibility','parentAccess','communication'])await assert.rejects(()=>new OwnerLaunchService({readOwnerLaunchFirstClassBookingContext:async()=>({...projection,context:{...saved,[field]:id('9')}})}).readFirstClassBookingContext(context),status(503));
 for(const [code,n]of [['42501',403],['P0002',503],['XX000',503]])await assert.rejects(()=>new OwnerLaunchService({readOwnerLaunchFirstClassBookingContext:async()=>{throw{code};}}).readFirstClassBookingContext(context),e=>status(n)(e)&&e.getResponse().code==='BOOKING_'+(n===403?'FORBIDDEN':'UNAVAILABLE'));
});
test('fixed selector-free no-store GET derives scope and refuses any input, query, source or command marker',async()=>{
 let reads=0,scopes=0;const controller=new OwnerLaunchController({resolveOwnerLaunchScope:async subject=>{scopes++;assert.equal(subject,'verified');return scope;}},{readFirstClassBookingContext:async c=>{reads++;assert.equal(c.externalSubject,'verified');assert.equal(c.source,'HUMAN_UI');assert.equal(c.principalType,'HUMAN_USER');return projection;}});
 const request={honIdentity:{externalSubject:'verified'},method:'GET',headers:{'sec-fetch-site':'same-origin'},query:{}};
 const response={setHeader(k,v){assert.equal(k,'Cache-Control');assert.equal(v,'private, no-store');}};
 assert.deepEqual(await controller.firstClassBookingContext(request,response),{data:projection});
 assert.equal(Reflect.getMetadata('path',OwnerLaunchController.prototype.firstClassBookingContext),'owner-launch/first-class-booking-context');assert.equal(Reflect.getMetadata('method',OwnerLaunchController.prototype.firstClassBookingContext),0);
 for(const key of ['registrationId','studentProfileId','classSessionId','programId','familyId','schoolId','bookingId']){
  await assert.rejects(()=>controller.firstClassBookingContext({...request,query:{[key]:id('9')}},response),status(400));
  await assert.rejects(()=>controller.firstClassBookingContext({...request,body:{[key]:id('9')}},response),status(400));
 }
 for(const h of ['x-hon-source','x-hon-human-command','idempotency-key','x-hon-action-request-id','x-hon-delegated-by-principal-id'])await assert.rejects(()=>controller.firstClassBookingContext({...request,headers:{[h]:id('9')}},response),status(400));
 for(const body of [{},[],''])await assert.rejects(()=>controller.firstClassBookingContext({...request,body},response),status(400));
 for(const h of ['x-hon-human-command','x-hon-source','x-hon-action-request-id','x-hon-delegated-by-principal-id'])await assert.rejects(()=>controller.firstClassBookingContext({...request,headers:{[h]:''}},response),status(400));
 assert.equal(reads,1);assert.equal(scopes,1);
 const guard=new OwnerLaunchHumanUiGuard();assert.equal(guard.canActivate({switchToHttp:()=>({getRequest:()=>request})}),true);
 for(const site of ['cross-site','same-site'])assert.throws(()=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({...request,headers:{'sec-fetch-site':site}})})}));
 await assert.rejects(()=>new OwnerLaunchController({resolveOwnerLaunchScope:async()=>undefined},{}).firstClassBookingContext(request,response),status(403));
});
test('runtime read uses an ordinary tenant transaction solely for IAM locks and the subject-only fixed function',async()=>{
 const seen=[];const db=new RuntimeDatabaseService();db.withTenantTransaction=async(c,work)=>{assert.deepEqual(c,context);return work({query:async(sql,args)=>{seen.push([sql,args]);return{rows:[{data:projection}]};}});};
 assert.deepEqual(await db.readOwnerLaunchFirstClassBookingContext(context),projection);
 assert.deepEqual(seen.at(-1),['SELECT hon.read_owner_launch_first_class_booking_context($1) data',['verified']]);
 assert(seen.some(([sql])=>sql.includes('app.hon_external_subject')));assert(seen.some(([sql])=>sql.includes('app.hon_delegated_by_principal_id')));
 assert(seen.every(([sql])=>!/(INSERT INTO|UPDATE|DELETE FROM|audit_events|outbox_events|idempotency_records|class_bookings|attendance_records)\b/i.test(sql)));
});
