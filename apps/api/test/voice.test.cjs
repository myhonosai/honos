const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe,ForbiddenException } = require('@nestjs/common');
const { VoiceService } = require('../dist/voice/voice.service.js');
const { VoiceController } = require('../dist/voice/voice.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { validateVoiceInput,safeVoiceDraft } = require('@hon/contracts');
const scope={organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID()};
const ctx=(patch={})=>({...scope,externalSubject:'verified-human',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch});
const denied=(work,status)=>assert.rejects(work,error=>error.getStatus?.()===status);

test('voice commands reject nonhuman/delegated/control-plane/raw data before database use',async()=>{
 let transactions=0;const service=new VoiceService({withTenantTransaction:async()=>{transactions++;throw new Error('must not transact');}});
 for(const patch of [{source:'AI'},{source:'AUTOMATION'},{principalType:'AI_EMPLOYEE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{externalSubject:''}])await denied(()=>service.mutate(ctx(patch),'create',null,{agentCatalogId:'alex'}),403);
 for(const input of [{agentCatalogId:'eian'},{agentCatalogId:'alex',providerId:randomUUID()},{agentCatalogId:'alex',voiceProfile:'CLEAR'},{agentCatalogId:'alex',rawPayload:{}},{agentCatalogId:'alex',draftText:'Private'},{}])await denied(()=>service.mutate(ctx(),'create',null,input),400);
 for(const text of ['', ' A', 'A ', 'A'.repeat(501),'phone number','secret token','private@example.test','https://example.test','Call 5551234','<b>Text</b>','Raw transcript','Élan','Line\nBreak'])assert.equal(safeVoiceDraft(text),false,text);
 assert(safeVoiceDraft('General school operations.'));assert(safeVoiceDraft('A'.repeat(500)));
 for(const input of [{expectedVersion:1,state:'CONNECTED',reasonCode:'NOT_CONFIGURED'},{expectedVersion:0,state:'VOICE_CONNECTING',reasonCode:'NOT_CONFIGURED'},{expectedVersion:1,state:'VOICE_CONNECTING',reasonCode:'RAW_PROVIDER_ERROR'},{expectedVersion:1,state:'VOICE_UNAVAILABLE',reasonCode:'NOT_CONFIGURED',microphonePermission:true}])assert.throws(()=>validateVoiceInput('status',input));
 assert.equal(transactions,0);
});
test('voice service maps only safe database failures and refuses poisoned exact read results',async()=>{
 for(const [code,status]of [['42501',403],['22023',400],['40001',409],['55P03',409]]) {
  const service=new VoiceService({withTenantTransaction:async(_c,work)=>work({query:async sql=>{if(sql.includes('hon.mutate_voice_session'))throw Object.assign(new Error('PRIVATE_DATABASE_DETAIL'),{code});return {rows:[]};}})});
  await denied(()=>service.mutate(ctx(),'create',null,{agentCatalogId:'alex'}),status);
 }
 const bad=new VoiceService({withTenantTransaction:async(_c,work)=>work({query:async()=>({rows:[{result:{rawTranscript:'private'}}]})})});
 await assert.rejects(()=>bad.read(ctx(),randomUUID()),/VALIDATION_FAILED|UNVERIFIED/);
});
test('voice controller has only same-origin verified-human create/exact read/status/fallback/end routes',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';let calls=0;let received;
 const module=await Test.createTestingModule({controllers:[VoiceController],providers:[{provide:RuntimeDatabaseService,useValue:{resolveAuthorizedScope:async(subject,school,permission)=>{assert.equal(subject,'verified-human');assert.equal(school,scope.schoolId);assert.equal(permission,'ai.voice.interact');return scope;}}},{provide:VoiceService,useValue:{read:async(c,id)=>{calls++;assert.equal(c.externalSubject,'verified-human');return {id};},mutate:async(c,operation,id,input)=>{calls++;received={c,operation,id,input};validateVoiceInput(operation,input);return {sessionId:id};}}}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(context){const req=context.switchToHttp().getRequest();if(req.headers['x-test-human']!=='verified')throw new ForbiddenException();req.honIdentity={externalSubject:'verified-human'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/voice/${scope.schoolId}`,id=randomUUID();
 const headers={'x-test-human':'verified',origin:'https://hon.test','content-type':'application/json','x-hon-human-command':'voice-session','idempotency-key':randomUUID(),'sec-fetch-site':'same-origin'};
 try {
  let response=await fetch(base,{method:'POST',headers,body:JSON.stringify({agentCatalogId:'alex'})});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(received.input,{agentCatalogId:'alex'});assert.equal(received.operation,'create');assert.equal(received.id,null);
  assert.equal((await fetch(`${base}/${id}`,{headers})).status,200);
  for(const [path,input]of [['status',{expectedVersion:1,state:'VOICE_UNAVAILABLE',reasonCode:'NOT_CONFIGURED'}],['mark-fallback',{expectedVersion:2,reasonCode:'CLIENT_ERROR',draftText:'General operations.'}],['end',{expectedVersion:3}]])assert.equal((await fetch(`${base}/${id}/${path}`,{method:'POST',headers,body:JSON.stringify(input)})).status,200);
  const before=calls;
  for(const patch of [{origin:'https://evil.test'},{'x-hon-human-command':'action-approvals'},{'content-type':'text/plain'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':''},{'x-test-human':''}])assert.equal((await fetch(base,{method:'POST',headers:{...headers,...patch},body:JSON.stringify({agentCatalogId:'alex'})})).status,403);
  assert.equal((await fetch(`${base}/${id}`,{headers:{...headers,'sec-fetch-site':'cross-site'}})).status,403);
  for(const body of ['null','false','"not-an-object"','[]'])assert.equal((await fetch(base,{method:'POST',headers,body})).status,400);
  for(const extra of [{providerId:randomUUID()},{voiceConfig:'raw'},{principalId:scope.principalId},{organizationId:scope.organizationId},{transcript:'raw'},{payload:{}}])assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify({agentCatalogId:'alex',...extra})})).status,400);
  assert.equal((await fetch(`${base}?tier=COMPLETE`,{method:'POST',headers,body:JSON.stringify({agentCatalogId:'alex'})})).status,400);
  assert.equal((await fetch(`${base}/${id}?includePayload=true`,{headers})).status,400);
  assert.equal((await fetch(base,{method:'POST',headers:{...headers,'idempotency-key':'raw-key'},body:JSON.stringify({agentCatalogId:'alex'})})).status,400);
  for(const path of ['execute','connect','invoke','transcribe','send','provider-config'])assert.equal((await fetch(`${base}/${id}/${path}`,{method:'POST',headers,body:'{}'})).status,404);
  assert.equal(calls,before,'Rejected transports/shapes/unknown routes never reach service');
 } finally {await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
