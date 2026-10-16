const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { PromotionReadinessService } = require('../dist/testing/promotion-readiness.service.js');
const { PromotionReadinessController } = require('../dist/testing/promotion-readiness.controller.js');
const ids = Array.from({ length: 6 }, randomUUID); const [organizationId, schoolId, principalId, curriculumId, enrollmentId, requestId] = ids;
const context = patch => ({ organizationId, schoolId, principalId, externalSubject: 'verified', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, ...patch });
const status = n => e => e.getStatus() === n && !JSON.stringify(e.getResponse()).includes('SQL_SECRET');
const criterion = (code,outcome,sourceId=null,observed=null,required=null) => ({code,outcome,sourceId,observed,required,recordedAt:null});
const criteria = [criterion('ENROLLMENT','MET',enrollmentId), criterion('POLICY','CONFIGURATION_BLOCKER'), criterion('EVIDENCE','NOT_MET',null,0,1)];
const view = { organizationId,schoolId,curriculumId,enrollmentId,currentRankId:randomUUID(),nextRankId:randomUUID(),asOf:'2026-10-16T01:00:00.000Z',status:'NOT_ELIGIBLE',policyVersion:null,policyFingerprint:null,criteria,blockers:criteria.slice(1),candidate:null,attendanceRecordCount:0,evidenceCount:0 };
test('service denies AI/action/delegation and malformed selectors before database', async () => {
 let calls=0; const s=new PromotionReadinessService({withTenantReadOnlyTransaction:()=>{calls++;}});
 for(const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{actionRequestId:requestId},{delegatedByPrincipalId:principalId},{externalSubject:''}]) await assert.rejects(()=>s.read(context(patch),curriculumId,enrollmentId),status(403));
 await assert.rejects(()=>s.read(context(), 'not-uuid',enrollmentId),status(400));assert.equal(calls,0);
});
test('service invokes only fixed read-only projection and strictly rejects private/unsafe output',async()=>{
 const calls=[];let output=view;
 const s=new PromotionReadinessService({withTenantReadOnlyTransaction:async(c,work)=>work({query:async(sql,args)=>{calls.push([sql,args]);return {rows:[{data:output}]};}})});
 assert.deepEqual(await s.read(context(),curriculumId,enrollmentId),view);
 assert(calls.some(([sql])=>sql.includes("set_config('app.hon_source','HUMAN_UI'")));
 assert(calls.some(([sql,args])=>sql==='SELECT hon.read_promotion_readiness($1,$2::uuid,$3::uuid) data'&&args[0]==='verified'));
 for(const patch of [{rawPolicy:{}},{candidate:{id:requestId,testingEventId:requestId,result:'PENDING',recordedAt:view.asOf,instructorNotes:'SQL_SECRET'}},{schoolId:randomUUID()},{status:'ELIGIBLE_INSTRUCTOR_REVIEW'},{criteria:[...criteria].reverse()}]) { output={...view,...patch};await assert.rejects(()=>s.read(context(),curriculumId,enrollmentId),status(503)); }
});
test('all database and validation failures are safely mapped',async()=>{
 for(const [code,n] of [['42501',403],['P0002',404],['22023',400],['22P02',400],['57014',503],['40001',503],['XX000',503]]) await assert.rejects(()=>new PromotionReadinessService({withTenantReadOnlyTransaction:async()=>{throw Object.assign(new Error('SQL_SECRET'),{code});}}).read(context(),curriculumId,enrollmentId),status(n));
});
test('controller derives exact permission and ignores all client authority sources',async()=>{
 const calls=[];const db={resolveAuthorizedScope:async(...args)=>{calls.push(args);return {organizationId,schoolId,principalId};}};
 const controller=new PromotionReadinessController(db,{read:async(c,cu,en)=>{assert.equal(c.source,'HUMAN_UI');assert.equal(c.principalType,'HUMAN_USER');assert.equal(c.principalId,principalId);assert(!c.actionRequestId&&!c.delegatedByPrincipalId);return view;}});
 const request={honIdentity:{externalSubject:'verified'},headers:{},query:{}};
 assert.deepEqual((await controller.read(organizationId,schoolId,curriculumId,enrollmentId,request)).data,view);
 assert.deepEqual(calls[0],['verified',schoolId,'testing.promotion.readiness.read']);
 await assert.rejects(()=>controller.read(randomUUID(),schoolId,curriculumId,enrollmentId,request),status(403));
 for(const patch of [{query:{schoolId}},{body:{principalId}},{body:[]},{headers:{'sec-fetch-site':'cross-site'}}]) await assert.rejects(()=>controller.read(organizationId,schoolId,curriculumId,enrollmentId,{...request,...patch}),status(patch.headers?403:400));
});
test('new migration and HTTP surface remain read-only and cache private',()=>{
 const root=require('node:path').join(__dirname,'../../..');
 const sql=readFileSync(root+'/packages/database/migrations/0116_human_promotion_readiness.sql','utf8').split('CREATE FUNCTION')[1].split('REVOKE ALL')[0];
 assert.doesNotMatch(sql.replace(/--[^\n]*/g,''),/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i);
 const controller=readFileSync(root+'/apps/api/src/testing/promotion-readiness.controller.ts','utf8');
 assert.match(controller,/@Header\('Cache-Control', 'private, no-store'\)/);assert.doesNotMatch(controller,/@Post|@Patch|@Delete/);
});
