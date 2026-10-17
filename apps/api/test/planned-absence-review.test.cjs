const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { verifyPlannedAbsenceReviewQueue, verifyPlannedAbsenceDecisionReceipt, validatePlannedAbsenceReviewInput } = require('@hon/contracts');
const { PlannedAbsenceReviewQueueService, PlannedAbsenceReviewQueueController } = require('../dist/schedule/planned-absence-review-queue.controller.js');
const { PlannedAbsenceReviewController } = require('../dist/schedule/planned-absence-review.controller.js');
const { PlannedAbsenceReviewService } = require('../dist/schedule/planned-absence-review.service.js');
const { PlannedAbsenceReviewHumanUiGuard } = require('../dist/schedule/planned-absence-review-human-ui.guard.js');
const { AttendanceHumanUiGuard } = require('../dist/schedule/attendance-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { DecidePlannedAbsenceRequestDto } = require('../dist/schedule/decide-planned-absence-request.dto.js');
const [organizationId, schoolId, principalId, id, studentProfileId] = Array.from({length:5},randomUUID);
const scope={organizationId,schoolId,principalId}, item={id,studentProfileId,startsAt:'2026-10-18T09:00:00.000Z',endsAt:'2026-10-18T11:00:00.000Z',reason:'Private submitted reason',version:1,submittedAt:'2026-10-17T00:00:00.000Z'};
const queue={organizationId,schoolId,items:[item]}, input={decision:'APPROVED',reviewNote:'Private human rationale',expectedVersion:1};
const context=patch=>({...scope,externalSubject:'verified-staff',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:'exact-key',...patch});
const receipt={id,status:'APPROVED',version:2,reviewedAt:'2026-10-17T01:00:00.000Z'};
const status=expected=>error=>error.getStatus()===expected;

test('review contracts close minimum queue facts, cap 50, reject duplicate/malformed/extra state and redacted receipt leakage',()=>{
 assert.deepEqual(verifyPlannedAbsenceReviewQueue(queue),queue);
 for(const value of [{...queue,total:1},{...queue,items:Array(51).fill(item)},{...queue,items:[item,item]},{...queue,items:[{...item,reviewNote:'secret'}]},{...queue,items:[{...item,status:'APPROVED'}]},{...queue,items:[{...item,version:0}]},{...queue,items:[{...item,startsAt:'2026-02-30T00:00:00.000Z'}]},{...queue,items:[{...item,reason:'x'.repeat(1001)}]}]) assert.throws(()=>verifyPlannedAbsenceReviewQueue(value));
 assert.deepEqual(verifyPlannedAbsenceDecisionReceipt(receipt),receipt);
 for(const patch of [{reviewedByPrincipalId:principalId},{reviewNote:'secret'},{status:'CANCELLED'},{version:0}]) assert.throws(()=>verifyPlannedAbsenceDecisionReceipt({...receipt,...patch}));
 for(const patch of [{reviewNote:'  '},{reviewNote:'a'.repeat(1001)},{decision:'SUBMITTED'},{expectedVersion:2147483647},{expectedVersion:1.1},{principalId},{source:'AI'},{schoolId}]) assert.throws(()=>validatePlannedAbsenceReviewInput({...input,...patch}));
});
test('review queue is selector-free, exact scope checked and no unsafe persistence error reflected',async()=>{
 let calls=0;
 const db={resolvePlannedAbsenceReviewScope:async subject=>{assert.equal(subject,'verified-staff');return scope;},readPlannedAbsenceReviewQueue:async c=>{calls++;assert.equal(c.source,'HUMAN_UI');assert.equal(c.principalId,principalId);return queue;}};
 assert.deepEqual((await new PlannedAbsenceReviewQueueService(db).get('verified-staff')).data,queue);assert.equal(calls,1);
 db.resolvePlannedAbsenceReviewScope=async()=>undefined;await assert.rejects(new PlannedAbsenceReviewQueueService(db).get('verified-staff'),status(403));assert.equal(calls,1);
 db.resolvePlannedAbsenceReviewScope=async()=>scope;db.readPlannedAbsenceReviewQueue=async()=>({...queue,schoolId:randomUUID()});await assert.rejects(new PlannedAbsenceReviewQueueService(db).get('verified-staff'),status(403));
 db.readPlannedAbsenceReviewQueue=async()=>{throw Object.assign(new Error('SQL_SECRET'),{code:'42501'});};await assert.rejects(new PlannedAbsenceReviewQueueService(db).get('verified-staff'),status(403));
 db.readPlannedAbsenceReviewQueue=async()=>{throw new Error('SQL_SECRET');};await assert.rejects(new PlannedAbsenceReviewQueueService(db).get('verified-staff'),e=>e.getStatus()===503&&!JSON.stringify(e.getResponse()).includes('SQL_SECRET'));
});
test('trusted-origin review guard has equivalent Attendance command guard behavior, without weakening the inherited guard',()=>{
 const previous=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';
 const base={method:'POST',query:{},headers:{origin:'https://hon.test','content-type':'application/json','x-hon-human-command':'planned-absence-review','sec-fetch-site':'same-origin'}};
 const execution=request=>({switchToHttp:()=>({getRequest:()=>request,getResponse:()=>({setHeader(){}})})});
 try {
  assert.equal(new PlannedAbsenceReviewHumanUiGuard().canActivate(execution(base)),true);
  for(const patch of [{headers:{...base.headers,origin:'https://evil.test'}},{headers:{...base.headers,origin:undefined}},{headers:{...base.headers,'content-type':'text/plain'}},{headers:{...base.headers,'x-hon-human-command':'attendance'}},{headers:{...base.headers,'sec-fetch-site':'cross-site'}},{headers:{...base.headers,'x-hon-source':'AI'}},{query:{schoolId}},{method:'PUT'}]) assert.throws(()=>new PlannedAbsenceReviewHumanUiGuard().canActivate(execution({...base,...patch})));
  assert.equal(new AttendanceHumanUiGuard().canActivate(execution({...base,headers:{...base.headers,'x-hon-human-command':'attendance'}})),true);
  process.env.HON_PUBLIC_ORIGIN='';assert.throws(()=>new PlannedAbsenceReviewHumanUiGuard().canActivate(execution(base)),status(503));
 } finally {if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous;}
});
test('canonical service denies nonhuman/action/delegated context and invalid note/version before any transaction',async()=>{
 let calls=0;const service=new PlannedAbsenceReviewService({withTenantTransaction:async()=>{calls++;throw new Error('unexpected');}});
 for(const patch of [{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{source:'AUTOMATION'},{source:'INTEGRATION'},{actionRequestId:id},{delegatedByPrincipalId:id},{externalSubject:''}]) await assert.rejects(service.decide(context(patch),id,input),status(403));
 for(const patch of [{decision:'CANCELLED'},{reviewNote:'  '},{reviewNote:'a'.repeat(1001)},{expectedVersion:0},{reviewedByPrincipalId:id}]) await assert.rejects(service.decide(context(),id,{...input,...patch}),status(400));
 assert.equal(calls,0);
});
test('canonical service locks live authority before idempotent replay, retains one-record atomic transition and closed conflict rules',async()=>{
 const row={...item,status:'SUBMITTED',reviewedByPrincipalId:null,reviewedAt:null,reviewNote:null,createdAt:item.submittedAt,updatedAt:item.submittedAt};
 const next={...row,status:'APPROVED',reviewedByPrincipalId:principalId,reviewedAt:receipt.reviewedAt,reviewNote:input.reviewNote,version:2,updatedAt:receipt.reviewedAt};
 const calls=[];let replay=false,fingerprint;let current=row;
 const client={query:async(sql,params)=>{calls.push(sql);if(sql.includes('FROM hon.planned_absence_requests'))return{rows:[current]};if(sql.includes('INSERT INTO hon.idempotency_records')){fingerprint??=params[4];return{rowCount:replay?0:1,rows:[{id:randomUUID()}]};}if(sql.includes('SELECT request_fingerprint'))return{rows:[{request_fingerprint:fingerprint,status:'COMPLETED',response_body:next}]};if(sql.includes('UPDATE hon.planned_absence_requests'))return{rows:[next]};return{rows:[],rowCount:1};}};
 const service=new PlannedAbsenceReviewService({withTenantTransaction:async(c,work)=>work(client)});
 const result=await service.decide(context(),id,input);assert.equal(result.replayed,false);assert.equal(result.plannedAbsenceRequest.status,'APPROVED');
 assert(calls.findIndex(sql=>sql.includes('lock_planned_absence_review_actor'))<calls.findIndex(sql=>sql.includes('FROM hon.planned_absence_requests')));
 assert.equal(calls.filter(sql=>sql.includes('UPDATE hon.planned_absence_requests')).length,1);assert(calls.some(sql=>sql.includes('INSERT INTO hon.audit_events')));assert(calls.some(sql=>sql.includes('INSERT INTO hon.outbox_events')));
 replay=true;current=next;calls.length=0;assert.equal((await service.decide(context(),id,input)).replayed,true);assert(!calls.some(sql=>sql.includes('UPDATE hon.planned_absence_requests')));
 await assert.rejects(service.decide(context(),id,{...input,decision:'DECLINED'}),status(409));
 replay=false;await assert.rejects(service.decide(context(),id,input),status(409));current=row;await assert.rejects(service.decide(context(),id,{...input,expectedVersion:2}),status(409));
});
test('HTTP queue/decision routes enforce same-origin guard, reject selectors and authority DTO injection and return only redacted receipt',async()=>{
 const previous=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';let authorized=true,calls=0;
 const module=await Test.createTestingModule({controllers:[PlannedAbsenceReviewQueueController,PlannedAbsenceReviewController],providers:[PlannedAbsenceReviewHumanUiGuard,{provide:PlannedAbsenceReviewQueueService,useValue:{get:async()=>({data:queue,meta:{requestId:id,correlationId:id}})}},{provide:RuntimeDatabaseService,useValue:{resolvePlannedAbsenceReviewScope:async()=>authorized?scope:undefined}},{provide:PlannedAbsenceReviewService,useValue:{decide:async(c,request,input)=>{calls++;assert.equal(c.externalSubject,'verified-staff');assert.equal(c.principalId,principalId);assert.equal(request,id);assert.equal(input.expectedVersion,1);return{plannedAbsenceRequest:{...receipt,reviewedByPrincipalId:principalId,reviewNote:'SQL_SECRET'},replayed:false};}}}]}).overrideGuard(HonIdentityGuard).useValue({canActivate:c=>{c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-staff'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1`,path=`/organizations/${organizationId}/schools/${schoolId}/planned-absence-requests/${id}/decision`;
 const headers={'Content-Type':'application/json','Origin':'https://hon.test','X-HON-Human-Command':'planned-absence-review','Idempotency-Key':'key','Sec-Fetch-Site':'same-origin'};
 try {
	  let response=await fetch(base+'/staff/attendance/planned-absences',{headers:{'X-HON-Human-Command':'planned-absence-review'}});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
	  assert.equal((await fetch(base+'/staff/attendance/planned-absences')).status,403);
	  assert.equal((await fetch(base+'/staff/attendance/planned-absences',{headers:{'X-HON-Human-Command':'attendance'}})).status,403);
	  assert.equal((await fetch(base+'/staff/attendance/planned-absences?limit=100',{headers:{'X-HON-Human-Command':'planned-absence-review'}})).status,400);
  for(const extra of [{source:'AI'},{principalId},{organizationId},{reviewedByPrincipalId:principalId},{attendance:true},{reviewNote:'a'.repeat(1001)}]) assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify({...input,...extra})})).status,400);
  for(const patch of [{Origin:'https://evil.test'},{'X-HON-Human-Command':'attendance'},{'Content-Type':'text/plain'},{'X-HON-Source':'AUTOMATION'},{'Sec-Fetch-Site':'cross-site'}]) assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,...patch},body:JSON.stringify(input)})).status,403);
  response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,200);assert.deepEqual((await response.json()).data,receipt);assert.equal(calls,1);
  authorized=false;assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input)})).status,403);assert.equal(calls,1);
 } finally {await app.close();if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous;}
});
test('additive projection never widens tables, operational effects or parent history; module wiring is explicit',()=>{
 const sql=readFileSync('../../packages/database/migrations/0144_staff_planned_absence_review_queue.sql','utf8');assert.match(sql,/LIMIT 50/);assert.match(sql,/request.status = 'SUBMITTED'/);assert.doesNotMatch(sql,/CREATE TABLE|ALTER TABLE|CREATE POLICY|GRANT (?:SELECT|UPDATE|INSERT)|INSERT INTO|DELETE FROM|UPDATE hon\./i);
 const projection=sql.split('CREATE FUNCTION hon.read_staff_planned_absence_review_queue')[1].split('REVOKE ALL')[0];assert.doesNotMatch(projection,/review_note|reviewed_by|family_id|requested_by|attendance_records|class_bookings/);
 const module=readFileSync('src/app.module.ts','utf8');for(const name of ['PlannedAbsenceReviewQueueController','PlannedAbsenceReviewQueueService','PlannedAbsenceReviewHumanUiGuard'])assert(module.includes(name));
});
