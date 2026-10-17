const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { LeadCloseService } = require('../dist/crm/lead-close.service.js');
const { LeadCloseController } = require('../dist/crm/lead-close.controller.js');
const { LeadCloseHumanUiGuard } = require('../dist/crm/lead-close.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { validateCloseCrmLeadInput } = require('@hon/contracts');
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() }, leadId = randomUUID();
const context = (patch={}) => ({ ...scope, externalSubject:'verified-subject', principalType:'HUMAN_USER', source:'HUMAN_UI', requestId:randomUUID(), correlationId:randomUUID(), idempotencyKey:randomUUID(), ...patch });
const input = (patch={}) => ({status:'WON',expectedVersion:1,...patch});
const status = n => e => { assert.equal(e.getStatus(),n); return true; };

test('CRM close contract rejects unknown/coerced/missing/terminal/unsafe input before SQL', async () => {
 let count=0; const svc=new LeadCloseService({withTenantTransaction:async()=>{count++;throw new Error('unexpected SQL');}});
 for(const patch of [{status:'OPEN'},{status:'ARCHIVED'},{status:'COMPLETED'},{status:true},{expectedVersion:0},{expectedVersion:'1'},{expectedVersion:1.1},{expectedVersion:999999999},{closeNote:null},{closeNote:''},{closeNote:' x'},{closeNote:'x '},{closeNote:'x'.repeat(2001)},{closeNote:'x\tb'},{closeNote:'x\u202e'},{closeNote:'x\u0085'},{closeNote:'\u00a0x'},{closeNote:'x\u202f'},{actorId:randomUUID()},{organizationId:randomUUID()},{schoolId:randomUUID()},{leadId:randomUUID()},{source:'HUMAN_UI'},{actionRequestId:randomUUID()},{enrollmentId:randomUUID()},{send:true}]) {
  assert.throws(()=>validateCloseCrmLeadInput(input(patch)));
  await assert.rejects(()=>svc.close(context(),leadId,input(patch)),status(400));
 }
 for(const v of [null,[],{}, {status:'LOST'}, {expectedVersion:1}]) assert.throws(()=>validateCloseCrmLeadInput(v));
 for(const patch of [{source:'AI'},{source:'PUBLIC_API'},{source:'PARENT_APP'},{source:'HQ_SUPPORT'},{source:'AUTOMATION'},{source:'INTEGRATION'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{principalType:'SYSTEM_SERVICE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{actionRequestId:''},{ai:true}]) await assert.rejects(()=>svc.close(context(patch),leadId,input()),status(403));
 await assert.rejects(()=>svc.close(context({idempotencyKey:'retained'}),leadId,input()),status(400));
 assert.equal(count,0);
 validateCloseCrmLeadInput({status:'LOST',expectedVersion:999999998,closeNote:'Private human note\nNo outreach.'});
 validateCloseCrmLeadInput({status:'WON',expectedVersion:1,closeNote:'😀'.repeat(2000)});
});

test('CRM close service uses only fixed SQL and controller derives exact scope from verified subject', async () => {
 const c=context(), payload=input(), result={receipt:{crmOnly:true},replayed:false}, calls=[];
 const svc=new LeadCloseService({withTenantTransaction:async(ctx,work)=>{assert.equal(ctx,c);return work({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{data:result}]};}});}});
 assert.deepEqual(await svc.close(c,leadId,payload),result);
 assert.deepEqual(calls[2].args,[c.externalSubject,leadId,JSON.stringify(payload),c.idempotencyKey,c.requestId,c.correlationId]);
 assert.match(calls[2].sql,/^SELECT hon.close_crm_lead\(/); assert.equal(calls.length,3);
 const selectors=[], controller=new LeadCloseController({resolveCrmLeadCloseScope:async(...args)=>{selectors.push(args);return scope;}},{close:async(ctx,id,body)=>({receipt:{ctx,id,body},replayed:true})});
 const response=await controller.close(scope.organizationId,scope.schoolId,leadId,c.idempotencyKey,payload,{honIdentity:{externalSubject:'trusted'}});
 assert.deepEqual(selectors,[['trusted',scope.schoolId]]); assert.deepEqual(response.data.ctx,{...scope,externalSubject:'trusted',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:response.meta.requestId,correlationId:response.meta.requestId,idempotencyKey:c.idempotencyKey});
 assert.equal(response.data.id,leadId); assert.equal(response.meta.replayed,true);
 await assert.rejects(()=>controller.close(randomUUID(),scope.schoolId,leadId,c.idempotencyKey,payload,{honIdentity:{externalSubject:'trusted'}}),status(403));
 await assert.rejects(()=>controller.close(scope.organizationId,scope.schoolId,leadId,c.idempotencyKey,payload,{}),status(403));
 for(const [code,n] of [['42501',403],['P0002',404],['40001',409],['23505',409],['55P03',409],['57014',503],['22023',400]]) await assert.rejects(()=>new LeadCloseService({withTenantTransaction:async()=>{throw {code};}}).close(c,leadId,payload),status(n));
});

test('CRM close HTTP accepts only trusted-origin JSON marker with closed fields and no contexts or side routes',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN='https://hon.test'; let calls=0;
 const db={resolveCrmLeadCloseScope:async()=>scope,withTenantTransaction:async(c,work)=>work({query:async()=>{calls++;return {rows:[{data:{receipt:{crmOnly:true},replayed:false}}]};}})};
 const module=await Test.createTestingModule({controllers:[LeadCloseController],providers:[LeadCloseService,LeadCloseHumanUiGuard,{provide:RuntimeDatabaseService,useValue:db}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){c.switchToHttp().getRequest().honIdentity={externalSubject:'trusted'};return true;}}).compile();
 const app=module.createNestApplication(); app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads/${leadId}`;
 const headers={Origin:'https://hon.test','Content-Type':'application/json','X-HON-Human-Command':'crm-lead-close','Idempotency-Key':randomUUID(),'Sec-Fetch-Site':'same-origin'};
 const post=(body=input(),patch={},suffix='/close')=>fetch(base+suffix,{method:'POST',headers:{...headers,...patch},body:JSON.stringify(body)});
 try {
  const first=await post(); assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'private, no-store');assert.equal(calls,3);
  for(const p of [{status:'ENROLLED'},{expectedVersion:'1'},{closeNote:null},{closeNote:' '},{actorId:randomUUID()},{schoolId:randomUUID()},{leadId:randomUUID()},{source:'HUMAN_UI'},{send:true}]) assert.equal((await post(input(p))).status,400);
  for(const p of [{Origin:'https://bad.test'},{Origin:''},{'X-HON-Human-Command':''},{'X-HON-Human-Command':'crm-follow-ups'},{'Sec-Fetch-Site':'same-site'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'},{'X-HON-Source':'HUMAN_UI'},{'X-HON-Action-Request-Id':randomUUID()},{'X-HON-Delegated-By-Principal-Id':randomUUID()}]) assert.equal((await post(input(),p)).status,403);
  assert.equal((await post(input(),{},'/close?schoolId='+scope.schoolId)).status,400);
  for(const suffix of ['/send','/reopen','/won','/lost','/execute','/enroll']) assert.equal((await post(input(),{},suffix)).status,404);
  assert.equal((await fetch(base+'/close',{method:'GET',headers})).status,404);assert.equal((await fetch(base+'/close',{method:'PATCH',headers,body:'{}'})).status,404);
  assert.equal(calls,3);
  delete process.env.HON_PUBLIC_ORIGIN;assert.equal((await post()).status,503);
 } finally {await app.close(); if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});

test('CRM close has no Action Engine registry, trigger, provider or other domain dependency',()=>{
 const config=require('@hon/config'); assert.equal(config.ACTION_CATALOG.some(a=>a.code==='crm.lead.close'),false);
 assert.equal(config.AUTOMATION_RULE_TRIGGER_REGISTRY.some(t=>t.eventType==='crm.lead.human_closed'),false);
 for(const name of ['lead-close.service.ts','lead-close.controller.ts']) assert.doesNotMatch(readFileSync('src/crm/'+name,'utf8'),/ActionEngineService|Ai\w*Service|Payment\w*Service|Communication\w*Service|WorkItemService|fetch\(|invokeProvider/);
 const sql=readFileSync('../../packages/database/migrations/0145_human_crm_lead_close.sql','utf8');
 assert.doesNotMatch(sql,/(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:people|crm_activities|crm_appointments|work_items|action_requests|action_approvals|communication_messages|communication_consents|payment_attempts|invoices|memberships|ai_usage_ledger|ai_invocation_plans|automation_rules|student_profiles|family_members)/);
 assert.match(sql,/executionAllowed',false/);
});
