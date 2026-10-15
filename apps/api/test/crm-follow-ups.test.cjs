const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { FollowUpService } = require('../dist/crm/follow-up.service.js');
const { FollowUpController } = require('../dist/crm/follow-up.controller.js');
const { FollowUpHumanUiGuard } = require('../dist/crm/follow-up.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope={organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID()};
const context=(patch={})=>({...scope,externalSubject:'verified-subject',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:'key',...patch});
const input=(patch={})=>({expectedVersion:0,leadId:randomUUID(),assigneeId:scope.principalId,subject:'Human review',note:'',dueAt:null,priority:'NORMAL',...patch});
const status=n=>e=>{assert.equal(e.getStatus(),n);return true;};
test('follow-ups reject nonhuman/delegated/source and closed-field bypass before SQL',async()=>{
 let count=0;const svc=new FollowUpService({withTenantTransaction:async()=>{count++;throw new Error('unexpected SQL');}});
 for(const patch of [{source:'AI'},{source:'PUBLIC_API'},{source:'PARENT_APP'},{source:'HQ_SUPPORT'},{principalType:'AUTOMATION'},{principalType:'AI_EMPLOYEE'},{principalType:'INTEGRATION'},{principalType:'SYSTEM_SERVICE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){await assert.rejects(()=>svc.list(context(patch)),status(403));await assert.rejects(async()=>svc.mutate(context(patch),'CREATE',null,input()),status(403));}
 for(const patch of [{actorId:randomUUID()},{schoolId:randomUUID()},{organizationId:randomUUID()},{source:'HUMAN_UI'},{recipientEmail:'external@example.test'},{subject:'x'.repeat(121)},{note:'x'.repeat(2001)},{dueAt:'2027-02-30T00:00:00.000Z'},{priority:'URGENT'},{assigneeId:'external@example.test'},{expectedVersion:1}])await assert.rejects(async()=>svc.mutate(context(),'CREATE',null,input(patch)),status(400));
 await assert.rejects(async()=>svc.mutate(context(),'COMPLETE',randomUUID(),{expectedVersion:1,subject:'injection'}),status(400));assert.equal(count,0);
});
test('follow-up service uses fixed SQL functions and no other domain dependency',async()=>{
 const calls=[],c=context(),payload=input(),result={followUp:{version:1},replayed:false};const svc=new FollowUpService({withTenantTransaction:async(ctx,work)=>{assert.equal(ctx,c);return work({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{data:result}]};}});}});
 assert.deepEqual(await svc.mutate(c,'CREATE',null,payload),result);assert.equal(calls.length,3);assert.match(calls[2].sql,/^SELECT hon.mutate_follow_up\(/);assert.deepEqual(calls[2].args,[c.externalSubject,'CREATE',null,JSON.stringify(payload),c.idempotencyKey,c.requestId,c.correlationId]);
 for(const file of ['follow-up.service.ts','follow-up.controller.ts'])assert.doesNotMatch(readFileSync(`src/crm/${file}`,'utf8'),/ActionEngineService|Ai\w*Service|Payment\w*Service|Communication\w*Service|WorkItemService|fetch\(|invokeProvider/);
 const sql=readFileSync('../../packages/database/migrations/0079_human_crm_follow_ups.sql','utf8');assert.doesNotMatch(sql,/(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:crm_leads|crm_activities|crm_appointments|work_items|action_requests|action_approvals|communication_messages|communication_consents|payment_attempts|invoices|memberships|ai_usage_ledger|ai_invocation_plans|automation_rules)/);
});
test('controller derives one unambiguous live scope solely from verified subject',async()=>{
 const calls=[],db={resolveFollowUpScope:async subject=>{calls.push(subject);return scope;}},svc={list:async c=>c,read:async c=>c,mutate:async(c,op,id,body)=>({followUp:{c,op,id,body},replayed:false})},controller=new FollowUpController(db,svc),req={honIdentity:{externalSubject:'verified-subject'},body:{schoolId:randomUUID()}};
 const r=await controller.create('retained',input(),req);assert.equal(r.data.c.schoolId,scope.schoolId);assert.equal(r.data.c.source,'HUMAN_UI');assert.equal(r.data.c.idempotencyKey,'retained');assert.equal(r.data.op,'CREATE');assert.deepEqual(calls,['verified-subject']);await assert.rejects(()=>controller.list({},{}),status(403));await assert.rejects(()=>new FollowUpController({resolveFollowUpScope:async()=>undefined},svc).list({},req),status(403));
 for(const query of [{schoolId:scope.schoolId},{limit:1000},{queue:'all'},{status:'PENDING'},{after:'../x'}])await assert.rejects(()=>controller.list(query,req),status(400));
});
test('follow-up HTTP has closed DTOs, same-origin direct human guard, and lifecycle-only mutations',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';let queries=0;const db={resolveFollowUpScope:async()=>scope,withTenantTransaction:async(c,work)=>work({query:async()=>{queries++;return {rows:[{data:{followUp:{},replayed:false}}]};}})};
 const module=await Test.createTestingModule({controllers:[FollowUpController],providers:[FollowUpService,FollowUpHumanUiGuard,{provide:RuntimeDatabaseService,useValue:db}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-subject'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/crm/follow-ups`,headers={origin:'https://hon.test','Content-Type':'application/json','X-HON-Human-Command':'crm-follow-ups','Idempotency-Key':'retained','Sec-Fetch-Site':'same-origin'},id=randomUUID();
 try{
  assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify(input())})).status,200);assert.equal(queries,3);
  for(const patch of [{schoolId:randomUUID()},{principalId:randomUUID()},{source:'HUMAN_UI'},{assigneeEmail:'x@example.test'},{dueAt:'2027-02-30T00:00:00.000Z'}])assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify(input(patch))})).status,400);
  for(const patch of [{origin:'https://bad.test'},{'X-HON-Human-Command':'automation-rules'},{'Sec-Fetch-Site':'same-site'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}])assert.equal((await fetch(base,{method:'POST',headers:{...headers,...patch},body:JSON.stringify(input())})).status,403);
  assert.equal((await fetch(`${base}/${id}/lifecycle/complete`,{method:'POST',headers,body:'{"expectedVersion":1}'})).status,200);assert.equal((await fetch(`${base}/${id}/lifecycle/complete`,{method:'POST',headers,body:'{"expectedVersion":1,"note":"injected"}'})).status,400);
  for(const suffix of ['execute','send','publish','proposals','schedule','assign-email'])assert.equal((await fetch(`${base}/${id}/${suffix}`,{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(`${base}/${id}`,{method:'DELETE',headers})).status,404);assert.equal((await fetch(`${base}?schoolId=${scope.schoolId}`)).status,400);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
