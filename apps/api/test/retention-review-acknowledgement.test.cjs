require('reflect-metadata');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {PATH_METADATA,METHOD_METADATA}=require('@nestjs/common/constants');
const {RetentionReviewController}=require('../dist/retention-review/retention-review.controller.js');
const {RetentionReviewService}=require('../dist/retention-review/retention-review.service.js');
const {RetentionReviewHumanUiGuard}=require('../dist/retention-review/retention-review.dto.js');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const apiSource=path=>readFileSync(join(__dirname,'..',path),'utf8');
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const membershipId=id('1'),schoolId=id('2'),principalId=id('3'),organizationId=id('4'),requestId=id('5');
const context={organizationId,schoolId,principalId,requestId,correlationId:requestId,externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI'};
const value={evidenceVersion:'RETENTION_REVIEW_SIGNALS_V1',evidenceFingerprint:'a'.repeat(64),observedAt:'2026-10-16T00:00:00.000Z',idempotencyKey:id('6')};
const result={schemaVersion:'RETENTION_REVIEW_ACKNOWLEDGEMENT_V1',membershipId,acknowledgementId:id('7'),evidenceVersion:value.evidenceVersion,evidenceFingerprint:value.evidenceFingerprint,observedAt:value.observedAt,recordedAt:'2026-10-16T00:00:01.000Z',state:'EVIDENCE_REVIEWED',humanOnly:true,evidenceOnly:true,noDownstreamEffect:true};
const status=n=>error=>error.getStatus()===n;
test('retention acknowledgement controller derives human scope and accepts no caller authority',async()=>{
 const calls=[];const controller=new RetentionReviewController({resolveRetentionReviewScope:async(...args)=>{calls.push(args);return{organizationId,schoolId,principalId};}},{acknowledge:async(...args)=>{calls.push(args);return result;}});
 const output=await controller.acknowledge({schoolId,membershipId},value,{honIdentity:{externalSubject:'verified'},source:'AI',organizationId:'spoof',tier:'COMPLETE'});
 assert.deepEqual(calls[0],['verified',schoolId]);assert.equal(calls[1][0].source,'HUMAN_UI');assert.equal(calls[1][0].principalType,'HUMAN_USER');assert.equal(calls[1][0].organizationId,organizationId);assert.deepEqual(output.data,{retentionReviewAcknowledgement:result});
 assert.equal(Reflect.getMetadata(PATH_METADATA,RetentionReviewController.prototype.acknowledge),'acknowledgement');assert.equal(Reflect.getMetadata(METHOD_METADATA,RetentionReviewController.prototype.acknowledge),1);
 for(const query of [{schoolId,membershipId,principalId},{schoolId,membershipId,tier:'COMPLETE'},{schoolId:'unsafe',membershipId}])await assert.rejects(()=>controller.acknowledge(query,value,{honIdentity:{externalSubject:'verified'}}),status(400));
 await assert.rejects(()=>controller.acknowledge({schoolId,membershipId},value,{}),status(403));
});
test('acknowledgement service uses one fixed command; rejects malformed input and nonhuman/delegated/action context before DB',async()=>{
 let calls=0;const service=new RetentionReviewService({acknowledgeRetentionReviewEvidence:async(c,m,input)=>{calls++;assert.deepEqual(c,context);assert.equal(m,membershipId);assert.deepEqual(input,value);return result;}});
 assert.deepEqual(await service.acknowledge(context,membershipId,value),result);assert.equal(calls,1);
 for(const patch of [{source:'AI'},{principalType:'AI_EMPLOYEE'},{principalType:'PARENT'},{actionRequestId:id('8')},{delegatedByPrincipalId:id('8')}])await assert.rejects(()=>service.acknowledge({...context,...patch},membershipId,value),status(403));
 for(const patch of [{note:'private'},{schoolId},{evidenceVersion:'V2'},{evidenceFingerprint:'private'},{idempotencyKey:'text'},{observedAt:'bad'}])await assert.rejects(()=>service.acknowledge(context,membershipId,{...value,...patch}),status(400));
 assert.equal(calls,1);
});
test('acknowledgement output is bound, closed, effect-free; conflicts and inaccessible scope are honest',async()=>{
 for(const patch of [{state:'RESOLVED'},{email:'private@example.test'},{membershipId:schoolId},{noDownstreamEffect:false},{evidenceFingerprint:'b'.repeat(64)},{observedAt:'2026-10-15T00:00:00.000Z'},{recordedAt:'2026-10-16T00:10:00.000Z'}]){
  const service=new RetentionReviewService({acknowledgeRetentionReviewEvidence:async()=>({...result,...patch})});await assert.rejects(()=>service.acknowledge(context,membershipId,value),status(503));
 }
 for(const [code,n]of [['40001',409],['40P01',409],['55P03',409],['42501',403],['P0002',404],['22023',400],['unexpected',503]]){
  const service=new RetentionReviewService({acknowledgeRetentionReviewEvidence:async()=>{throw{code};}});await assert.rejects(()=>service.acknowledge(context,membershipId,value),status(n));
 }
});
test('same-origin guard requires the exact acknowledgement marker and configured origin for POST',()=>{
 const guard=new RetentionReviewHumanUiGuard();const run=(method,headers)=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method,headers})})});
 assert.equal(run('GET',{'sec-fetch-site':'same-origin'}),true);
 for(const [method,headers]of [['GET',{'sec-fetch-site':'cross-site'}],['PATCH',{}],['POST',{'sec-fetch-site':'cross-site'}],['POST',{'content-type':'application/json','x-hon-human-command':'other'}]])assert.throws(()=>run(method,headers));
 const source=apiSource('src/retention-review/retention-review.dto.ts');assert.match(source,/retention-review-acknowledgement/);
});
test('unchanged read stays READ ONLY; acknowledgement has no downstream client or provider integration',()=>{
  const adapter=apiSource('src/foundation/runtime-database.service.ts');const read=adapter.split('  async readRetentionReviewSignals(')[1].split('  async readTestingCertificate(')[0];assert.match(read,/SET TRANSACTION READ ONLY/);assert.match(read,/SELECT hon.read_retention_review_signals/);assert.doesNotMatch(read,/acknowledge_retention/);
  const source=apiSource('src/retention-review/retention-review.service.ts');assert.doesNotMatch(source,/executeAction|invokeLLM|sendMessage|providerClient|paymentClient|refundMembership/);
});

test('factual attention routes retain the exact direct-human and read-only boundaries',async()=>{
 const attentionEvidence={signals:{...result,membershipId},evidenceVersion:'RETENTION_REVIEW_SIGNALS_V1',evidenceFingerprint:'a'.repeat(64),attentionCodes:[]};
 const calls=[];const controller=new RetentionReviewController({resolveRetentionReviewScope:async(...args)=>{calls.push(args);return{organizationId,schoolId,principalId};}},{attentionEvidence:async(...args)=>{calls.push(args);return attentionEvidence;}});
 const output=await controller.attentionEvidence({schoolId,membershipId},{honIdentity:{externalSubject:'verified'},source:'AI',organizationId:'spoof'});
 assert.deepEqual(calls[0],['verified',schoolId]);assert.equal(calls[1][0].source,'HUMAN_UI');assert.equal(calls[1][0].principalType,'HUMAN_USER');assert.deepEqual(output.data,{retentionAttentionEvidence:attentionEvidence});
 assert.equal(Reflect.getMetadata(PATH_METADATA,RetentionReviewController.prototype.attentionEvidence),'attention-evidence');assert.equal(Reflect.getMetadata(METHOD_METADATA,RetentionReviewController.prototype.attentionEvidence),0);
 const adapter=apiSource('src/foundation/runtime-database.service.ts');const transaction=adapter.split('  private async retentionAttentionTransaction(')[1].split('  async readRetentionReviewAcknowledgementEvidence(')[0];
 assert.match(transaction,/withTenantReadOnlyTransaction/);assert.match(transaction,/withTenantTransaction/);assert.doesNotMatch(transaction,/SET TRANSACTION READ ONLY/);
 const guard=apiSource('src/retention-review/retention-review.dto.ts');assert(guard.includes(".replace(/\\/+$/, '')"));assert.doesNotMatch(guard,/endsWith\(/);assert.match(guard,/retention-attention-record/);assert.match(guard,/retention-attention-resolve/);
 const priorOrigin=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example.test';
 try {
  const request=(path,marker)=>({method:'POST',path,headers:{origin:'https://hon.example.test','sec-fetch-site':'same-origin','content-type':'application/json','x-hon-human-command':marker}});
  const activate=(path,marker)=>new RetentionReviewHumanUiGuard().canActivate({switchToHttp:()=>({getRequest:()=>request(path,marker)})});
  assert.equal(activate('/v1/staff/retention/review/attention-alerts/record/','retention-attention-record'),true);
  assert.equal(activate('/api/v1/staff/retention/review/attention-alerts/resolve','retention-attention-resolve'),true);
  for(const path of ['/x/v1/staff/retention/review/attention-alerts/record','/v1/staff/retention/review/attention-alerts/record/untrusted','/v1/staff/retention/review/attention-alerts/recording'])assert.throws(()=>activate(path,'retention-attention-record'));
 } finally { if(priorOrigin===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=priorOrigin; }
});
