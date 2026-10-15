const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { ValidationPipe } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { CurriculumProgressService } = require('../dist/curriculum/curriculum-progress.service.js');
const { CurriculumProgressController } = require('../dist/curriculum/curriculum-progress.controller.js');
const { CurriculumHumanUiGuard } = require('../dist/curriculum/curriculum-human-ui.guard.js');
const { TestingHumanUiGuard } = require('../dist/testing/testing-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { ParentStudentJourneyService } = require('../dist/families/parent-student-journey.service.js');
const dto = require('../dist/curriculum/curriculum-progress.dto.js');
const { ACTION_CATALOG, CURRICULUM_PROGRESS_COMMAND_REGISTRY } = require('@hon/config');
const ids = Array.from({ length: 7 }, randomUUID);
const [organizationId, schoolId, principalId, curriculumId, rankId, enrollmentId, familyId] = ids;
const context = (extra = {}) => ({ organizationId, schoolId, principalId, principalType:'HUMAN_USER', source:'HUMAN_UI', externalSubject:'verified-subject', requestId:randomUUID(), correlationId:randomUUID(), idempotencyKey:randomUUID(), ...extra });
const requirement = { code:'BASICS',kind:'TECHNIQUE',definition:{label:'Foundation',description:'Private staff definition'},required:true };
const status = expected => error => { assert.equal(error.getStatus(),expected); assert.doesNotMatch(JSON.stringify(error.getResponse()),/SQL_SECRET|password|pg_catalog/); return true; };

test('global DTO whitelist allows closed typed commands and rejects forged authority, nested evidence and invalid versions',async()=>{
 const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
 for(const [kind,metatype,input] of [
  ['REQUIREMENT_CREATE',dto.CreateCurriculumRequirementDto,requirement],
  ['REQUIREMENT_UPDATE',dto.UpdateCurriculumRequirementDto,{...requirement,expectedVersion:1}],
  ['ENROLL',dto.EnrollStudentCurriculumDto,{studentProfileId:ids[0],currentRankId:null}],
  ['SET_RANK',dto.SetStudentCurriculumRankDto,{currentRankId:rankId,expectedEnrollmentVersion:1}],
  ['OBSERVE',dto.RecordCurriculumProgressDto,{requirementId:rankId,expectedRequirementVersion:1,expectedEnrollmentVersion:1,expectedProgressVersion:0,status:'MET',instructorNote:'staff only'}],
 ]) {
  const transformed=await pipe.transform(input,{type:'body',metatype});dto.validateCurriculumInput(kind,transformed);
  await assert.rejects(()=>pipe.transform({...input,instructorPrincipalId:principalId},{type:'body',metatype}),status(400));
 }
 for(const input of [{...requirement,definition:{label:'Safe',notes:'evidence'}},{...requirement,required:'true'},{...requirement,definition:{label:'x'.repeat(161)}},{...requirement,definition:{label:'a\nb'}}]) assert.throws(()=>dto.validateCurriculumInput('REQUIREMENT_CREATE',input),status(400));
 assert.throws(()=>dto.validateCurriculumInput('OBSERVE',{requirementId:rankId,expectedRequirementVersion:1,expectedEnrollmentVersion:1,expectedProgressVersion:-1,status:'READY'}),status(400));
});

test('all curriculum mutations reject nonhuman, delegated, untrusted sources and missing keys before touching DB',async()=>{
 let calls=0;const svc=new CurriculumProgressService({withTenantTransaction:()=>{calls++;throw new Error('unexpected DB');}});
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{source:'PUBLIC_API'},{source:'AI'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]) {
  await assert.rejects(()=>svc.createRequirement(context(patch),curriculumId,rankId,requirement),status(403));
 }
 await assert.rejects(()=>svc.enroll(context({idempotencyKey:''}),curriculumId,{studentProfileId:ids[0],currentRankId:null}),status(409));
 await assert.rejects(()=>svc.observe(context(),curriculumId,enrollmentId,{status:'MET',instructorPrincipalId:principalId}),status(400));
 assert.equal(calls,0);
});

test('database denials and concurrency/timeout failures are clean API errors, never a SQL response',async()=>{
 for(const [code,http] of [['42501',403],['P0002',404],['40001',409],['23505',409],['55P03',409],['40P01',409],['57014',503],['23503',400],['23514',400]]) {
  const svc=new CurriculumProgressService({withTenantTransaction:async()=>{throw Object.assign(new Error('SQL_SECRET pg_catalog'),{code});}});
  await assert.rejects(()=>svc.createRequirement(context(),curriculumId,rankId,requirement),status(http));
 }
});

test('curriculum controller uses exact permission and verified server principal rather than body identity',async()=>{
 const calls=[];const db={resolveAuthorizedScope:async(...args)=>{calls.push(args);return {organizationId,schoolId,principalId};}};
 const svc={enroll:async(c,cur,input)=>{assert.equal(c.principalId,principalId);assert.equal(c.externalSubject,'verified-subject');assert.equal(c.source,'HUMAN_UI');assert.equal(cur,curriculumId);return {record:input,replayed:false};}};
 const controller=new CurriculumProgressController(db,svc);
 const req={honIdentity:{externalSubject:'verified-subject'},body:{principalId:familyId,source:'AI'}};
 await controller.enroll(organizationId,schoolId,curriculumId,'key',{studentProfileId:ids[0],currentRankId:null},req);
 assert.deepEqual(calls[0],['verified-subject',schoolId,'curriculum.progress.record']);
 await assert.rejects(()=>controller.enroll(randomUUID(),schoolId,curriculumId,'key',{},req),status(403));
});

test('curriculum and testing guards fail closed on origin, command marker, JSON and cross-site requests',()=>{
 const prior=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';
 try {
  const execute=(guard,r)=>guard.canActivate({switchToHttp:()=>({getRequest:()=>r})});
  const headers={origin:'https://hon.test','x-hon-human-command':'curriculum-progress','content-type':'application/json'};
  assert.equal(execute(new CurriculumHumanUiGuard(),{method:'POST',headers}),true);
  assert.equal(execute(new CurriculumHumanUiGuard(),{method:'GET',headers:{}}),true);
  for(const patch of [{origin:'https://attacker.test'},{'x-hon-human-command':'testing'},{'content-type':'text/plain'},{'sec-fetch-site':'cross-site'}]) assert.throws(()=>execute(new CurriculumHumanUiGuard(),{method:'POST',headers:{...headers,...patch}}),status(403));
  assert.equal(execute(new TestingHumanUiGuard(),{method:'POST',headers:{...headers,'x-hon-human-command':'testing'}}),true);
 }finally{if(prior===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=prior;}
});

test('parent service requires external subject and returns a clean 403 for stale grants, not raw SQL',async()=>{
 const scope={organizationId,schoolId,principalId,familyId,accessLevel:'PRIMARY_GUARDIAN'};
 let calls=0;const svc=new ParentStudentJourneyService({withTenantTransaction:async()=>{calls++;throw Object.assign(new Error('SQL_SECRET'),{code:'42501'});}});
 await assert.rejects(()=>svc.get(scope,familyId,randomUUID()),status(403));assert.equal(calls,0);
 await assert.rejects(()=>svc.get(scope,randomUUID(),randomUUID(),'verified-subject'),status(403));
 await assert.rejects(()=>svc.get(scope,familyId,randomUUID(),'verified-subject'),status(403));assert.equal(calls,1);
});

test('parent projection is constructed from safe fields only; an observation does not change testing or rank',async()=>{
 const scope={organizationId,schoolId,principalId,familyId,accessLevel:'PRIMARY_GUARDIAN'};
 const progress={enrollmentId,requirementId:rankId,label:'Safe practice',kind:'TECHNIQUE',required:true,status:'MET',recordedAt:'2026-01-01T00:00:00Z',instructorNote:'SQL_SECRET',principalId};
 const queries=[];const svc=new ParentStudentJourneyService({withTenantTransaction:async(_,work)=>work({query:async(sql)=>{
  queries.push(sql);
  if(sql.includes('read_parent_curriculum_progress'))return {rows:[{data:[progress]}]};
  if(sql.includes('FROM hon.family_members'))return {rows:[{familyMemberId:randomUUID(),studentProfileId:ids[0],studentProfileStatus:'ACTIVE',personId:randomUUID(),givenName:'Child',familyName:'Safe'}]};
  if(sql.includes('FROM hon.student_curriculum_enrollments'))return {rows:[{id:enrollmentId,studentProfileId:ids[0],status:'ACTIVE',enrolledAt:'2026-01-01T00:00:00Z',curriculumId,curriculumName:'Practice',currentRankId:rankId,currentRankName:'White',currentRankProgressionOrder:1}]};
  return {rows:[]};
 }})});
 const result=await svc.get(scope,familyId,randomUUID(),'verified-subject');
 const e=result.students[0].curriculumEnrollments[0];assert.equal(e.currentRank.id,rankId);assert.equal(e.testingCandidates.length,0);assert.equal(e.requirementProgress[0].status,'MET');
 assert.deepEqual(Object.keys(e.requirementProgress[0]).sort(),['enrollmentId','requirementId','label','kind','required','status','recordedAt'].sort());
 assert.doesNotMatch(JSON.stringify(result),/SQL_SECRET|instructorNote|principalId/);
 assert.equal(queries.filter(q=>q.includes('read_parent_curriculum_progress')).length,2);
 assert(queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/i.test(q)));
});

test('curriculum registry is inert and no commands import downstream executors or provider clients',()=>{
 assert.equal(CURRICULUM_PROGRESS_COMMAND_REGISTRY.length,5);
 for(const c of CURRICULUM_PROGRESS_COMMAND_REGISTRY) {assert.equal(c.execution,'HUMAN_ONLY');assert.equal(c.source,'HUMAN_UI');assert(!ACTION_CATALOG.some(a=>a.code===c.code));}
 for(const file of ['curriculum-progress.service.ts','curriculum-progress.controller.ts']) {
  const src=readFileSync(`src/curriculum/${file}`,'utf8');assert.doesNotMatch(src,/ActionEngineService|Payment.*Service|Membership.*Service|Messaging.*Service|Ai.*Service|fetch\(|https:\/\/|invokeProvider/);
 }
});

test('real HTTP pipeline accepts typed JSON, blocks forged fields and origin, and emits private no-store metadata',async()=>{
 const previous=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';
 const db={resolveAuthorizedScope:async()=>({organizationId,schoolId,principalId}),withTenantTransaction:async(c,work)=>work({query:async(sql)=>({rows:sql.includes('mutate_curriculum_progress')?[{data:{record:{id:enrollmentId,version:1},replayed:false}}]:[]})})};
 const module=await Test.createTestingModule({controllers:[CurriculumProgressController],providers:[CurriculumProgressService,CurriculumHumanUiGuard,{provide:RuntimeDatabaseService,useValue:db}]}).overrideGuard(HonIdentityGuard).useValue({canActivate:c=>{c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-subject'};return true;}}).compile();
 const app=module.createNestApplication();app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));
 try {
  await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/organizations/${organizationId}/schools/${schoolId}/curricula/${curriculumId}/enrollments`;
  const input={studentProfileId:ids[0],currentRankId:null},headers={origin:'https://hon.test','X-HON-Human-Command':'curriculum-progress','Content-Type':'application/json','Idempotency-Key':'http-test'};
  const ok=await fetch(base,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'private, no-store');assert.equal((await ok.json()).data.id,enrollmentId);
  const forged=await fetch(base,{method:'POST',headers,body:JSON.stringify({...input,principalId:familyId})});assert.equal(forged.status,400);
  const cross=await fetch(base,{method:'POST',headers:{...headers,origin:'https://attacker.test'},body:JSON.stringify(input)});assert.equal(cross.status,403);
 }finally{await app.close();if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous;}
});
