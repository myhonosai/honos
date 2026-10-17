const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { HqEntitlementController } = require('../dist/hq/hq-entitlement.controller.js');
const { HqEntitlementService } = require('../dist/hq/hq-entitlement.service.js');
const { HqEntitlementHumanUiGuard, assertHqEntitlementHumanRequest } = require('../dist/hq/hq-entitlement.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { validateHqEntitlementTransitionInput, validateHqEntitlementTransitionReceipt } = require('@hon/contracts');
const org = randomUUID();
const receipt = () => ({ organizationId:org, priorTier:'CORE', targetTier:'COMPLETE', version:2, effectiveFrom:'2026-10-17T05:00:00.000001Z', replayed:false });
const status = expected => error => error.getStatus?.() === expected;

test('HQ entitlement closed contracts preserve Essential and forbid commercial/effect/authority fields', () => {
  for (const targetTier of ['CORE','COMPLETE']) assert.deepEqual(validateHqEntitlementTransitionInput({targetTier,expectedVersion:1}),{targetTier,expectedVersion:1});
  for (const targetTier of ['ESSENTIAL','core',' COMPLETE',null,{},['CORE']]) assert.throws(() => validateHqEntitlementTransitionInput({targetTier,expectedVersion:1}));
  for (const expectedVersion of [0,-1,1.1,'1',NaN,Infinity,2147483647,Number.MAX_SAFE_INTEGER]) assert.throws(() => validateHqEntitlementTransitionInput({targetTier:'CORE',expectedVersion}));
  for (const field of ['organizationId','schoolId','principalId','source','price','credits','provider','subscriptionId','payment','effectiveFrom','actionRequestId','delegatedByPrincipalId','fingerprint','requestId','correlationId']) {
    assert.throws(() => validateHqEntitlementTransitionInput({targetTier:'CORE',expectedVersion:1,[field]:'untrusted'}));
    assert.throws(() => validateHqEntitlementTransitionReceipt({...receipt(),[field]:'private'}));
  }
  assert.deepEqual(validateHqEntitlementTransitionReceipt(receipt()),receipt());
  assert.throws(() => validateHqEntitlementTransitionReceipt({...receipt(),priorTier:'ESSENTIAL'}));
  assert.throws(() => validateHqEntitlementTransitionReceipt({...receipt(),targetTier:'CORE'}));
});

test('service derives stable fingerprint/opaque server request IDs and redacts database failures', async () => {
  const calls=[]; const key=randomUUID();
  const service=new HqEntitlementService({transitionOrganizationEntitlementFromHq:async (...args)=>{calls.push(args);return receipt();}});
  assert.deepEqual(await service.transition('verified-human',org.toUpperCase(),{targetTier:'COMPLETE',expectedVersion:1},key),receipt());
  await service.transition('verified-human',org,{targetTier:'COMPLETE',expectedVersion:1},key);
  assert.deepEqual(calls[0].slice(0,6),['verified-human',org,{targetTier:'COMPLETE',expectedVersion:1},key,createHash('sha256').update(`hq.entitlement.transition:${org}:COMPLETE:1`).digest('hex'),calls[0][5]]);
  assert.notEqual(calls[0][5],calls[1][5]); assert.notEqual(calls[0][6],calls[1][6]);
  for (const [code,http] of [['42501',403],['P0002',404],['40001',409],['23505',409],['55P03',409],['57014',409],['22023',400],['22P02',400],['23514',400],['XX000',503]]) {
    const failure=new HqEntitlementService({transitionOrganizationEntitlementFromHq:async()=>{throw Object.assign(new Error('private-school-provider-price-SQL'),{code});}});
    await assert.rejects(()=>failure.transition('verified-human',org,{targetTier:'COMPLETE',expectedVersion:1},key),error=>status(http)(error)&&!JSON.stringify(error.getResponse()).includes('private-school'));
  }
  const drift=new HqEntitlementService({transitionOrganizationEntitlementFromHq:async()=>({...receipt(),email:'private'})});
  await assert.rejects(()=>drift.transition('verified-human',org,{targetTier:'COMPLETE',expectedVersion:1},key),status(503));
});

test('mixed tenant/family/nonhuman/delegated/action request context is rejected independently', () => {
  for (const field of ['honContext','honCommandContext','commandContext','actionContext','principalType','source','actionRequestId','delegatedByPrincipalId','organizationId','schoolId','familyId']) assert.throws(()=>assertHqEntitlementHumanRequest({headers:{},[field]:null}),status(403));
  for (const field of ['principalId','principalType','source','organizationId','schoolId','delegatedByPrincipalId']) assert.throws(()=>assertHqEntitlementHumanRequest({headers:{},honIdentity:{externalSubject:'verified', [field]:'untrusted'}}),status(403));
});

test('PATCH HQ route requires identity + trusted same-origin human JSON, exact body, key, and selector', async () => {
  const previous=process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN='https://hon.example';
  let denied=false; const calls=[];
  const module=await Test.createTestingModule({controllers:[HqEntitlementController],providers:[HqEntitlementService,HqEntitlementHumanUiGuard,{provide:RuntimeDatabaseService,useValue:{transitionOrganizationEntitlementFromHq:async(...args)=>{calls.push(args);if(denied)throw Object.assign(new Error('denied'),{code:'42501'});return receipt();}}}]})
    .overrideGuard(HonIdentityGuard).useValue({canActivate(context){context.switchToHttp().getRequest().honIdentity={externalSubject:'verified-human'};return true;}}).compile();
  const app=module.createNestApplication();app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');
  const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/organizations/${org}/entitlement`;
  const headers={'content-type':'application/json',origin:'https://hon.example','x-hon-human-command':'hq-entitlement-transition','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','idempotency-key':randomUUID()};
  const command=(extra={},body={targetTier:'COMPLETE',expectedVersion:1},url=base)=>new Promise((resolve,reject)=>{
    const req=httpRequest(url,{method:'PATCH',headers:{...headers,...extra}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on('error',reject);req.end(JSON.stringify(body));
  });
  try {
    const response=await command();assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);assert.deepEqual(await response.json(),{data:receipt()});
    for (const extra of [{origin:'https://attacker.example'},{'sec-fetch-site':'cross-site'},{'sec-fetch-mode':'cors'},{'sec-fetch-dest':'document'},{'sec-fetch-user':'?1'},{'x-hon-human-command':'school'},{'x-hon-principal-type':'HUMAN_USER'},{'content-type':'text/plain'}]) assert.equal((await command(extra)).status,403);
    assert.equal((await command({'idempotency-key':'not-a-uuid'})).status,400);
    for(const body of [{targetTier:'ESSENTIAL',expectedVersion:1},{targetTier:'CORE',expectedVersion:0},{targetTier:'COMPLETE',expectedVersion:1,schoolId:org},{targetTier:'CORE',expectedVersion:1,price:149}]) assert.equal((await command({},body)).status,400);
    assert.equal((await command({},undefined,base+'?source=HUMAN_UI')).status,400);
    assert.equal((await command({},undefined,base.replace(org,'not-a-uuid'))).status,400);
    assert.equal(calls.length,1);
    denied=true;assert.equal((await command()).status,403);
    assert.equal((await fetch(base)).status,404);
    assert.equal((await fetch(base,{method:'POST',headers,body:'{}'})).status,404);
  } finally { await app.close();if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous; }
});

test('HQ database path calls exactly one fixed function, no tenant context/table mutation, and rolls back failure', async () => {
  const database=new RuntimeDatabaseService();database.assertRuntimePosture=async()=>{};
  let fail=false;const seen=[];
  database.getPool=()=>({connect:async()=>({query:async(sql,args)=>{seen.push([sql,args]);if(sql.startsWith('SELECT hon.transition')) {if(fail)throw Object.assign(new Error('fail'),{code:'40001'});return{rows:[{data:receipt()}]};}return{rows:[]};},release(){seen.push(['release']);}})});
  await database.transitionOrganizationEntitlementFromHq('verified-human',org,{targetTier:'COMPLETE',expectedVersion:1},randomUUID(),'fp',randomUUID(),randomUUID());
  assert.equal(seen[0][0],'BEGIN');assert.match(seen[1][0],/lock_timeout/);assert.match(seen[2][0],/^SELECT hon.transition_organization_entitlement_from_hq/);assert.equal(seen[3][0],'COMMIT');
  assert(seen.every(([sql])=>!/(withTenant|set_config|UPDATE |FROM hon\.(users|schools|organization_entitlements)|INSERT )/.test(sql)));
  seen.length=0;fail=true;
  await assert.rejects(()=>database.transitionOrganizationEntitlementFromHq('verified-human',org,{targetTier:'COMPLETE',expectedVersion:1},randomUUID(),'fp',randomUUID(),randomUUID()),error=>error.code==='40001');
  assert.deepEqual(seen.slice(-2).map(([sql])=>sql),['ROLLBACK','release']);
});
