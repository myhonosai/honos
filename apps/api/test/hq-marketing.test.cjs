const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqMarketingController } = require('../dist/hq-marketing/hq-marketing.controller.js');
const { HqMarketingService } = require('../dist/hq-marketing/hq-marketing.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// M1 HQ marketing campaigns (0252): closed inputs and responses, and routes that forward only the verified subject, the path
// id, the declared query and the validated body. Planning only: nothing here reaches Google, Meta or any provider.
const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const person = (n = 'HQ Marketer') => ({ principalId: U(), displayName: n });
const viewer = (patch = {}) => ({ ...person(), canManage: true, ...patch });
const plan = (patch = {}) => ({ name: 'Spring founder push', goal: 'Book owner demos.', audience: 'NEW_SCHOOLS', offerLabel: 'Founder 50', channel: 'GOOGLE_ADS',
  startsOn: '2027-03-01', endsOn: '2027-03-31', plannedBudgetMinor: 250000, ...patch });
const camp = (patch = {}) => ({ campaignId: U(), code: 'SPRING-GOOGLE', ...plan(), status: 'DRAFT', currency: 'USD', createdBy: person(),
  createdAt: T, updatedAt: T, version: 1, ...patch });
const summary = (patch = {}) => ({ DRAFT: 1, ACTIVE: 0, PAUSED: 0, ARCHIVED: 0, plannedBudgetOpenMinor: 250000, ...patch });
const list = (patch = {}) => ({ campaigns: [camp()], limit: 50, nextCursor: null, summary: summary(), viewer: viewer(), asOf: T2, ...patch });
const snap = (c) => ({ name: c.name, goal: c.goal, audience: c.audience, offerLabel: c.offerLabel, channel: c.channel, status: c.status,
  startsOn: c.startsOn, endsOn: c.endsOn, plannedBudgetMinor: c.plannedBudgetMinor });

test('contracts: the HQ marketing command values match the SaaS command table; ad accounts are not connected', () => {
  assert.deepEqual(contracts.HQ_MARKETING_COMMANDS, { create: contracts.SAAS_COMMANDS.createMarketingCampaign,
    update: contracts.SAAS_COMMANDS.updateMarketingCampaign, status: contracts.SAAS_COMMANDS.setMarketingCampaignStatus });
  assert.deepEqual(contracts.HQ_MARKETING_AD_ACCOUNTS.map(a => [a.provider, a.connection, a.externalExecutionAvailable]),
    [['GOOGLE_ADS', 'NOT_CONNECTED', false], ['META_ADS', 'NOT_CONNECTED', false]]);
  assert(Object.isFrozen(contracts.HQ_MARKETING_AD_ACCOUNTS) && contracts.HQ_MARKETING_AD_ACCOUNTS.every(Object.isFrozen));
});

test('contracts: inputs are closed, trimmed and bounded', () => {
  const ok = { code: 'SPRING-GOOGLE', ...plan() };
  assert.deepEqual(contracts.validateHqMarketingCreateInput(ok), ok);
  for (const bad of [{ ...ok, code: 'spring' }, { ...ok, code: 'A' }, { ...ok, code: 'A'.repeat(41) }, { ...ok, name: 'ab' }, { ...ok, goal: ' Padded' },
    { ...ok, offerLabel: '' }, { ...ok, name: 'bad\u0007bell' }, { ...ok, channel: 'TIKTOK' }, { ...ok, audience: 'FAMILIES' }, { ...ok, startsOn: '2027-02-29' },
    { ...ok, startsOn: '2027-3-01' }, { ...ok, endsOn: '2027-02-28' }, { ...ok, endsOn: '2029-03-03' }, { ...ok, plannedBudgetMinor: -1 },
    { ...ok, plannedBudgetMinor: 1.5 }, { ...ok, plannedBudgetMinor: 10_000_000_001 }, { ...ok, plannedBudgetMinor: '1' }, { ...ok, status: 'ACTIVE' },
    (({ goal, ...r }) => r)(ok)])
    assert.throws(() => contracts.validateHqMarketingCreateInput(bad), JSON.stringify(bad).slice(0, 90));
  assert.equal(contracts.validateHqMarketingCreateInput({ ...ok, startsOn: '2028-02-29', endsOn: '2028-02-29' }).startsOn, '2028-02-29', 'leap day');
  assert.deepEqual(contracts.validateHqMarketingUpdateInput({ expectedVersion: 2, ...plan() }), { expectedVersion: 2, ...plan() });
  for (const bad of [{ expectedVersion: 0, ...plan() }, { expectedVersion: 2, code: 'X1', ...plan() }, plan()])
    assert.throws(() => contracts.validateHqMarketingUpdateInput(bad));
  assert.deepEqual(contracts.validateHqMarketingStatusInput({ expectedVersion: 1, status: 'ACTIVE' }), { expectedVersion: 1, status: 'ACTIVE' });
  for (const bad of [{ expectedVersion: 1, status: 'DRAFT' }, { expectedVersion: 1 }, { status: 'ACTIVE' }, { expectedVersion: 1, status: 'ACTIVE', note: 'x' }])
    assert.throws(() => contracts.validateHqMarketingStatusInput(bad), JSON.stringify(bad));
  assert.deepEqual(contracts.validateHqMarketingListQuery({}), { status: null, cursor: null, limit: 50 });
  for (const bad of [{ limit: '0' }, { limit: '101' }, { status: 'DONE' }, { cursor: 'x' }, { schoolId: U() }, { status: ['OPEN'] }])
    assert.throws(() => contracts.validateHqMarketingListQuery(bad), JSON.stringify(bad));
});

test('contracts: responses are closed and internally consistent', () => {
  assert.equal(contracts.validateHqMarketingCampaignList(list()).campaigns.length, 1);
  for (const bad of [list({ campaigns: [{ ...camp(), schoolId: U() }] }), list({ campaigns: [camp({ currency: 'EUR' })] }),
    list({ campaigns: [camp({ status: 'LIVE' })] }), list({ campaigns: [camp({ updatedAt: '2026-10-01T00:00:00.000Z' })] }),
    list({ viewer: person() }), list({ summary: summary({ DRAFT: 0, plannedBudgetOpenMinor: 5 }) }),
    list({ campaigns: [camp({ createdAt: T }), camp({ createdAt: T2 })], limit: 2 }), list({ nextCursor: { createdAt: T, campaignId: U() } })])
    assert.throws(() => contracts.validateHqMarketingCampaignList(bad));
  const c = camp({ version: 2, status: 'ACTIVE' });
  const versions = [{ version: 1, kind: 'CREATED', actor: person(), snapshot: { ...snap(c), status: 'DRAFT' }, recordedAt: T },
    { version: 2, kind: 'STATUS', actor: person(), snapshot: snap(c), recordedAt: T }];
  const detail = { campaign: c, versions, viewer: viewer({ canManage: false }), asOf: T2 };
  assert.equal(contracts.validateHqMarketingCampaignDetail(detail).versions.length, 2);
  for (const bad of [{ ...detail, versions: versions.slice(0, 1) }, { ...detail, versions: [versions[0], { ...versions[1], kind: 'CREATED' }] },
    { ...detail, versions: [versions[0], { ...versions[1], snapshot: { ...snap(c), plannedBudgetMinor: 1 } }] },
    { ...detail, versions: [versions[0], { ...versions[1], version: 3 }] }])
    assert.throws(() => contracts.validateHqMarketingCampaignDetail(bad));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqMarketingController],
    providers: [HqMarketingService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });

test('HTTP: reads and commands forward only the verified subject, the path id, the declared query and the validated body', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let reply = () => list({ limit: 10 });
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const ok = await send(`${base}/hq/marketing/campaigns?status=OPEN&limit=10`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readMarketingCampaigns', ['verified-human', 'OPEN', null, null, '10']]);
    reply = () => list({ limit: 10, campaigns: [camp({ status: 'ARCHIVED' })], summary: summary({ DRAFT: 0, ARCHIVED: 1, plannedBudgetOpenMinor: 0 }) });
    assert.equal((await send(`${base}/hq/marketing/campaigns?status=OPEN&limit=10`)).status, 503, 'a page that does not match the filter is never shown');
    const n = calls.length;
    for (const url of ['?schoolId=' + U(), '?status=DONE', '?limit=500', '?subject=other']) assert.equal((await send(`${base}/hq/marketing/campaigns${url}`)).status, 400, url);
    assert.equal(calls.length, n, 'refused requests never reach the database');
    const c = camp(); reply = () => ({ campaign: c, versions: [{ version: 1, kind: 'CREATED', actor: person(), snapshot: snap(c), recordedAt: T }], viewer: viewer(), asOf: T2 });
    assert.equal((await send(`${base}/hq/marketing/campaigns/${c.campaignId}`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readMarketingCampaign', ['verified-human', c.campaignId]]);
    const other = camp(); reply = () => ({ campaign: other, versions: [{ version: 1, kind: 'CREATED', actor: person(), snapshot: snap(other), recordedAt: T }], viewer: viewer(), asOf: T2 });
    assert.equal((await send(`${base}/hq/marketing/campaigns/${c.campaignId}`)).status, 503, 'an answer about another campaign is never shown');
    assert.equal((await send(`${base}/hq/marketing/campaigns/not-a-uuid`)).status, 400);
    const input = { code: 'SPRING-GOOGLE', ...plan() }, key = U();
    reply = () => ({ operation: 'CREATE', campaign: camp(), replayed: false });
    const created = await send(`${base}/hq/marketing/campaigns`, { method: 'POST', headers: command('hq-marketing-campaign-create', key), body: JSON.stringify(input) });
    assert.equal(created.status, 200, created.body);
    assert.deepEqual(calls.at(-1), ['createMarketingCampaign', ['verified-human', JSON.stringify(input), key]]);
    const m = calls.length;
    assert.equal((await send(`${base}/hq/marketing/campaigns`, { method: 'POST', headers: command('hq-marketing-campaign-update'), body: JSON.stringify(input) })).status, 403, 'wrong marker');
    assert.equal((await send(`${base}/hq/marketing/campaigns`, { method: 'POST', headers: { ...command('hq-marketing-campaign-create'), origin: 'https://evil.example' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await send(`${base}/hq/marketing/campaigns`, { method: 'POST', headers: command('hq-marketing-campaign-create'), body: JSON.stringify({ ...input, extra: 1 }) })).status, 400);
    assert.equal((await send(`${base}/hq/marketing/campaigns`, { method: 'POST', headers: { ...command('hq-marketing-campaign-create'), 'idempotency-key': 'nope' }, body: JSON.stringify(input) })).status, 400);
    assert.equal((await send(`${base}/hq/marketing/campaigns/${c.campaignId}/status`, { method: 'POST', headers: command('hq-marketing-campaign-status'), body: JSON.stringify({ expectedVersion: 1, status: 'DRAFT' }) })).status, 400);
    assert.equal(calls.length, m);
    reply = () => ({ operation: 'UPDATE', campaign: camp({ version: 2 }), replayed: false });
    const upd = { expectedVersion: 1, ...plan({ plannedBudgetMinor: 1 }) };
    assert.equal((await send(`${base}/hq/marketing/campaigns/${c.campaignId}/versions`, { method: 'POST', headers: command('hq-marketing-campaign-update', key), body: JSON.stringify(upd) })).status, 200);
    assert.deepEqual(calls.at(-1), ['updateMarketingCampaign', ['verified-human', c.campaignId, JSON.stringify(upd), key]]);
    for (const [code, message, status, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['40001', 'SAAS_VERSION_CONFLICT', 409, 'SAAS_VERSION_CONFLICT'],
      ['23514', 'HQ_CAMPAIGN_ARCHIVED', 422, 'HQ_CAMPAIGN_ARCHIVED'], ['23514', 'HQ_CAMPAIGN_STATUS_NOT_ALLOWED', 422, 'HQ_CAMPAIGN_STATUS_NOT_ALLOWED'],
      ['23514', 'HQ_CAMPAIGN_NO_CHANGE', 422, 'HQ_CAMPAIGN_NO_CHANGE'], ['23514', 'HQ_CAMPAIGN_CODE_TAKEN', 422, 'HQ_CAMPAIGN_CODE_TAKEN'],
      ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'], ['P0002', 'SAAS_UNAVAILABLE', 404, 'SAAS_UNAVAILABLE']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r = await send(`${base}/hq/marketing/campaigns/${c.campaignId}/status`, { method: 'POST', headers: command('hq-marketing-campaign-status'), body: JSON.stringify({ expectedVersion: 1, status: 'ACTIVE' }) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, answer], message);
    }
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});
