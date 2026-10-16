const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { HqAiProviderService } = require('../dist/hq/hq-ai-provider.service.js');
const { HqAiProviderController } = require('../dist/hq/hq-ai-provider.controller.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const status = n => e => e.getStatus?.() === n;
const profileId = randomUUID(), policyId = randomUUID(), catalogId = randomUUID();
const profile = { profileId, routingPolicyId: policyId, agentKey: 'marcus', taskCategory: 'MARCUS_MARKETING', costUnit: 'TOKEN', active: true, maxCostMicros: 100,
  defaultCatalogId: catalogId, fallbackCatalogIds: [], advancedCatalogId: null, requiredCapabilities: ['TEXT'], requiredModalities: ['TEXT'], allowedProviderIds: ['OPENROUTER'], privacyControls: [],
  timeoutCategory: 'STANDARD', retryCategory: 'NONE', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: null, expectedVersion: 0 };
const input = { profileId, selection: 'DEFAULT', estimatedUnits: 1 };
function registry() {
  const organizationId = randomUUID(), schoolId = randomUUID();
  const { expectedVersion, ...config } = profile;
  return { tenant: { organizationId, schoolId, tier: 'CORE', entitlementActive: true }, asOf: '2026-10-01T00:00:00.000Z',
    providers: [{ providerId: 'OPENROUTER', displayName: 'Local Metadata', state: 'HEALTHY', credentialConfigured: true, version: 1 }],
    catalog: [{ catalogId, providerId: 'OPENROUTER', modelId: 'local/approved-v1', displayName: 'Local Model', capabilities: ['TEXT'], modalities: ['TEXT'], privacyControls: [], active: true, minimumTier: 'CORE', unitCostMicros: 1, costUnit: 'TOKEN', effectiveFrom: profile.effectiveFrom, effectiveUntil: null, version: 1 }],
    policies: [{ policyId, organizationId, schoolId, capability: 'TEXT', active: true, minimumTier: 'CORE', maxCostMicros: 100, allowDegraded: false, catalogIds: [catalogId], effectiveFrom: profile.effectiveFrom, effectiveUntil: null, version: 1 }], profile: { ...config, version: 1 } };
}
test('task-profile service rejects extra input before SQL, selects only the registered profile, and redacts errors', async () => {
  const calls = [], database = { resolveAiTaskProfileRegistryFromHq: async (...args) => { calls.push(args); return registry(); } };
  const service = new HqAiProviderService(database);
  const result = await service.previewTaskProfile('live-hq', input);
  assert.equal(result.status, 'SELECTED'); assert.equal(result.authority, 'UNCHANGED'); assert.equal(result.execution, 'NOT_PERFORMED');
  assert.deepEqual(calls, [['live-hq', profileId]]);
  for (const key of ['budgetMicros', 'routingPolicyId', 'organizationId', 'providerId', 'modelId', 'tools', 'authority', 'prompt', 'output']) {
    await assert.rejects(() => service.previewTaskProfile('live-hq', { ...input, [key]: 'rejected' }), status(400));
  }
  assert.equal(calls.length, 1);
  for (const [code, http] of [['42501',403],['P0002',404],['22023',400],['23503',400],['23505',409],['40001',409]]) {
    const failing = new HqAiProviderService({ resolveAiTaskProfileRegistryFromHq: async () => { throw Object.assign(new Error('raw rejected metadata'), { code }); } });
    await assert.rejects(() => failing.previewTaskProfile('live-hq', input), e => status(http)(e) && !JSON.stringify(e.getResponse()).includes('raw rejected metadata'));
  }
});
test('runtime profile resolver and shared write use only fixed parameterized functions', async () => {
  const database = new RuntimeDatabaseService(), seen = [];
  database.assertRuntimePosture = async () => {};
  database.getPool = () => ({ query: async (sql,args) => { seen.push([sql,args]); return { rows: [{ data: {} }] }; } });
  await database.resolveAiTaskProfileRegistryFromHq('verified-hq',profileId);
  await database.writeAiControlPlaneFromHq('verified-hq','TASK_PROFILE',profile,randomUUID(),randomUUID());
  assert.equal(seen[0][0], 'SELECT hon.hq_ai_task_profile_registry($1, $2::uuid) AS data');
  assert.deepEqual(seen[0][1], ['verified-hq',profileId]);
  assert.match(seen[1][0], /^SELECT hon\.hq_ai_control_plane_write/); assert.equal(seen[1][1][1], 'TASK_PROFILE');
  assert(seen.every(([sql]) => !/FROM hon\.hq_ai_task_profiles|INSERT|UPDATE|DELETE/.test(sql)));
});
test('local HTTP HQ profile endpoints enforce read/manage scopes, exact bodies and idempotency; never expose execution', async () => {
  let mode = 'owner'; const calls = [];
  const database = {
    resolveHqOperatorScope: async (subject, permission) => { calls.push(['scope',subject,permission]); return mode === 'denied' || (mode === 'reader' && permission.endsWith('manage')) ? null : { principalId: randomUUID() }; },
    writeAiControlPlaneFromHq: async (...args) => { calls.push(['write',...args]); return { recordId: profileId, version: 1, replayed: false }; },
    resolveAiTaskProfileRegistryFromHq: async (...args) => { calls.push(['read',...args]); return registry(); },
  };
  const module = await Test.createTestingModule({ controllers: [HqAiProviderController], providers: [HqAiProviderService, { provide: RuntimeDatabaseService, useValue: database }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-hq' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0,'127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/ai-providers`;
  const post = (path,body,key=randomUUID()) => fetch(`${base}/${path}`,{ method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body) });
  try {
    let response = await post('task-profiles',profile); assert.equal(response.status,200); assert.equal((await response.json()).meta.replayed,false);
    assert.equal(calls.find(c=>c[0]==='write')[2],'TASK_PROFILE');
    response = await post('task-profile-preview',input); assert.equal(response.status,200);
    const result = (await response.json()).data; assert.equal(result.execution,'NOT_PERFORMED'); assert.equal(result.authority,'UNCHANGED');
    assert.equal((await post('task-profile-preview',{...input,selection:'ADVANCED'})).status,200);
    for (const body of [{...input,budgetMicros:999},{...input,prompt:'rejected'},{...input,estimatedUnits:0},{...input,selection:'AUTO'}]) assert.equal((await post('task-profile-preview',body)).status,400);
    for (const body of [{...profile,tools:['rejected']},{...profile,credentialSecretRef:'rejected'},{...profile,privacyControls:null}]) assert.equal((await post('task-profiles',body)).status,400);
    assert.equal((await post('task-profiles',profile,'not-a-uuid')).status,400);
    mode='reader'; assert.equal((await post('task-profile-preview',input)).status,200); assert.equal((await post('task-profiles',profile)).status,403);
    mode='denied'; assert.equal((await post('task-profile-preview',input)).status,403); assert.equal((await post('task-profiles',profile)).status,403);
    assert.equal((await fetch(`${base}/task-profiles`,{method:'DELETE'})).status,404);
    assert.equal((await post('task-profile-execute',input)).status,404);
    assert.equal(calls.filter(c=>c[0]==='write').length,1);
    assert(calls.filter(c=>c[0]==='scope').every(c=>c[1]==='verified-hq'));
  } finally { await app.close(); }
});
