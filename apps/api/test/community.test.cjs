const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, ForbiddenException } = require('@nestjs/common');
const { CommunityService } = require('../dist/community/community.service.js');
const { CommunityController } = require('../dist/community/community.controller.js');
const { CommunityHumanUiGuard } = require('../dist/community/community.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contract = require('@hon/contracts');
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = patch => ({ ...scope, externalSubject: 'verified-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch });
const input = patch => ({ expectedVersion: 0, kind: 'TOPIC', parentId: null, title: 'General operations practice', body: 'What general practice works for owners?', status: 'DRAFT', reason: 'Human author draft', ...patch });
const profile = { version: 1, displayName: 'Owner alias', enabled: true, organizationVersion: 1, organizationEnabled: true, canManageOrganization: true, humanOnly: true, executionAllowed: false };
const record = patch => ({ id: randomUUID(), version: 1, kind: 'TOPIC', parentId: null, title: input().title, body: input().body, status: 'DRAFT', displayName: 'Owner alias', canEdit: true, reason: input().reason, recordedAt: '2026-01-01T00:00:00.000Z', ...patch });
const denied = (work,status) => assert.rejects(async()=>work(),e => e.getStatus() === status);
test('community closed contracts reject contacts, URLs, attachments, operational fields and unsafe output', () => {
 contract.validateCommunityInput(input());
 for(const patch of [{attachments:[]},{url:'https://example.test'},{studentId:randomUUID()},{organizationId:randomUUID()},{status:'PUBLISHED'},{parentId:randomUUID()},{expectedVersion:-1},{body:'https://example.test'},{body:'example.com'},{body:'a@school.test'},{body:'+1 (800) 555-1234'},{body:'<script>bad</script>'},{body:'data:text/plain,secret'},{body:'invisible\u200btext'},{body:'x'.repeat(4001)}]) assert.throws(()=>contract.validateCommunityInput(input(patch)));
 for(const patch of [{email:'owner@example.test'},{avatarUrl:'https://example.test'},{displayName:'1234567890'},{displayName:'Name\nContact'},{displayName:'x'.repeat(61)}]) assert.throws(()=>contract.validateCommunityProfile({expectedVersion:0,displayName:'Owner alias',enabled:true,...patch}));
 for(const patch of [{email:'PRIVATE'},{principalId:randomUUID()},{schoolId:scope.schoolId},{student:{name:'PRIVATE'}},{provider:'PRIVATE'},{canEdit:false},{canEdit:false,status:'PUBLISHED',reason:'PRIVATE'},{body:'https://bad.test'}]) assert.throws(()=>contract.verifyCommunityRecord(record(patch)));
 contract.verifyCommunityRecord(record({canEdit:false,status:'PUBLISHED',reason:null}));
 assert.throws(()=>contract.verifyCommunityPage({items:[record()],nextAfter:randomUUID(),humanOnly:true,executionAllowed:false}));
 assert.throws(()=>contract.verifyCommunityHistory({id:randomUUID(),items:[{version:1,status:'DRAFT',recordedAt:'2026-01-01T00:00:00.000Z',body:'PRIVATE'}],nextBefore:null,humanOnly:true,executionAllowed:false}));
});
test('community service rejects non-human/delegated/source contexts before database and redacts unknown errors/output',async()=>{
 let calls=0; const db={withTenantTransaction:async(c,work)=>{calls++;return work({query:async(sql)=>sql.includes('read_community_profile')?{rows:[{data:profile}]}:{rows:[]}});}};
 const service=new CommunityService(db);
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{source:'PUBLIC_API'},{source:'AI_TOOL'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]) await denied(()=>service.profile(context(patch)),403);
 await denied(()=>service.mutate(context(), 'CONTENT',null,input({provider:'secret'})),400); assert.equal(calls,0);
 await denied(()=>service.mutate(context({idempotencyKey:''}),'CONTENT',null,input()),409);
 assert.deepEqual(await service.profile(context()),profile);
 db.withTenantTransaction=async()=>{throw Object.assign(new Error('PRIVATE contact secret DATABASE_URL'),{code:'XX000'});};
 await assert.rejects(()=>service.profile(context()),e=>e.getStatus()===503 && !JSON.stringify(e.getResponse()).includes('PRIVATE'));
 db.withTenantTransaction=async(c,work)=>work({query:async(sql)=>({rows:[{data:sql.includes('read_community_profile')?{...profile,email:'PRIVATE'}:null}]})});
 await denied(()=>service.profile(context()),503);
});
test('community routes require verified identity, known live school and same-origin HUMAN_UI; unknown fields never reach SQL',async()=>{
 const saved=record();let writes=0;let granted=true;
 const db={resolveCommunityScope:async(subject,school)=>granted && subject==='verified-human' && school===scope.schoolId?scope:undefined,withTenantTransaction:async(c,work)=>work({query:async(sql)=>{
  if(sql.includes('mutate_community')){writes++;return {rows:[{data:{result:saved,replayed:false}}]};}
  if(sql.includes('read_community_profile'))return {rows:[{data:profile}]};return {rows:[]};
 }})};
 const previous=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const mod=await Test.createTestingModule({controllers:[CommunityController],providers:[CommunityService,CommunityHumanUiGuard,{provide:RuntimeDatabaseService,useValue:db}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){const req=c.switchToHttp().getRequest();if(req.headers['x-test-human']!=='verified')throw new ForbiddenException({code:'IDENTITY_REQUIRED'});req.honIdentity={externalSubject:'verified-human'};return true;}}).compile();
 const app=mod.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/community`,path=`?schoolId=${scope.schoolId}`;
 const headers={'x-test-human':'verified',origin:'https://hon.example','content-type':'application/json','x-hon-human-command':'community','idempotency-key':randomUUID()};
 try {
  assert.equal((await fetch(base+'/profile'+path)).status,403);
  assert.equal((await fetch(base+'/profile'+path,{headers})).status,200);
  assert.equal((await fetch(base+'/profile?schoolId='+randomUUID(),{headers})).status,403);
  for(const patch of [{origin:'https://evil.example'},{'x-hon-human-command':'ai-tool'},{'sec-fetch-site':'same-site'},{'content-type':'text/plain'}]) assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,...patch},body:JSON.stringify(input())})).status,403);
  for(const patch of [{attachments:[]},{billingAccountId:randomUUID()},{principalId:scope.principalId},{body:'https://example.test'}]) assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input(patch))})).status,400);
  assert.equal(writes,0);
  const good=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input())});assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'private, no-store');assert.equal(writes,1);
  granted=false;assert.equal((await fetch(base+'/profile'+path,{headers})).status,403);assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input())})).status,403);assert.equal(writes,1);
  assert.equal((await fetch(base+path,{method:'DELETE',headers})).status,404);
 }finally{await app.close();if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous;}
});
