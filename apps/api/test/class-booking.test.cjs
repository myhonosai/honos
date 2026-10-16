const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
require('reflect-metadata');
const { ClassBookingService } = require('../dist/schedule/class-booking.service.js');
const { ClassBookingController } = require('../dist/schedule/class-booking.controller.js');
const organizationId=randomUUID(),schoolId=randomUUID(),principalId=randomUUID(),sessionId=randomUUID(),studentProfileId=randomUUID();
const scope={organizationId,schoolId,principalId};
const context=(patch={})=>{const id=randomUUID();return {...scope,externalSubject:'verified-subject',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:randomUUID(),...patch};};
const input={studentProfileId,bookingKind:'REGULAR'};
const status=n=>e=>e.getStatus?.()===n;
function fixture(options={}) {
 const calls=[];
 const session={id:sessionId,capacity:1,bookingPolicy:options.policy??'WALK_IN',status:options.sessionStatus??'SCHEDULED'};
 const client={query:async(sql,args)=>{
  calls.push([sql,args]);
  if(sql.includes('INSERT INTO hon.idempotency_records'))return{rows:options.replay?[]:[{id:randomUUID()}],rowCount:options.replay?0:1};
  if(sql.includes('FROM hon.idempotency_records'))return{rows:[{request_fingerprint:createHash('sha256').update(JSON.stringify({sessionId,...input})).digest('hex'),status:'COMPLETED',response_body:{id:'historical'}}],rowCount:1};
  if(sql.includes('hon.lock_class_booking_session')){if(options.lockError)throw Object.assign(new Error('SQL_SECRET'),{code:options.lockError});return{rows:options.missing?[]:[session],rowCount:options.missing?0:1};}
  if(sql.includes('FROM hon.student_profiles'))return{rows:[{id:studentProfileId}],rowCount:1};
  if(sql.includes('FROM hon.class_bookings'))return sql.includes('count(*)')?{rows:[{count:'2'}],rowCount:1}:{rows:[],rowCount:0};
  if(sql.includes('INSERT INTO hon.class_bookings'))return{rows:[{id:randomUUID(),classSessionId:sessionId,studentProfileId,bookingKind:'REGULAR',status:args[5],source:'STAFF',bookedAt:'2026-10-16T00:00:00.000Z',version:1,createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z'}],rowCount:1};
  return{rows:[],rowCount:1};
 }};
 const database={resolveAuthorizedScope:async(...args)=>{calls.push(['resolve',args]);return options.scope===undefined?scope:options.scope;},withTenantTransaction:async(c,work)=>work(client)};
 return{service:new ClassBookingService(database),calls};
}
test('generic booking denies missing subject, AI, delegated and action contexts before persistence',async()=>{
 let calls=0;const service=new ClassBookingService({resolveAuthorizedScope:async()=>{calls++;},withTenantTransaction:async()=>{calls++;}});
 for(const patch of [{externalSubject:undefined},{externalSubject:''},{principalType:'AI_EMPLOYEE'},{source:'AI'},{source:'AUTOMATION'},{source:'API'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])await assert.rejects(()=>service.create(context(patch),sessionId,input),status(403));
 await assert.rejects(()=>service.create(context(),sessionId,{...input,bookingKind:'CLASS_PASS'}),status(400));assert.equal(calls,0);
});
test('generic preflight verifies subject against exact resolved principal, school and organization',async()=>{
 for(const resolved of [null,{...scope,principalId:randomUUID()},{...scope,schoolId:randomUUID()},{...scope,organizationId:randomUUID()}]){
  const {service,calls}=fixture({scope:resolved});await assert.rejects(()=>service.create(context(),sessionId,input),status(403));assert.equal(calls.length,1);assert.deepEqual(calls[0],['resolve',['verified-subject',schoolId,'schedule.booking.manage']]);
 }
});
test('generic WALK_IN still overbooks and required policy still waitlists, using only exact definer session locking',async()=>{
 for(const policy of ['WALK_IN','REQUIRED_BOOKING','OPTIONAL_BOOKING']){
  const {service,calls}=fixture({policy});const result=await service.create(context(),sessionId,input);
  assert.equal(result.booking.status,policy==='WALK_IN'?'BOOKED':'WAITLISTED');assert.equal(result.booking.activeSeatCount,policy==='WALK_IN'?3:2);assert.equal(result.booking.sessionCapacity,1);
  assert(calls.some(([sql,args])=>sql.includes('FROM hon.lock_class_booking_session')&&args[0]==='verified-subject'&&args[1]===sessionId));
  assert(calls.some(([sql,args])=>sql.includes("set_config('app.hon_external_subject'")&&args[1]==='verified-subject'));
  assert(!calls.some(([sql])=>sql.includes('FROM hon.class_sessions')));
 }
});
test('generic lock maps forbidden/missing and retains cancelled-session rejection',async()=>{
 for(const[options,code]of [[{lockError:'42501'},403],[{missing:true},404],[{sessionStatus:'CANCELLED'},409]]){
  const {service}=fixture(options);await assert.rejects(()=>service.create(context(),sessionId,input),status(code));
 }
});
test('saved generic receipts still require live in-transaction session-lock authorization after idempotency lock',async()=>{
 const {service,calls}=fixture({replay:true});assert.deepEqual(await service.create(context(),sessionId,input),{booking:{id:'historical'},created:false,replayed:true});
 assert(calls.findIndex(([s])=>s.includes('FROM hon.idempotency_records'))<calls.findIndex(([s])=>s.includes('FROM hon.lock_class_booking_session')));
 const revoked=fixture({replay:true,lockError:'42501'});await assert.rejects(()=>revoked.service.create(context(),sessionId,input),status(403));
});
test('generic controller supplies only the verified external subject and exact human authority',async()=>{
 const calls=[];const controller=new ClassBookingController({resolveAuthorizedScope:async(...args)=>{calls.push(args);return scope;}},{create:async(c,id,body)=>{assert.equal(c.externalSubject,'verified-subject');assert.equal(c.principalId,principalId);assert.equal(c.principalType,'HUMAN_USER');assert.equal(c.source,'HUMAN_UI');assert(!c.actionRequestId&&!c.delegatedByPrincipalId);assert.equal(id,sessionId);assert.deepEqual(body,input);return{booking:{id:'receipt'},created:true,replayed:false};}});
 const request={honIdentity:{externalSubject:'verified-subject'},headers:{'external-subject':'forged'},query:{principalId:randomUUID()}};const response={status:n=>assert.equal(n,201)};
 assert.equal((await controller.create(organizationId,schoolId,sessionId,'key',input,request,response)).data.id,'receipt');
 assert.deepEqual(calls[0],['verified-subject',schoolId,'schedule.booking.manage']);
 await assert.rejects(()=>controller.create(randomUUID(),schoolId,sessionId,'key',input,request,response),status(403));
});
