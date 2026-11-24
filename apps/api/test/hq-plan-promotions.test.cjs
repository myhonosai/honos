const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqPlanPromotionsController, SchoolPlanPromotionsController } = require('../dist/hq-plan-promotions/hq-plan-promotions.controller.js');
const { HqPlanPromotionsService } = require('../dist/hq-plan-promotions/hq-plan-promotions.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// HQ plan promotions (0308): closed inputs and responses, routes that forward only the verified subject, the path ids, the
// declared query and the validated body. In-app only: nothing here sends a message or changes a price, offer or plan.
const U = () => randomUUID(), T = '2026-11-12T00:00:00.000Z', T2 = '2026-11-13T00:00:00.000Z', END = '2026-11-20T00:00:00.000Z';
const person = (n = 'HQ Owner') => ({ principalId: U(), displayName: n });
const viewer = (patch = {}) => ({ ...person(), canManage: true, ...patch });
const OFFER = U();
const offer = (patch = {}) => ({ offerId: OFFER, offerCode: 'REGULAR_ANNUAL', offerKind: 'REGULAR_ANNUAL', billingInterval: 'ANNUAL', displayName: 'HON OS annual',
  priceMinor: 209700, currency: 'USD', offerSetVersion: 1, onSale: true, ...patch });
const content = (patch = {}) => ({ headline: 'Save with annual billing', body: 'Pay for ten months, get twelve.', buttonLabel: 'See annual plan', offerId: OFFER,
  audience: 'ALL_SCHOOLS', schoolIds: [], startsAt: T, endsAt: END, marketingCampaignId: null, ...patch });
const promo = (patch = {}) => { const { offerId, ...rest } = content(); return { promotionId: U(), code: 'ANNUAL-SWITCH', ...rest, offer: offer(), status: 'DRAFT',
  live: false, approvedDigest: null, firstStartedAt: null, createdBy: person(), createdAt: T, updatedAt: T, version: 1, ...patch }; };
const reach = (patch = {}) => ({ seenSchools: 0, openedSchools: 0, dismissedSchools: 0, purchaseStartedSchools: 0, countsAre: 'RECORDED_EVENTS_NOT_ESTIMATES', ...patch });
const list = (patch = {}) => ({ promotions: [{ ...promo(), reach: reach() }], limit: 50, nextCursor: null, offers: [offer()], viewer: viewer(), messaging: 'IN_APP_ONLY', asOf: T2, ...patch });
const snap = (p) => ({ ...content(), offerId: p.offer.offerId, headline: p.headline, endsAt: p.endsAt, status: p.status });
const detail = (p = promo()) => ({ promotion: p, preview: { digest: 'a'.repeat(64), offerOnSale: true, audienceSchools: 3, eligibleSchools: 2, asOf: T2 },
  reach: reach(), versions: [{ version: 1, kind: 'CREATED', actor: person(), snapshot: snap(p), recordedAt: T }], viewer: viewer(), asOf: T2 });
const schoolView = (schoolId, patch = {}) => ({ schoolId, promotions: [{ promotionId: U(), headline: 'Save with annual billing', body: 'Pay for ten months, get twelve.',
  buttonLabel: 'See annual plan', offer: (({ onSale, offerSetVersion, ...o }) => o)(offer()), endsAt: END, dismissed: false }], asOf: T2, ...patch });

test('contracts: command values match the SaaS command table; transitions; in-app only', () => {
  assert.deepEqual(contracts.HQ_PLAN_PROMOTION_COMMANDS, { create: contracts.SAAS_COMMANDS.createPlanPromotion, update: contracts.SAAS_COMMANDS.updatePlanPromotion,
    status: contracts.SAAS_COMMANDS.setPlanPromotionStatus, schoolEvent: contracts.SAAS_COMMANDS.recordSchoolPlanPromotionEvent });
  assert.deepEqual(contracts.HQ_PLAN_PROMOTION_TRANSITIONS.ENDED, []);
  assert.equal(contracts.HQ_PLAN_PROMOTION_MESSAGING, 'IN_APP_ONLY');
});

test('contracts: inputs are closed, trimmed and bounded', () => {
  const ok = { code: 'ANNUAL-SWITCH', ...content() };
  assert.deepEqual(contracts.validateHqPlanPromotionCreateInput(ok), ok);
  const S = U();
  assert.deepEqual(contracts.validateHqPlanPromotionCreateInput({ ...ok, audience: 'SELECTED_SCHOOLS', schoolIds: [S.toUpperCase()] }).schoolIds, [S]);
  for (const bad of [{ ...ok, extra: 1 }, { ...ok, code: 'lower' }, { ...ok, headline: ' x ' }, { ...ok, body: 'x'.repeat(401) }, { ...ok, buttonLabel: 'x' },
    { ...ok, audience: 'EVERYONE' }, { ...ok, audience: 'SELECTED_SCHOOLS' }, { ...ok, schoolIds: [U()] }, { ...ok, audience: 'SELECTED_SCHOOLS', schoolIds: [S, S] },
    { ...ok, endsAt: T }, { ...ok, endsAt: '2027-03-01T00:00:00.000Z' }, { ...ok, offerId: 'x' }, { ...ok, marketingCampaignId: 'x' }])
    assert.throws(() => contracts.validateHqPlanPromotionCreateInput(bad), JSON.stringify(bad).slice(0, 60));
  assert.deepEqual(contracts.validateHqPlanPromotionStatusInput({ expectedVersion: 1, status: 'ACTIVE', previewDigest: 'b'.repeat(64) }).status, 'ACTIVE');
  for (const bad of [{ expectedVersion: 1, status: 'DRAFT', previewDigest: null }, { expectedVersion: 1, status: 'PAUSED', previewDigest: 'b'.repeat(64) },
    { expectedVersion: 0, status: 'ENDED', previewDigest: null }, { expectedVersion: 1, status: 'ACTIVE' }])
    assert.throws(() => contracts.validateHqPlanPromotionStatusInput(bad));
  assert.deepEqual(contracts.validateSchoolPlanPromotionEventInput({ kind: 'OPENED' }), { kind: 'OPENED' });
  for (const bad of [{ kind: 'CLICKED' }, { kind: 'SEEN', at: T }, {}]) assert.throws(() => contracts.validateSchoolPlanPromotionEventInput(bad));
});

test('contracts: responses are closed and consistent', () => {
  assert.equal(contracts.validateHqPlanPromotionList(list()).promotions.length, 1);
  for (const bad of [list({ messaging: 'EMAIL' }), list({ promotions: [{ ...promo({ live: true }), reach: reach() }] }),
    list({ promotions: [{ ...promo({ approvedDigest: 'a'.repeat(64) }), reach: reach() }] }), list({ promotions: [{ ...promo(), reach: reach({ purchaseStartedSchools: 1 }) }] }),
    list({ promotions: [{ ...promo(), reach: reach({ countsAre: 'ESTIMATE' }) }] }), list({ promotions: [promo()] })])
    assert.throws(() => contracts.validateHqPlanPromotionList(bad));
  assert.equal(contracts.validateHqPlanPromotionDetail(detail()).preview.eligibleSchools, 2);
  const d = detail();
  for (const bad of [{ ...d, preview: { ...d.preview, eligibleSchools: 4 } }, { ...d, versions: [] }, { ...d, versions: [{ ...d.versions[0], snapshot: { ...d.versions[0].snapshot, status: 'ACTIVE' } }] }])
    assert.throws(() => contracts.validateHqPlanPromotionDetail(bad));
  const S = U();
  assert.equal(contracts.validateSchoolPlanPromotions(schoolView(S)).promotions.length, 1);
  const leak = schoolView(S); leak.promotions[0].offer.onSale = true;
  assert.throws(() => contracts.validateSchoolPlanPromotions(leak), 'HQ-only offer facts never reach a school');
  const leak2 = schoolView(S); leak2.promotions[0].audience = 'ALL_SCHOOLS';
  assert.throws(() => contracts.validateSchoolPlanPromotions(leak2), 'audience targeting never reaches a school');
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqPlanPromotionsController, SchoolPlanPromotionsController],
    providers: [HqPlanPromotionsService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });

test('HTTP: HQ and school routes forward only the verified subject, path ids, declared query and validated body', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let reply = () => list({ limit: 10 });
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const ok = await send(`${base}/hq/plan-promotions?status=OPEN&limit=10`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readPlanPromotions', ['verified-human', 'OPEN', null, null, '10']]);
    reply = () => list({ limit: 10, promotions: [{ ...promo({ status: 'ENDED' }), reach: reach() }] });
    assert.equal((await send(`${base}/hq/plan-promotions?status=OPEN&limit=10`)).status, 503, 'a page that does not match the filter is never shown');
    const n = calls.length;
    for (const q of ['?schoolId=' + U(), '?status=LIVE', '?limit=500']) assert.equal((await send(`${base}/hq/plan-promotions${q}`)).status, 400, q);
    assert.equal(calls.length, n);
    const p = promo(); reply = () => detail(p);
    assert.equal((await send(`${base}/hq/plan-promotions/${p.promotionId}`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readPlanPromotion', ['verified-human', p.promotionId]]);
    reply = () => detail(promo());
    assert.equal((await send(`${base}/hq/plan-promotions/${p.promotionId}`)).status, 503, 'an answer about another promotion is never shown');
    const input = { code: 'ANNUAL-SWITCH', ...content() }, key = U();
    reply = () => ({ operation: 'CREATE', promotion: promo(), replayed: false });
    assert.equal((await send(`${base}/hq/plan-promotions`, { method: 'POST', headers: command('hq-plan-promotion-create', key), body: JSON.stringify(input) })).status, 200);
    assert.deepEqual(calls.at(-1), ['createPlanPromotion', ['verified-human', JSON.stringify(input), key]]);
    const m = calls.length;
    assert.equal((await send(`${base}/hq/plan-promotions`, { method: 'POST', headers: command('hq-plan-promotion-update'), body: JSON.stringify(input) })).status, 403);
    assert.equal((await send(`${base}/hq/plan-promotions`, { method: 'POST', headers: command('hq-plan-promotion-create'), body: JSON.stringify({ ...input, extra: 1 }) })).status, 400);
    assert.equal(calls.length, m);
    const status = { expectedVersion: 1, status: 'ACTIVE', previewDigest: 'a'.repeat(64) };
    reply = () => ({ operation: 'STATUS', promotion: { ...p, status: 'ACTIVE', live: true, approvedDigest: 'a'.repeat(64), firstStartedAt: T2, version: 2 }, replayed: false });
    assert.equal((await send(`${base}/hq/plan-promotions/${p.promotionId}/status`, { method: 'POST', headers: command('hq-plan-promotion-status', key), body: JSON.stringify(status) })).status, 200);
    assert.deepEqual(calls.at(-1), ['setPlanPromotionStatus', ['verified-human', p.promotionId, JSON.stringify(status), key]]);
    for (const [code, message, http, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['40001', 'HQ_PLAN_PROMOTION_PREVIEW_STALE', 409, 'HQ_PLAN_PROMOTION_PREVIEW_STALE'],
      ['23514', 'HQ_PLAN_PROMOTION_NOT_DRAFT', 422, 'HQ_PLAN_PROMOTION_NOT_DRAFT'], ['23514', 'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE', 422, 'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE'],
      ['23514', 'HQ_PLAN_PROMOTION_ENDED', 422, 'HQ_PLAN_PROMOTION_ENDED'], ['23514', 'HQ_PLAN_PROMOTION_WINDOW_ENDED', 422, 'HQ_PLAN_PROMOTION_WINDOW_ENDED']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r = await send(`${base}/hq/plan-promotions/${p.promotionId}/status`, { method: 'POST', headers: command('hq-plan-promotion-status'), body: JSON.stringify(status) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [http, answer], message);
    }
    const school = U(); reply = () => schoolView(school);
    assert.equal((await send(`${base}/schools/${school}/plan-promotions`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readSchoolPlanPromotions', ['verified-human', school]]);
    reply = () => schoolView(U());
    assert.equal((await send(`${base}/schools/${school}/plan-promotions`)).status, 503, 'another school\'s answer is never shown');
    const pid = U(); reply = () => ({ promotionId: pid, kind: 'DISMISSED', recorded: true });
    const ev = await send(`${base}/schools/${school}/plan-promotions/${pid}/events`, { method: 'POST', headers: command('school-plan-promotion-event'), body: JSON.stringify({ kind: 'DISMISSED' }) });
    assert.equal(ev.status, 200, ev.body);
    assert.deepEqual(calls.at(-1), ['recordSchoolPlanPromotionEvent', ['verified-human', school, pid, JSON.stringify({ kind: 'DISMISSED' })]]);
    reply = () => ({ promotionId: pid, kind: 'SEEN', recorded: true });
    assert.equal((await send(`${base}/schools/${school}/plan-promotions/${pid}/events`, { method: 'POST', headers: command('school-plan-promotion-event'), body: JSON.stringify({ kind: 'DISMISSED' }) })).status, 503);
    assert.equal((await send(`${base}/schools/${school}/plan-promotions/${pid}/events`, { method: 'POST', headers: command('hq-plan-promotion-status'), body: JSON.stringify({ kind: 'SEEN' }) })).status, 403);
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});
