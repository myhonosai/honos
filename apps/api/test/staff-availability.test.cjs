const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { StaffAvailabilityService } = require('../dist/staff-availability/staff-availability.service.js');
const { StaffAvailabilityController } = require('../dist/staff-availability/staff-availability.controller.js');
const { StaffAvailabilityHumanUiGuard } = require('../dist/staff-availability/staff-availability.dto.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { validateStaffRevision } = require('@hon/contracts');
const { STAFF_AVAILABILITY_COMMAND_REGISTRY, ACTION_CATALOG } = require('@hon/config');
const scope={organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID()};
const ctx=(p={})=>({...scope,externalSubject:'verified-session',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...p});
const availability=(p={})=>({expectedVersion:0,status:'ACTIVE',effectiveFrom:'2026-01-01',endsOn:null,windows:[{weekday:1,start:'09:00',end:'17:00'}],...p});
const qualifications=(p={})=>({expectedVersion:0,status:'ACTIVE',effectiveFrom:'2026-01-01',endsOn:null,qualifications:[{title:'First aid',issuer:'Human label',expiresOn:'2027-12-31'}],...p});
const status=n=>e=>e.getStatus?.()===n;
test('staff windows and unverified qualifications use bounded closed formats and meaningful times/dates',()=>{
 validateStaffRevision('AVAILABILITY',availability());validateStaffRevision('QUALIFICATIONS',qualifications());validateStaffRevision('AVAILABILITY',availability({windows:[{weekday:7,start:'23:00',end:'24:00'}]}));validateStaffRevision('AVAILABILITY',availability({expectedVersion:1,status:'ENDED',windows:[]}));
 for(const p of [{expectedVersion:-1},{expectedVersion:1.1},{expectedVersion:999999999},{status:'ASSIGNED'},{effectiveFrom:'2026-02-30'},{effectiveFrom:'2026-01-01T00:00:00Z'},{endsOn:'2025-12-31'},{endsOn:'2040-01-01'},{endsOn:undefined},{schoolId:scope.schoolId},{actorId:scope.principalId},{source:'HUMAN_UI'},{payRate:100},{qualifications:[]},{windows:[{weekday:0,start:'09:00',end:'10:00'}]},{windows:[{weekday:'1',start:'09:00',end:'10:00'}]},{windows:[{weekday:1,start:'9:00',end:'10:00'}]},{windows:[{weekday:1,start:'24:00',end:'24:15'}]},{windows:[{weekday:1,start:'23:00',end:'01:00'}]},{windows:[{weekday:1,start:'09:00',end:'09:14'}]},{windows:[{weekday:1,start:'09:00',end:'10:00',classId:randomUUID()}]},{windows:[{weekday:1,start:'09:00',end:'10:00'},{weekday:1,start:'09:30',end:'11:00'}]},{windows:Array.from({length:29},()=>({weekday:1,start:'09:00',end:'10:00'}))},{status:'ENDED'}])assert.throws(()=>validateStaffRevision('AVAILABILITY',availability(p)),JSON.stringify(p));
 for(const q of [{title:'',issuer:'X',expiresOn:null},{title:' padded',issuer:'X',expiresOn:null},{title:'x\u202e',issuer:'X',expiresOn:null},{title:'X',issuer:'y'.repeat(121),expiresOn:null},{title:'X',issuer:'Y',expiresOn:'2027-02-30'},{title:'X',issuer:'Y',expiresOn:'infinity'},{title:'X',issuer:'Y',documentUrl:'https://credential.test',expiresOn:null},{title:'X',issuer:'Y'}])assert.throws(()=>validateStaffRevision('QUALIFICATIONS',qualifications({qualifications:[q]})));
 assert.throws(()=>validateStaffRevision('QUALIFICATIONS',qualifications({qualifications:[{title:'X',issuer:'Y',expiresOn:null},{title:'x',issuer:'y',expiresOn:null}]})));
});
test('service rejects nonhuman/source/delegation before SQL, uses only exact local transactions, and maps live errors',async()=>{
 const calls=[],svc=new StaffAvailabilityService({withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>{calls.push([sql,args]);return {rows:[{data:{revision:{version:1},replayed:false}}]};}})});
 await svc.save(ctx(),null,'AVAILABILITY',availability());assert.match(calls.at(-1)[0],/^SELECT hon.save_staff_planning_revision/);assert.equal(calls.at(-1)[1][1],null);assert.match(calls[0][0],/set_config.*true/);
 for(const p of [{source:'AI'},{source:'PARENT_APP'},{source:'PUBLIC_API'},{source:'HQ_SUPPORT'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){const n=calls.length;await assert.rejects(async()=>svc.save(ctx(p),null,'AVAILABILITY',availability()),status(403));assert.equal(calls.length,n);await assert.rejects(async()=>svc.read(ctx(p),null),status(403));}
 await assert.rejects(async()=>svc.save(ctx({idempotencyKey:''}),null,'AVAILABILITY',availability()),status(409));
 for(const [code,http]of [['42501',403],['P0002',404],['40001',409],['23505',409],['22023',400],['57014',503]])await assert.rejects(()=>new StaffAvailabilityService({withTenantTransaction:async()=>{throw {code};}}).read(ctx(),null),status(http));
});
test('controller derives session scope and source, rejects ambiguous schools and has no listing or authority input',async()=>{
 const seen=[],controller=new StaffAvailabilityController({resolveStaffAvailabilityScope:async(s,p)=>{seen.push([s,p]);return scope;}},{read:async(c,t)=>{assert.equal(c.source,'HUMAN_UI');assert.equal(c.principalId,scope.principalId);assert.equal(c.externalSubject,'verified-session');assert.equal(t,null);return {planningOnly:true};}});
 await controller.read('self',{honIdentity:{externalSubject:'verified-session'},body:{schoolId:randomUUID(),actorId:randomUUID()}});assert(seen.every(x=>x[0]==='verified-session'));
 await assert.rejects(()=>controller.read('self',{}),status(403));
 const ambiguous=new StaffAvailabilityController({resolveStaffAvailabilityScope:async(s,p)=>({...scope,schoolId:p.endsWith('self_manage')?scope.schoolId:randomUUID()})},{});await assert.rejects(()=>ambiguous.read('self',{honIdentity:{externalSubject:'verified-session'}}),status(403));
});
test('human UI guard requires trusted same-origin JSON and exact human command',()=>{
 const old=process.env.HON_PUBLIC_ORIGIN,guard=new StaffAvailabilityHumanUiGuard(),run=(method,headers)=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method,headers})})}),headers={origin:'https://hon.test','content-type':'application/json','x-hon-human-command':'staff-availability','sec-fetch-site':'same-origin'};
 try{delete process.env.HON_PUBLIC_ORIGIN;assert.throws(()=>run('POST',headers),status(503));process.env.HON_PUBLIC_ORIGIN='https://hon.test';assert(run('POST',headers));assert(run('GET',{}));for(const p of [{origin:'https://evil.test'},{origin:'https://hon.test/'},{origin:['https://hon.test']},{'x-hon-human-command':'staff-roles'},{'content-type':'text/plain'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'}])assert.throws(()=>run('POST',{...headers,...p}),status(403));for(const m of ['PUT','PATCH','DELETE'])assert.throws(()=>run(m,headers),status(403));}finally{if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('local HTTP endpoints enforce closed DTOs, known-ID only, no DELETE/list and no forged success',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';
 const database={resolveStaffAvailabilityScope:async()=>scope,withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>({rows:[{data:sql.startsWith('SELECT hon.save_staff_planning_revision')?{revision:{...availability(),version:1,planningOnly:true},replayed:false}:{planningOnly:true}}]})})};
 const module=await Test.createTestingModule({controllers:[StaffAvailabilityController],providers:[StaffAvailabilityService,StaffAvailabilityHumanUiGuard,{provide:RuntimeDatabaseService,useValue:database}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-session'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/team/availability`,headers={origin:'https://hon.test','Content-Type':'application/json','X-HON-Human-Command':'staff-availability','Idempotency-Key':'retry-key'};
 try{assert.equal((await fetch(`${base}/self/availability/versions`,{method:'POST',headers,body:JSON.stringify(availability())})).status,200);for(const p of [{schoolId:scope.schoolId},{source:'HUMAN_UI'},{principalId:scope.principalId},{windows:[{weekday:1,start:'10:00',end:'09:00'}]},{qualifications:[]}])assert.equal((await fetch(`${base}/self/availability/versions`,{method:'POST',headers,body:JSON.stringify(availability(p))})).status,400);assert.equal((await fetch(base)).status,404);assert.equal((await fetch(`${base}/not-a-uuid`)).status,400);assert.equal((await fetch(`${base}/self`,{method:'DELETE',headers})).status,404);assert.equal((await fetch(`${base}/self`)).headers.get('cache-control'),'private, no-store');assert.equal((await fetch(`${base}/self/availability/versions`,{method:'POST',headers:{...headers,origin:'https://evil.test'},body:JSON.stringify(availability())})).status,403);}finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('staff registry has exact Essential human-only conventional codes and no forbidden execution adapters',()=>{
 assert.equal(STAFF_AVAILABILITY_COMMAND_REGISTRY.length,3);for(const c of STAFF_AVAILABILITY_COMMAND_REGISTRY){assert.equal(c.minimumTier,'ESSENTIAL');assert.equal(c.execution,'HUMAN_ONLY');assert.equal(c.source,'HUMAN_UI');assert(c.planningOnly);assert(!ACTION_CATALOG.some(a=>a.code===c.code));}
 for(const f of ['staff-availability.service.ts','staff-availability.controller.ts'])assert.doesNotMatch(readFileSync(`src/staff-availability/${f}`,'utf8'),/ActionEngineService|Ai.*Service|Payment.*Service|Messaging.*Service|fetch\(|invokeProvider/);
 const sql=readFileSync('../../packages/database/migrations/0077_human_staff_availability.sql','utf8');assert.doesNotMatch(sql,/(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:class_sessions|class_session_instructors|class_templates|attendance_records|memberships|invoices|payment_attempts|communication_messages|action_requests|ai_usage_ledger|work_items)/);assert.match(sql,/'staff.planning.human_revised'/);
});
