const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { RenewalService } = require('../dist/billing/renewal.service.js');
const { RenewalController } = require('../dist/billing/renewal.controller.js');
const { RenewalHumanUiGuard } = require('../dist/billing/renewal.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope = { organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID() };
const context = (patch={}) => ({...scope,externalSubject:'verified-subject',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:'retained',...patch});
const input = (patch={}) => ({expectedVersion:0,membershipId:randomUUID(),reviewFrom:'2027-01-01T00:00:00.000Z',reviewTo:'2027-02-01T00:00:00.000Z',status:'OPEN',note:'Human review note',reason:'Human review reason',reminderNeeded:null,...patch});
const status = n => e => { assert.equal(e.getStatus(),n); return true; };
test('renewals reject nonhuman/source/delegation/closed input before database work',async()=>{
 let count=0; const svc=new RenewalService({withTenantTransaction:async()=>{count++;throw new Error('unexpected SQL');}});
 for(const patch of [{source:'AI'},{source:'PUBLIC_API'},{source:'PARENT_APP'},{source:'HQ_SUPPORT'},{principalType:'AUTOMATION'},{principalType:'AI_EMPLOYEE'},{principalType:'INTEGRATION'},{principalType:'SYSTEM_SERVICE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){
  await assert.rejects(()=>svc.list(context(patch)),status(403)); await assert.rejects(async()=>svc.mutate(context(patch),'CREATE',null,input()),status(403));
 }
 for(const patch of [{actorId:randomUUID()},{schoolId:randomUUID()},{organizationId:randomUUID()},{source:'HUMAN_UI'},{payerId:randomUUID()},{sendNotice:true},{note:''},{reason:''},{note:'x'.repeat(2001)},{reason:'x'.repeat(501)},{note:'x\u202e'},{reason:'x\nline'},{reviewFrom:'2027-02-30T00:00:00.000Z'},{reviewFrom:'2027-01-01T00:00:00Z'},{reviewTo:'2027-01-01T00:00:59.999Z'},{reviewTo:'2028-01-03T00:00:00.000Z'},{reviewTo:'2100-01-01T00:00:00.000Z'},{status:'REVIEWED'},{status:'AUTO_RENEW'},{reminderNeeded:'yes'},{expectedVersion:1}])await assert.rejects(async()=>svc.mutate(context(),'CREATE',null,input(patch)),status(400));
 await assert.rejects(async()=>svc.mutate(context({idempotencyKey:''}),'CREATE',null,input()),status(409));
 await assert.rejects(async()=>svc.mutate(context(),'REVISE',null,input({expectedVersion:1})),status(400));
 for(const v of [0,-1,1.5,1000000000]){await assert.rejects(async()=>svc.read(context(),randomUUID(),v),status(400));await assert.rejects(async()=>svc.history(context(),randomUUID(),v),status(400));}assert.equal(count,0);
});
test('renewal service uses only fixed safe SQL functions; no billing mutation, provider or execution service',async()=>{
 const calls=[],c=context(),payload=input(),result={renewal:{version:1},replayed:false};const svc=new RenewalService({withTenantTransaction:async(ctx,work)=>{assert.equal(ctx,c);return work({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{data:result}]};}});}});
 assert.deepEqual(await svc.mutate(c,'CREATE',null,payload),result);assert.equal(calls.length,3);assert.match(calls[2].sql,/^SELECT hon.mutate_renewal\(/);assert.deepEqual(calls[2].args,[c.externalSubject,'CREATE',null,JSON.stringify(payload),c.idempotencyKey,c.requestId,c.correlationId]);
 for(const file of ['renewal.service.ts','renewal.controller.ts'])assert.doesNotMatch(readFileSync(`src/billing/${file}`,'utf8'),/ActionEngineService|Ai\w*Service|Payment\w*Service|Communication\w*Service|MembershipService|InvoiceService|WorkItemService|fetch\(|invokeProvider/);
 const sql=readFileSync('../../packages/database/migrations/0080_human_membership_renewals.sql','utf8');assert.doesNotMatch(sql,/(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:crm_leads|crm_activities|crm_appointments|work_items|action_requests|action_approvals|communication_messages|communication_consents|payment_attempts|invoices|memberships\b|membership_payment_schedules|billing_accounts|ai_usage_ledger|ai_invocation_plans|automation_rules)/);
 const config=readFileSync('../../packages/config/src/billing-renewals.ts','utf8');assert.match(config,/HUMAN_ONLY/);assert.doesNotMatch(config,/self_manage|executeAction|invokeLLM/);
});
test('renewal controller derives one unambiguous school solely from verified subject',async()=>{
 const calls=[],db={resolveRenewalScope:async subject=>{calls.push(subject);return scope;}},svc={list:async c=>c,read:async(c,id,version)=>({c,id,version}),mutate:async(c,op,id,body)=>({renewal:{c,op,id,body},replayed:false})},controller=new RenewalController(db,svc),req={honIdentity:{externalSubject:'verified-subject'},body:{schoolId:randomUUID()}};
 const r=await controller.create('retained',input(),req);assert.equal(r.data.c.schoolId,scope.schoolId);assert.equal(r.data.c.source,'HUMAN_UI');assert.equal(r.data.c.idempotencyKey,'retained');assert.equal(r.data.op,'CREATE');assert.deepEqual(calls,['verified-subject']);await assert.rejects(()=>controller.list({},{}),status(403));await assert.rejects(()=>new RenewalController({resolveRenewalScope:async()=>undefined},svc).list({},req),status(403));
 for(const query of [{schoolId:scope.schoolId},{limit:1000},{queue:'all'},{status:'PENDING'},{status:['OPEN']},{after:'../x'}])await assert.rejects(()=>controller.list(query,req),status(400));
 for(const query of [{version:'0'},{version:'1.5'},{version:['1']},{schoolId:scope.schoolId}])await assert.rejects(()=>controller.read(randomUUID(),query,req),status(400));
 assert.equal((await controller.read(randomUUID(),{version:'1'},req)).data.version,1);
});
test('renewal real HTTP enforces same-origin direct human commands and closed DTOs; no collection/notice/renew endpoint',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';let queries=0;const db={resolveRenewalScope:async()=>scope,withTenantTransaction:async(c,work)=>work({query:async()=>{queries++;return {rows:[{data:{renewal:{},replayed:false}}]};}})};
 const module=await Test.createTestingModule({controllers:[RenewalController],providers:[RenewalService,RenewalHumanUiGuard,{provide:RuntimeDatabaseService,useValue:db}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-subject'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/billing/renewals`,headers={origin:'https://hon.test','Content-Type':'application/json','X-HON-Human-Command':'billing-renewals','Idempotency-Key':'retained','Sec-Fetch-Site':'same-origin'},id=randomUUID();
 try{
  const good=await fetch(base,{method:'POST',headers,body:JSON.stringify(input())});assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'private, no-store');assert.equal(queries,3);
  for(const patch of [{schoolId:scope.schoolId},{actorId:scope.principalId},{payerId:randomUUID()},{sendNotice:true},{autoRenew:true}])assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify(input(patch))})).status,400);
  for(const patch of [{origin:'https://bad.test'},{'X-HON-Human-Command':'automation-rules'},{'Sec-Fetch-Site':'same-site'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}])assert.equal((await fetch(base,{method:'POST',headers:{...headers,...patch},body:JSON.stringify(input())})).status,403);
  assert.equal((await fetch(`${base}/${id}/revisions`,{method:'POST',headers,body:JSON.stringify(input({expectedVersion:1,status:'REVIEWED'}))})).status,200);
  for(const suffix of ['execute','send','publish','collect','charge','refund','renew','cancel','proposals','schedule'])assert.equal((await fetch(`${base}/${id}/${suffix}`,{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(`${base}/${id}`,{method:'DELETE',headers})).status,404);assert.equal((await fetch(`${base}?schoolId=${scope.schoolId}`)).status,400);
  assert.equal((await fetch(`${base}/${id}?version=0`)).status,400);assert.equal((await fetch(`${base}/${id}/history?before=1.5`)).status,400);assert.equal((await fetch(`${base}/memberships`)).status,400);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
