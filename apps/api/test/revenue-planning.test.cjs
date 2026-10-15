const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { ValidationPipe } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { RevenuePlanningService } = require('../dist/planning/revenue-planning.service.js');
const { RevenuePlanningController } = require('../dist/planning/revenue-planning.controller.js');
const { RevenuePlanningHumanUiGuard } = require('../dist/planning/revenue-planning-human-ui.guard.js');
const { SaveRevenuePlanDto, validateRevenueInput } = require('../dist/planning/revenue-planning.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { projectRevenuePlan, validateRevenuePlanInput, REVENUE_VALIDATION } = require('@hon/contracts');
const { ACTION_CATALOG, REVENUE_PLANNING_COMMAND_REGISTRY } = require('@hon/config');
const [organizationId,schoolId,principalId,planId] = Array.from({length:4},randomUUID);
const context = (extra={}) => ({organizationId,schoolId,principalId,externalSubject:'verified-subject',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...extra});
const input = (patch={}) => ({expectedVersion:0,targetMonthlyMinor:100000,currency:'USD',targetFrom:'2026-11-01T00:00:00.000Z',targetTo:'2026-12-01T00:00:00.000Z',historyFrom:'2026-01-01T00:00:00.000Z',historyTo:'2026-01-31T00:00:00.000Z',baselineMethod:'CURRENT_MONTHLY_SCHEDULES',assumptions:{trialToMembership:0.5,activitiesPerLead:3},...patch});
const snapshot = (patch={},ev={}) => {const {expectedVersion,...i}=input(patch);return {plan:{id:planId,version:1,algorithmVersion:'school-revenue-v1',input:i},evidence:{currency:i.currency,asOf:'2026-10-01T00:00:00.000Z',from:i.historyFrom,to:i.historyTo,eligibleMonthlyMinor:50000,eligibleMemberships:5,activeMemberships:7,excludedMemberships:2,leads:40,bookedTrialLeads:20,completedTrialLeads:10,ambiguousTrialLeads:0,...ev},snapshotHash:'a'.repeat(64)};};
const status = expected => error => {assert.equal(error.getStatus(),expected);assert.doesNotMatch(JSON.stringify(error.getResponse()),/SQL_SECRET|password|pg_catalog/);return true;};

test('closed DTO and shared validation reject authority, evidence, versions, invalid literal bounds and rates',async()=>{
 const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
 validateRevenueInput(await pipe.transform(input(),{type:'body',metatype:SaveRevenuePlanDto}));
 for(const field of ['principalId','source','algorithmVersion','version','validation','evidence','snapshotHash','evidenceState']) await assert.rejects(()=>pipe.transform({...input(),[field]:'forged'},{type:'body',metatype:SaveRevenuePlanDto}),status(400));
 for(const bad of [
  {expectedVersion:-1},{expectedVersion:999999999},{expectedVersion:1.1},{targetMonthlyMinor:-1},{targetMonthlyMinor:1000000000001},{targetMonthlyMinor:'100'}, {targetMonthlyMinor:Infinity},{currency:'usd'},{currency:'US'},{currency:'USDD'},{baselineMethod:'PAID_INVOICES'},
  {targetFrom:'2026-02-30T00:00:00.000Z'},{targetFrom:'2026-11-01T00:00:00Z'},{targetTo:'2026-11-01T00:00:00.000Z'},{targetTo:'2028-01-01T00:00:00.000Z'},{historyTo:'2026-05-01T00:00:00.000Z'},
  {assumptions:[]},{assumptions:{newMembershipMonthlyMinor:0.1}},{assumptions:{newMembershipMonthlyMinor:1000000000001}},{assumptions:{activitiesPerLead:1001}},{assumptions:{activitiesPerLead:-1}},{assumptions:{trialToMembership:1.000001}},{assumptions:{trialToMembership:0.1234567}},{assumptions:{trialToMembership:1e-16}},{assumptions:{trialToMembership:'0.5'}},{assumptions:{trialToMembership:NaN}},{assumptions:{membershipConversion:0.5}},{assumptions:{evidence:{leads:100}}},
 ]) assert.throws(()=>validateRevenueInput(input(bad)),status(400));
 for(const rate of [0,0.000001,0.123456,0.999999,1]) validateRevenuePlanInput(input({assumptions:{trialToMembership:rate}}));
 assert.throws(()=>validateRevenuePlanInput(Object.create(input())));
 assert.throws(()=>validateRevenuePlanInput(input({assumptions:Object.create({trialToMembership:0.5})})));
});

test('exact rational ceilings derive only from visible evidence and expose sorted human assumptions and limits',()=>{
 const s=snapshot();const before=JSON.stringify(s),p=projectRevenuePlan(s);
 assert.deepEqual(Object.values(p.funnel).map(q=>q.required),[5,10,20,40,120]);assert.deepEqual(p.validation,REVENUE_VALIDATION);assert.equal(p.evidenceState,'SAVED');
 assert.equal(p.signals.newMembershipMonthlyMinor.source,'CURRENT_ELIGIBLE_AVERAGE');assert.equal(p.signals.appointmentToTrial.source,'SCOPED_HISTORY');assert.equal(p.signals.trialToMembership.source,'HUMAN_ASSUMPTION');assert.deepEqual(p.assumptions.map(a=>a.field),['activitiesPerLead','trialToMembership']);
 assert.equal(JSON.stringify(s),before);assert.deepEqual(projectRevenuePlan(s),p);
 // Non-integral average 10001/5 and non-integral rational rates must not round early.
 const rounded=projectRevenuePlan(snapshot({baselineMethod:'ZERO_BASELINE',targetMonthlyMinor:10002,assumptions:{trialToMembership:0.333333,appointmentToTrial:0.666667,leadToAppointment:0.999999,activitiesPerLead:2}},{eligibleMonthlyMinor:10001}));
 assert.deepEqual(Object.values(rounded.funnel).map(q=>q.required),[6,19,29,30,60]);
 assert.equal(rounded.signals.trialToMembership.numerator,333333);assert.equal(rounded.signals.trialToMembership.denominator,1000000);
 const copy=projectRevenuePlan(s);copy.plan.input.assumptions.activitiesPerLead=99;assert.equal(s.plan.input.assumptions.activitiesPerLead,3);
});

test('missing/ambiguous/insufficient evidence is never a price, membership conversion, or invented rate',()=>{
 const p=projectRevenuePlan(snapshot({assumptions:{}},{eligibleMonthlyMinor:0,eligibleMemberships:0,activeMemberships:0,excludedMemberships:0,leads:0,bookedTrialLeads:0,completedTrialLeads:0}));
 assert.equal(p.funnel.memberships.status,'ASSUMPTION_REQUIRED');assert(Object.values(p.signals).every(s=>s.source==='UNAVAILABLE'));
 const insufficient=projectRevenuePlan(snapshot({assumptions:{}},{leads:19,bookedTrialLeads:19,completedTrialLeads:10}));assert.equal(insufficient.signals.leadToAppointment.source,'UNAVAILABLE');assert.equal(insufficient.signals.appointmentToTrial.source,'UNAVAILABLE');
 const ambiguous=projectRevenuePlan(snapshot({assumptions:{}},{bookedTrialLeads:19,ambiguousTrialLeads:1}));assert.equal(ambiguous.signals.leadToAppointment.source,'UNAVAILABLE');assert.equal(ambiguous.signals.trialToMembership.value,null);
 const override=projectRevenuePlan(snapshot({assumptions:{leadToAppointment:0.25}},{bookedTrialLeads:19,ambiguousTrialLeads:1}));assert.equal(override.signals.leadToAppointment.source,'HUMAN_ASSUMPTION');assert.equal(override.signals.leadToAppointment.numerator,250000);
});

test('zero gap, observed zero, explicit zero denominators, max quantities and activity multiplication are bounded',()=>{
 const zero=projectRevenuePlan(snapshot({targetMonthlyMinor:0,assumptions:{}}));assert(Object.values(zero.funnel).every(q=>q.required===0&&q.status==='NOT_REQUIRED'));
 const price=projectRevenuePlan(snapshot({assumptions:{newMembershipMonthlyMinor:0}}));assert.equal(price.funnel.memberships.status,'ZERO_DENOMINATOR');
 const rate=projectRevenuePlan(snapshot({assumptions:{trialToMembership:0}}));assert.equal(rate.funnel.trials.status,'ZERO_DENOMINATOR');assert.equal(rate.funnel.leads.status,'UPSTREAM_BLOCKED');
 const observedZero=projectRevenuePlan(snapshot({}, {completedTrialLeads:0}));assert.equal(observedZero.signals.appointmentToTrial.source,'SCOPED_HISTORY');assert.equal(observedZero.funnel.appointments.status,'ZERO_DENOMINATOR');
 const max=projectRevenuePlan(snapshot({baselineMethod:'ZERO_BASELINE',targetMonthlyMinor:1000000000,assumptions:{newMembershipMonthlyMinor:1,trialToMembership:1,appointmentToTrial:1,leadToAppointment:1,activitiesPerLead:1}}));assert(Object.values(max.funnel).every(q=>q.required===1000000000));
 const overflow=projectRevenuePlan(snapshot({baselineMethod:'ZERO_BASELINE',targetMonthlyMinor:1000000000000,assumptions:{newMembershipMonthlyMinor:1}}));assert.equal(overflow.funnel.memberships.status,'OUTPUT_LIMIT');assert.equal(overflow.funnel.trials.required,null);
 const activity=projectRevenuePlan(snapshot({baselineMethod:'ZERO_BASELINE',targetMonthlyMinor:1000000000,assumptions:{newMembershipMonthlyMinor:1,trialToMembership:1,appointmentToTrial:1,leadToAppointment:1,activitiesPerLead:2}}));assert.equal(activity.funnel.activity.status,'OUTPUT_LIMIT');
 const manualZero=projectRevenuePlan(snapshot({assumptions:{trialToMembership:1,activitiesPerLead:0}}));assert.equal(manualZero.funnel.activity.required,0);
});

test('unsafe output cannot forge a version, currency, algorithm, evidence, timestamps, hash, or leak extra fields',()=>{
 const s=snapshot();
 for(const mutate of [
  s=>s.plan.version=0,s=>s.plan.version=9999999999,s=>s.plan.algorithmVersion='fake-v2',s=>s.plan.input.expectedVersion=0,s=>s.plan.input.evidence={leads:100},s=>s.plan.principalId=principalId,
  s=>s.evidence.currency='EUR',s=>s.evidence.from='2025-01-01T00:00:00.000Z',s=>s.evidence.asOf='2026-02-30T00:00:00.000Z',s=>s.evidence.asOf='2025-01-01T00:00:00.000Z',s=>s.evidence.leads=-1,s=>s.evidence.leads=Number.MAX_SAFE_INTEGER+1,s=>s.evidence.completedTrialLeads=21,s=>s.evidence.ambiguousTrialLeads=30,s=>s.evidence.excludedMemberships=3,s=>s.evidence.personId=principalId,s=>s.snapshotHash='<script>',s=>s.validation={maxQuantity:Infinity},s=>s.evidenceState='LIVE',
 ]) {const copy=structuredClone(s);mutate(copy);assert.throws(()=>projectRevenuePlan(copy));}
 assert.throws(()=>projectRevenuePlan(s,'FORGED'));
});

test('all operations reject nonhuman/delegated/untrusted principals before database access',async()=>{
 let calls=0;const svc=new RevenuePlanningService({withTenantTransaction:()=>{calls++;throw new Error('unexpected DB');}});
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'HQ_SUPPORT'},{source:'PUBLIC_API'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]) for(const work of [()=>svc.save(context(patch),null,input()),()=>svc.list(context(patch)),()=>svc.read(context(patch),planId)]) await assert.rejects(work,status(403));
 for(const key of ['', ' leading', 'trailing ', 'a\nkey','x'.repeat(201)]) await assert.rejects(()=>svc.save(context({idempotencyKey:key}),null,input()),status(409));
 await assert.rejects(()=>svc.save(context(),planId,input()),status(400));await assert.rejects(()=>svc.save(context(),null,input({expectedVersion:1})),status(400));await assert.rejects(()=>svc.read(context(),planId,0),status(400));assert.equal(calls,0);
});

test('database denials, concurrency, bounds and timeouts are redacted API errors',async()=>{
 for(const [code,http] of [['42501',403],['P0002',404],['40001',409],['23505',409],['55P03',409],['40P01',409],['57014',503],['22003',400],['22023',400],['22P02',400],['22007',400],['23514',400],['23503',400]]) {
  const svc=new RevenuePlanningService({withTenantTransaction:async()=>{throw Object.assign(new Error('SQL_SECRET pg_catalog'),{code});}});await assert.rejects(()=>svc.save(context(),null,input()),status(http));
 }
});

test('service uses only bound fixed functions and determines LIVE/SAVED provenance rather than client metadata',async()=>{
 const queries=[];const svc=new RevenuePlanningService({withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>{queries.push({sql,args});return {rows:[{data:sql.includes('save_revenue_plan')?{snapshot:snapshot(),replayed:true}:sql.includes('read_revenue_plan')?snapshot():null}]};}})});
 assert.equal((await svc.read(context(),planId)).evidenceState,'LIVE');assert.equal((await svc.read(context(),planId,1)).evidenceState,'SAVED');assert.equal((await svc.save(context(),null,input())).projection.evidenceState,'SAVED');
 const boundaries=queries.filter(q=>q.sql.includes('revenue_plan'));assert.deepEqual(boundaries.slice(0,2).map(q=>q.args[1]),['CURRENT','SAVED']);assert.equal(boundaries[2].args[0],'verified-subject');assert.equal(JSON.parse(boundaries[2].args[2]).expectedVersion,0);
 assert(queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql)));assert(queries.some(q=>q.sql.includes('lock_timeout')));
});

test('controller resolves exact school permission and verified human identity, rejects org/HQ substitution',async()=>{
 const calls=[];const db={resolveAuthorizedScope:async(...args)=>{calls.push(args);return {organizationId,schoolId,principalId};}};
 const svc={save:async(c,id,i)=>{assert.equal(c.principalId,principalId);assert.equal(c.source,'HUMAN_UI');assert.equal(c.externalSubject,'verified-subject');assert.equal(c.idempotencyKey,'retained');return {projection:projectRevenuePlan(snapshot()),replayed:true};}};
 const controller=new RevenuePlanningController(db,svc),req={honIdentity:{externalSubject:'verified-subject'},body:{principalId:randomUUID(),source:'AI'}};
 const r=await controller.create(organizationId,schoolId,'retained',input(),req);assert.equal(r.meta.replayed,true);assert.deepEqual(calls[0],['verified-subject',schoolId,'planning.revenue.manage']);assert.equal(r.meta.requestId,r.meta.correlationId);
 await assert.rejects(()=>controller.create(randomUUID(),schoolId,'retained',input(),req),status(403));await assert.rejects(()=>controller.list(organizationId,schoolId,{}),status(403));
});

test('guard fails closed for cross-site, mismatched markers, non-JSON and missing configured origin',()=>{
 const previous=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';const execute=r=>new RevenuePlanningHumanUiGuard().canActivate({switchToHttp:()=>({getRequest:()=>r})});
 try{const headers={origin:'https://hon.test','x-hon-human-command':'revenue-planning','content-type':'application/json'};assert.equal(execute({method:'POST',headers}),true);
  for(const patch of [{origin:'https://attacker.test'},{'x-hon-human-command':'curriculum-progress'},{'content-type':'text/plain'},{'sec-fetch-site':'cross-site'}]) assert.throws(()=>execute({method:'POST',headers:{...headers,...patch}}),status(403));
  delete process.env.HON_PUBLIC_ORIGIN;assert.throws(()=>execute({method:'POST',headers}),status(503));
 }finally{if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous;}
});

test('real local HTTP pipeline validates typed payloads, closed metadata, origins, identifiers and private responses',async()=>{
 const previous=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';
 const db={resolveAuthorizedScope:async()=>({organizationId,schoolId,principalId}),withTenantTransaction:async(c,work)=>work({query:async(sql)=>({rows:sql.includes('save_revenue_plan')?[{data:{snapshot:snapshot(),replayed:false}}]:sql.includes('read_revenue_plan')?[{data:snapshot()}]:[]})})};
 const module=await Test.createTestingModule({controllers:[RevenuePlanningController],providers:[RevenuePlanningService,RevenuePlanningHumanUiGuard,{provide:RuntimeDatabaseService,useValue:db}]}).overrideGuard(HonIdentityGuard).useValue({canActivate:c=>{c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-subject'};return true;}}).compile();
 const app=module.createNestApplication();app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));
 try{await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/organizations/${organizationId}/schools/${schoolId}/planning/revenue`,headers={origin:'https://hon.test','X-HON-Human-Command':'revenue-planning','Content-Type':'application/json','Idempotency-Key':'http-test'};
  const ok=await fetch(base,{method:'POST',headers,body:JSON.stringify(input())});assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'private, no-store');assert.equal((await ok.json()).data.evidenceState,'SAVED');
  for(const field of ['principalId','algorithmVersion','version','evidence','validation','snapshotHash']) assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify({...input(),[field]:'forged'})})).status,400);
  assert.equal((await fetch(base,{method:'POST',headers:{...headers,origin:'https://attacker.test'},body:JSON.stringify(input())})).status,403);
  assert.equal((await fetch(base,{method:'POST',headers:{...headers,'Idempotency-Key':''},body:JSON.stringify(input())})).status,409);
  assert.equal((await fetch(`${base}/invalid-uuid`)).status,400);assert.equal((await fetch(`${base}/${planId}/versions/0`)).status,400);
  assert.equal((await (await fetch(`${base}/${planId}`)).json()).data.evidenceState,'LIVE');assert.equal((await (await fetch(`${base}/${planId}/versions/1`)).json()).data.evidenceState,'SAVED');
 }finally{await app.close();if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous;}
});

test('registry and implementation are inert: no AI, Action Engine, providers or downstream write clients',()=>{
 assert.equal(REVENUE_PLANNING_COMMAND_REGISTRY.length,2);for(const c of REVENUE_PLANNING_COMMAND_REGISTRY){assert.equal(c.execution,'HUMAN_ONLY');assert.equal(c.minimumTier,'ESSENTIAL');assert.equal(c.requiredPermission,'planning.revenue.manage');assert(!ACTION_CATALOG.some(a=>a.code===c.code));}
 for(const file of ['revenue-planning.service.ts','revenue-planning.controller.ts']) assert.doesNotMatch(readFileSync(`src/planning/${file}`,'utf8'),/ActionEngineService|Payment.*Service|Membership.*Service|Messaging.*Service|Ai.*Service|fetch\(|https:\/\/|invokeProvider/);
 const sql=readFileSync('../../packages/database/migrations/0072_school_revenue_planning.sql','utf8');assert.doesNotMatch(sql,/INSERT INTO hon\.(?:action_requests|crm_|billing_|communication_|ai_|payment_|work_items)/);assert.match(sql,/'planning.revenue.human_saved'/);
});
