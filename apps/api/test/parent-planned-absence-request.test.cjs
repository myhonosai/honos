const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { ParentPlannedAbsenceRequestService } = require('../dist/families/parent-planned-absence-request.service.js');
const { ParentPlannedAbsenceRequestController, ParentPlannedAbsenceRequestGuard } = require('../dist/families/parent-planned-absence-request.controller.js');
const { ParentPlannedAbsenceService } = require('../dist/families/parent-planned-absence.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope = { principalId: randomUUID(), organizationId: randomUUID(), schoolId: randomUUID(), familyId: randomUUID(), accessLevel: 'PRIMARY_GUARDIAN' };
const child = randomUUID(), context = { children: [{ studentProfileId: child, displayName: 'Authorized child' }] };
const input = () => ({ studentProfileId: child, startsAt: new Date(Date.now()+86400000).toISOString(), endsAt: new Date(Date.now()+86400000+3600000).toISOString(), reason: 'Private reason' });
const status = expected => error => { assert.equal(error.getStatus(), expected); return true; };
const db = (overrides={}) => ({ resolveParentJourneyScopes: async () => [scope], readParentPlannedAbsenceRequestContext: async () => context, ...overrides });

test('selector-free context and submit derive only verified subject, preserve canonical human command and redact receipt', async () => {
 const calls=[]; const canonical={ request:async (...args) => { calls.push(args); return { plannedAbsenceRequest:{ status:'SUBMITTED', createdAt:'2026-10-17T00:00:00.000Z', familyId:scope.familyId, reason:'PRIVATE', reviewNote:'PRIVATE', id:randomUUID() }, replayed:false }; } };
 const service=new ParentPlannedAbsenceRequestService(db(),canonical);
 assert.deepEqual((await service.context('verified-subject')).data,context);
 const value=input(); const result=await service.submit('verified-subject',value,' retained-key ');
 assert.deepEqual(result.data,{status:'SUBMITTED',submittedAt:'2026-10-17T00:00:00.000Z'});
 assert.equal(calls.length,1); assert.deepEqual(calls[0][0],scope); assert.equal(calls[0][1],scope.familyId); assert.equal(calls[0][4],'verified-subject'); assert.deepEqual(calls[0][3],value);
 assert.equal(calls[0][2].source,'HUMAN_UI'); assert.equal(calls[0][2].principalType,'HUMAN_USER'); assert.equal(calls[0][2].idempotencyKey,'retained-key');
 assert.doesNotMatch(JSON.stringify(result),/familyId|schoolId|organizationId|principalId|studentProfileId|reason|reviewNote|PRIVATE/);
});
test('zero, multiple, viewer, mixed, changed, revoked and tampered children fail without command or choices', async () => {
 let commands=0; const canonical={request:async()=>{commands++; throw new Error('unexpected');}};
 for (const [scopes,code] of [[[],403],[[scope,{...scope,familyId:randomUUID()}],409],[[{...scope,accessLevel:'VIEWER'}],403],[[scope,{...scope,accessLevel:'VIEWER'}],409]]) {
  const service=new ParentPlannedAbsenceRequestService(db({resolveParentJourneyScopes:async()=>scopes}),canonical);
  await assert.rejects(service.context('subject'),status(code)); await assert.rejects(service.submit('subject',input(),'key'),status(code));
 }
 let n=0; await assert.rejects(new ParentPlannedAbsenceRequestService(db({resolveParentJourneyScopes:async()=>++n===1?[scope]:[]}),canonical).context('revoked'),status(403));
 await assert.rejects(new ParentPlannedAbsenceRequestService(db({readParentPlannedAbsenceRequestContext:async()=>{throw Object.assign(new Error('PRIVATE'),{code:'42501'});}}),canonical).context('mixed-live-grants'),status(403));
 for (const candidate of [randomUUID(),randomUUID()]) await assert.rejects(new ParentPlannedAbsenceRequestService(db(),canonical).submit('subject',{...input(),studentProfileId:candidate},'key'),status(403));
 assert.equal(commands,0);
});
test('wrapper and canonical service preserve strict validation and 90-day future constraints before writes', async () => {
 const canonical=new ParentPlannedAbsenceService({withTenantTransaction:async()=>{throw new Error('must not write');}});
 const service=new ParentPlannedAbsenceRequestService(db(),canonical);
 for (const changes of [{startsAt:'2026-02-30T09:00:00Z'},{startsAt:'2030-01-01T00:00:00Z'},{startsAt:'2026-01-01'},{startsAt:new Date(Date.now()-1).toISOString()},{endsAt:new Date(Date.now()+100*86400000).toISOString()},{endsAt:new Date(Date.now()+1000).toISOString()},{reason:' '},{reason:'a'.repeat(1001)},{reason:null},{schoolId:scope.schoolId},{familyId:scope.familyId},{status:'APPROVED'},{source:'AI'}]) await assert.rejects(service.submit('subject',{...input(),...changes},'key'),status(400));
 for(const key of ['', 'a'.repeat(201), 'key\n']) await assert.rejects(service.submit('subject',input(),key),status(409));
});
test('real HTTP requires exact POST human marker/origin, accepts no tenant selectors and returns no downstream claims', async () => {
 const prior=process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN='https://hon.test'; let commands=0;
 const canonical={request:async()=>{commands++;return {plannedAbsenceRequest:{status:'SUBMITTED',createdAt:'2026-10-17T00:00:00.000Z',reason:'PRIVATE'},replayed:commands>1};}};
 const module=await Test.createTestingModule({controllers:[ParentPlannedAbsenceRequestController],providers:[ParentPlannedAbsenceRequestService,ParentPlannedAbsenceRequestGuard,{provide:RuntimeDatabaseService,useValue:db()},{provide:ParentPlannedAbsenceService,useValue:canonical}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-subject'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/parent/planned-absences`;
 const headers={'Content-Type':'application/json','Origin':'https://hon.test','X-HON-Human-Command':'parent-planned-absence','Idempotency-Key':'key','Sec-Fetch-Site':'same-origin'};
 const post=(body=input(),extra={},url=base)=>fetch(url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 try {
  const read=await fetch(base+'/context');assert.equal(read.status,200);assert.deepEqual((await read.json()).data,context);assert.equal(read.headers.get('cache-control'),'private, no-store');
  assert.equal((await fetch(base+'/context?schoolId='+scope.schoolId)).status,400);
  assert.equal((await fetch(base+'/context',{headers:{'X-HON-Family-ID':scope.familyId}})).status,403);
  for(const extra of [{Origin:'https://evil.test'},{'X-HON-Human-Command':''},{'Sec-Fetch-Site':'cross-site'},{'X-HON-Family-ID':scope.familyId}]) assert.equal((await post(input(),extra)).status,403);
  for(const changes of [{schoolId:scope.schoolId},{familyId:scope.familyId},{principalId:scope.principalId},{status:'APPROVED'},{provider:'PRIVATE'}]) assert.equal((await post({...input(),...changes})).status,400);
  assert.equal((await post(input(),{},base+'?familyId='+scope.familyId)).status,400);assert.equal(commands,0);
  const first=await post();assert.equal(first.status,201);assert.deepEqual((await first.json()).data,{status:'SUBMITTED',submittedAt:'2026-10-17T00:00:00.000Z'});assert.equal((await post()).status,200);
  for(const suffix of ['review','approve','cancel','attendance','bookings','makeup','messages','payments','actions','ai']) assert.equal((await post(input(),{},base+'/'+suffix)).status,404);
 } finally { await app.close();if(prior===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=prior; }
});
test('new wrapper has no staff review, schedule, attendance, booking, messaging, payment or provider dependency',()=>{
 for(const file of ['parent-planned-absence-request.controller.ts','parent-planned-absence-request.service.ts']) assert.doesNotMatch(readFileSync('src/families/'+file,'utf8'),/from\s+['"][^'"]*(?:schedule|communication|provider|billing|action|voice|ai\/)[^'"]*['"]|fetch\(/);
 const migration=readFileSync('../../packages/database/migrations/0143_parent_planned_absence_request_context.sql','utf8');assert.doesNotMatch(migration,/(?:INSERT\s+INTO|UPDATE\s+hon\.|DELETE\s+FROM)|class_sessions|class_bookings|attendance_records|communication_messages|payment_attempts/i);
});
