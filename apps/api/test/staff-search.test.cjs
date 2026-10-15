const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { ValidationPipe, UnauthorizedException } = require('@nestjs/common');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { Test } = require('@nestjs/testing');
const { StaffSearchController } = require('../dist/search/staff-search.controller.js');
const { StaffSearchService, normalizeStaffSearch } = require('../dist/search/staff-search.service.js');
const { StaffSearchQueryDto } = require('../dist/search/staff-search.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const org = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const school = '22222222-2222-4222-8222-222222222222';
const entity = '33333333-3333-4333-8333-333333333333';
const route = `/staff/search/${org}/${school}/STUDENT/${entity}`;
const card = () => ({ kind: 'STUDENT', entityId: entity, title: 'Ada Lee', subtitle: 'Student · ACTIVE', route });
const snapshot = () => ({ organizationId: org, schoolId: school, results: [card()] });
const status = expected => error => { assert.equal(error.getStatus(), expected); return true; };

test('single-school versioned controller is guarded and forwards only verified subject and route inputs', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, StaffSearchController), 'organizations/:organizationId/schools/:schoolId/search');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, StaffSearchController), [HonIdentityGuard]);
  const calls = [];
  const controller = new StaffSearchController({ search: async (...args) => { calls.push(args); return snapshot(); } });
  const query = { q: 'Ada', types: 'STUDENT' };
  const output = await controller.search(org, school, query, { honIdentity: { externalSubject: 'verified' }, principalId: 'evil', tier: 'COMPLETE' });
  assert.deepEqual(calls, [['verified', org, school, query]]);
  assert.deepEqual(Object.keys(output.data), ['search']); assert.equal(output.meta.requestId, output.meta.correlationId);
  await assert.rejects(() => controller.search(org, school, query, {}), status(403));
});

test('missing, empty, whitespace, control, overlong and malformed queries/kinds fail before database access', async () => {
  const service = new StaffSearchService({ readStaffSearch: async () => assert.fail('must not query') });
  for (const input of [undefined, {}, { q: '' }, { q: ' \u00a0\u3000 ' }, { q: 'x'.repeat(121) }, { q: ['Ada'] }, { q: 'Ada\n' }, { q: '\u202eevil' },
    { q: 'Ada', types: '' }, { q: 'Ada', types: [] }, { q: 'Ada', types: 'STUDENT,STUDENT' }, { q: 'Ada', types: 'student' },
    { q: 'Ada', types: 'STUDENT,LEAD,CLASS_SESSION,PROGRAM,CURRICULUM,HQ' }, { q: 'Ada', types: 'people;DROP TABLE hon.users' }, { q: 'Ada', types: 'https://evil.test' }]) {
    await assert.rejects(() => service.search('verified', org, school, input), status(400));
  }
  assert.deepEqual(normalizeStaffSearch({ q: '  Ada\u00a0 Lee  ', types: 'PROGRAM,STUDENT' }), { q: 'Ada Lee', types: ['STUDENT','PROGRAM'] });
  assert.equal(normalizeStaffSearch({ q: '🦁'.repeat(120) }).q.length, 240);
});

test('DTO forbids extra SQL, table, routing, tier, limit and principal parameters and repeated query inputs', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  for (const value of [{}, { q: '' }, { q: 'x'.repeat(121) }, { q: ['Ada','Lee'] }, { q: 'Ada', types: ['STUDENT'] },
    ...['sql','table','column','route','tier','limit','principalId','entityId','schoolId'].map(key => ({ q: 'Ada', [key]: 'evil' }))]) {
    await assert.rejects(() => pipe.transform(value, { type: 'query', metatype: StaffSearchQueryDto }), status(400));
  }
});

test('service emits only redacted fields and canonical current-scope routes; no client SQL or tier input is forwarded', async () => {
  const row = snapshot(); row.directory = 'RAW'; row.results[0].email = 'RAW'; row.results[0].note = 'RAW'; row.results[0].principalId = entity;
  const calls = []; const service = new StaffSearchService({ readStaffSearch: async (...args) => { calls.push(args); return row; } });
  const output = await service.search('verified', org.toUpperCase(), school, { q: "%_'; DROP TABLE hon.people--", types: 'STUDENT' });
  assert.deepEqual(calls, [['verified', org, school, "%_'; DROP TABLE hon.people--", ['STUDENT'], undefined]]);
  assert.deepEqual(Object.keys(output), ['organizationId','schoolId','results']);
  assert.deepEqual(Object.keys(output.results[0]), ['kind','entityId','title','subtitle','route']);
  assert.doesNotMatch(JSON.stringify(output), /RAW|email|note|principalId|directory/);
  assert.equal(output.results[0].route, route);
});

test('response boundary rejects cross-scope, unknown kinds, unsafe display/routes, duplicates and more than 20', async () => {
  const mutations = [row => row.organizationId=school, row => row.schoolId=org, row => row.results[0].kind='HQ',
    row => row.results[0].entityId='../../secret', row => row.results[0].route='https://evil.test', row => row.results[0].route=`/staff/search/${org}/${org}/STUDENT/${entity}`,
    row => row.results[0].title='\u202eevil', row => row.results[0].title='  Ada', row => row.results[0].subtitle='Student · SECRET',
    row => row.results[0].title='x'.repeat(161), row => row.results.push(card()), row => row.results=Array.from({length:21},card)];
  for (const mutate of mutations) { const row=snapshot(); mutate(row); const service=new StaffSearchService({readStaffSearch:async()=>row}); await assert.rejects(()=>service.search('verified',org,school,{q:'Ada',types:'STUDENT'}),/Invalid HON search/); }
});

test('current permission denials and SQL validation are sanitized; infrastructure failures remain failures', async () => {
  for (const [code,expected] of [['42501',403],['22023',400]]) {
    const service = new StaffSearchService({ readStaffSearch: async () => { throw Object.assign(new Error('RAW_SECRET'),{code}); } });
    await assert.rejects(()=>service.search('verified',org,school,{q:'Ada'}),error=>{status(expected)(error);assert.doesNotMatch(JSON.stringify(error.getResponse()),/RAW_SECRET/);return true;});
  }
  const failure = new Error('unavailable');
  await assert.rejects(()=>new StaffSearchService({readStaffSearch:async()=>{throw failure;}}).search('verified',org,school,{q:'Ada'}),error=>error===failure);
});

test('known-ID landing reuses exact live search permission, no expanded content, and closed type/ID lookup', async () => {
  const calls=[]; const service=new StaffSearchService({readStaffSearch:async(...args)=>{calls.push(args);return snapshot();}});
  assert.deepEqual(await service.readResult('verified',org,school,'STUDENT',entity),card());
  assert.deepEqual(calls,[['verified',org,school,'record',['STUDENT'],entity]]);
  await assert.rejects(()=>service.readResult('verified',org,school,'users',entity),status(400));
  await assert.rejects(()=>service.readResult('verified',org,school,'STUDENT','../evil'),status(400));
  await assert.rejects(()=>new StaffSearchService({readStaffSearch:async()=>({...snapshot(),results:[]})}).readResult('verified',org,school,'STUDENT',entity),status(404));
});

test('real HTTP routing enforces identity, UUIDs, DTOs, search bounds, no cache and GET-only operation', async () => {
  const calls=[];
  const module=await Test.createTestingModule({controllers:[StaffSearchController],providers:[StaffSearchService,HonIdentityGuard,
    {provide:HonIdentityService,useValue:{authenticate:req=>{if(req.headers.authorization!=='Bearer verified')throw new UnauthorizedException();return {externalSubject:'verified'};}}},
    {provide:RuntimeDatabaseService,useValue:{readStaffSearch:async(...args)=>{calls.push(args);return snapshot();}}}]}).compile();
  const app=module.createNestApplication({cors:false}); app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));
  await app.listen(0,'127.0.0.1');
  try {
    const base=await app.getUrl();const path=`${base}/v1/organizations/${org}/schools/${school}/search`;const headers={Authorization:'Bearer verified'};
    assert.equal((await fetch(`${path}?q=Ada`)).status,401);
    for(const suffix of ['', '?q=', '?q=%20%20',`?q=${'x'.repeat(121)}`,'?q=Ada&sql=SELECT','?q=Ada&types=HQ','?q=Ada&types=STUDENT&types=LEAD','?q=Ada&q=Lee'])assert.equal((await fetch(path+suffix,{headers})).status,400,suffix);
    assert.equal(calls.length,0);
    const response=await fetch(`${path}?q=Ada&types=STUDENT`,{headers}); assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    assert.deepEqual((await response.json()).data.search,snapshot());assert.equal(calls.length,1);
    assert.equal((await fetch(`${path}?q=Ada`,{method:'POST',headers})).status,404);
    assert.equal((await fetch(path.replace(school,'invalid')+'?q=Ada',{headers})).status,400);
    assert.equal((await fetch(`${path}/results/HQ/${entity}`,{headers})).status,400);
  } finally { await app.close(); }
});
