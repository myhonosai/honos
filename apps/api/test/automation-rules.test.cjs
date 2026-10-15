const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { AutomationRuleService } = require('../dist/automation-rules/automation-rule.service.js');
const { AutomationRuleController } = require('../dist/automation-rules/automation-rule.controller.js');
const { AutomationRuleHumanUiGuard } = require('../dist/automation-rules/automation-rule.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope={organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID()};
const context=(patch={})=>({...scope,externalSubject:'verified-session',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:'key',...patch});
const input=(patch={})=>({expectedVersion:0,name:'Lead review',enabled:false,triggerKind:'LEAD_CREATED',conditions:{source:'ANY',minimumAggregateVersion:1},proposal:{kind:'MANUAL_REVIEW_TEMPLATE',category:'LEAD_TRIAGE',priority:'NORMAL'},posture:{authority:'NONE',approval:'HUMAN_REVIEW_REQUIRED'},schedule:{mode:'MANUAL_ONLY',effectiveFrom:'2026-01-01',endsOn:null,cooldownMinutes:30},...patch});
const simulation=(patch={})=>({expectedVersion:1,event:{synthetic:true,triggerKind:'LEAD_CREATED',schemaVersion:1,aggregateVersion:1,source:'HUMAN_UI'},simulation:{localDate:'2026-10-01',minutesSincePriorPlan:null},...patch});
const status=(n)=>e=>{assert.equal(e.getStatus(),n);return true;};
test('automation service rejects non-human/delegated contexts and closed-schema bypass before any SQL',async()=>{
 let count=0;const service=new AutomationRuleService({withTenantTransaction:async()=>{count++;throw new Error('unexpected SQL');}});
 for(const patch of [{source:'AI'},{source:'PUBLIC_API'},{source:'PARENT_APP'},{source:'HQ_SUPPORT'},{principalType:'AUTOMATION'},{principalType:'AI_EMPLOYEE'},{principalType:'INTEGRATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){await assert.rejects(()=>service.list(context(patch)),status(403));await assert.rejects(async()=>service.dryRun(context(patch),randomUUID(),simulation()),status(403));}
 for(const patch of [{actorId:randomUUID()},{conditions:{source:'ANY',minimumAggregateVersion:1,javascript:'true'}},{posture:{authority:'AUTO',approval:'HUMAN_REVIEW_REQUIRED'}},{proposal:{kind:'SEND_MESSAGE',category:'LEAD_TRIAGE',priority:'NORMAL'}},{proposal:{kind:'MANUAL_REVIEW_TEMPLATE',category:'LEAD_TRIAGE',priority:'NORMAL',endpointUrl:'https://bad.test'}}])await assert.rejects(async()=>service.save(context(),null,input(patch)),status(400));
 for(const patch of [{event:{...simulation().event,synthetic:false}},{event:{...simulation().event,eventId:randomUUID()}},{event:{...simulation().event,schemaVersion:2}}])await assert.rejects(async()=>service.dryRun(context(),randomUUID(),simulation(patch)),status(400));assert.equal(count,0);
});
test('dry-run uses only fixed SQL and returns no audit/work/action persistence calls',async()=>{
 const calls=[],result={configurationOnly:true,executionAllowed:false,status:'NOT_PLANNED',reason:'DISABLED',plan:null},c=context();const service=new AutomationRuleService({withTenantTransaction:async(ctx,work)=>{assert.equal(ctx,c);return work({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{data:result}]};}});}});
 assert.deepEqual(await service.dryRun(c,scope.principalId,simulation()),result);assert.equal(calls.length,3);assert.match(calls[2].sql,/^SELECT hon.dry_run_automation_rule\(/);assert.deepEqual(calls[2].args,[c.externalSubject,scope.principalId,JSON.stringify(simulation())]);assert(calls.every(x=>!/(INSERT|UPDATE|DELETE|save_|audit|outbox|action_requests)/.test(x.sql)));
});
test('controller derives session scope from the exact independent operation permission',async()=>{
 const seen=[],db={resolveAutomationRuleScope:async(subject,permission)=>{seen.push([subject,permission]);return scope;}},service={list:async()=>({configurationOnly:true}),save:async(c,id,input)=>({rule:{...input,configurationOnly:true},replayed:false}),dryRun:async()=>({executionAllowed:false}),read:async()=>({configurationOnly:true})},controller=new AutomationRuleController(db,service),req={honIdentity:{externalSubject:'verified-session'},body:{schoolId:randomUUID(),principalId:randomUUID()}};
 await controller.list(req);await controller.create('key',input(),req);await controller.dryRun(scope.principalId,simulation(),req);assert.deepEqual(seen,[['verified-session','automation.rule.read'],['verified-session','automation.rule.manage'],['verified-session','automation.rule.dry_run']]);await assert.rejects(()=>controller.list({}),status(403));await assert.rejects(()=>new AutomationRuleController({resolveAutomationRuleScope:async()=>undefined},service).list(req),status(403));
});
test('human guard and HTTP endpoints require origin, exact command, closed DTOs and no execution endpoint',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';const queries=[],db={resolveAutomationRuleScope:async()=>scope,withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>{queries.push(sql);return {rows:[{data:sql.startsWith('SELECT hon.save_automation_rule')?{rule:{...input(),configurationOnly:true},replayed:false}:{configurationOnly:true,executionAllowed:false}}]};}})};
 const module=await Test.createTestingModule({controllers:[AutomationRuleController],providers:[AutomationRuleService,AutomationRuleHumanUiGuard,{provide:RuntimeDatabaseService,useValue:db}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-session'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/automation/rules`,headers={origin:'https://hon.test','Content-Type':'application/json','X-HON-Human-Command':'automation-rules','Idempotency-Key':'key','Sec-Fetch-Site':'same-origin'};
 try{assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify(input())})).status,200);assert.equal((await fetch(`${base}/${scope.principalId}/dry-run`,{method:'POST',headers,body:JSON.stringify(simulation())})).status,200);for(const patch of [{schoolId:randomUUID()},{principalId:randomUUID()},{source:'HUMAN_UI'},{posture:{authority:'AUTO',approval:'HUMAN_REVIEW_REQUIRED'}},{conditions:{source:'ANY',minimumAggregateVersion:1,sql:'SELECT 1'}}])assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify(input(patch))})).status,400);
 for(const patch of [{origin:'https://bad.test'},{'X-HON-Human-Command':'staff-roles'},{'Sec-Fetch-Site':'same-site'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}])assert.equal((await fetch(base,{method:'POST',headers:{...headers,...patch},body:JSON.stringify(input())})).status,403);
 for(const suffix of ['execute','send','publish','events','work-items'])assert.equal((await fetch(`${base}/${scope.principalId}/${suffix}`,{method:'POST',headers,body:'{}'})).status,404);assert.equal((await fetch(`${base}/${scope.principalId}`,{method:'DELETE',headers})).status,404);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('automation foundation has no provider/AI/communication/payment/Action Engine execution dependencies',()=>{
 for(const file of ['automation-rule.service.ts','automation-rule.controller.ts'])assert.doesNotMatch(readFileSync(`src/automation-rules/${file}`,'utf8'),/ActionEngineService|Ai\w*Service|Payment\w*Service|Communication\w*Service|WorkItemService|fetch\(|invokeProvider/);
 const sql=readFileSync('../../packages/database/migrations/0078_inert_automation_rules.sql','utf8');assert.doesNotMatch(sql,/(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:work_items|action_requests|action_approvals|communication_messages|communication_consents|payment_attempts|invoices|memberships|ai_usage_ledger|ai_invocation_plans|class_sessions|crm_leads|crm_appointments)/);
 const dry=sql.slice(sql.indexOf('CREATE FUNCTION hon.dry_run_automation_rule'),sql.indexOf('REVOKE ALL ON TABLE'));assert.doesNotMatch(dry,/INSERT|UPDATE|DELETE|audit_events|outbox_events|save_automation/);
});
