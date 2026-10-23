const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { SaasOffersHqController, SaasOffersSchoolController } = require('../dist/saas-billing/saas-offers.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// Prices here are fixture values an HQ owner might choose; nothing in the product hard-codes them.
const T = '2026-10-23T12:00:00.000Z', U = () => randomUUID(), DIGEST = 'a'.repeat(64);
const interval = kind => contracts.saasHonOsOfferBillingInterval(kind);
const recurring = o => o.billingInterval === 'MONTHLY' ? 'MONTH' : o.billingInterval === 'ONE_TIME' ? 'NONE'
  : o.annualRenewal === 'AUTO_RENEW_AT_LOCKED_PRICE' ? 'YEAR' : o.annualRenewal === 'NO_AUTO_RENEWAL' ? 'NONE' : null;
const offerInput = (code, kind, priceMinor, patch = {}) => ({ offerCode:code, offerKind:kind, displayName:`HON OS ${code}`, priceMinor,
  salesOpensAt:T, salesClosesAt:null, eligibility:'ANY_ACTIVE_ORGANIZATION', saleLimit:interval(kind) === 'ONE_TIME' ? 25 : null,
  priceLock:interval(kind) === 'ONE_TIME' ? 'NONE' : 'WHILE_CONTINUOUSLY_SUBSCRIBED', priceLockMonths:null,
  annualRenewal:interval(kind) === 'ANNUAL' ? 'AUTO_RENEW_AT_LOCKED_PRICE' : null, plannedMonthlyPremiumCredits:12000,
  aiFairUseReference:interval(kind) === 'ONE_TIME' ? 'Fixture fair-use policy' : null, refundWindowDays:30,
  cancellationTiming:interval(kind) === 'ONE_TIME' ? null : 'END_OF_PAID_PERIOD', ...patch });
const inputs = () => [offerInput('OS_MONTHLY', 'REGULAR_MONTHLY', 31700), offerInput('OS_ANNUAL', 'REGULAR_ANNUAL', 317000),
  offerInput('OS_FOUNDER_MONTHLY', 'FOUNDER_MONTHLY', 18300), offerInput('OS_FOUNDER_ANNUAL', 'FOUNDER_ANNUAL', 183000),
  offerInput('OS_LIFETIME', 'LIFETIME', 950000), offerInput('OS_FOUNDER_LIFETIME', 'FOUNDER_LIFETIME', 640000)];
const draft = (patch = {}) => ({ basedOnSetId:null, termsReference:'Fixture HON OS terms', founderTotalLimit:30, offers:inputs(), ...patch });
const offer = (input, position, patch = {}) => ({ offerId:U(), position, ...input, billingInterval:interval(input.offerKind), founder:input.offerKind.startsWith('FOUNDER_'),
  currency:'USD', premiumCreditsStatus:'PLANNING_ONLY_NOT_A_CREDIT_GRANT', salesStop:null, ...patch });
const set = (patch = {}) => ({ setId:U(), setVersion:1, productCode:'HON_OS', status:'DRAFT', revision:1, basedOnSetId:null, termsReference:'Fixture HON OS terms',
  founderTotalLimit:30, offers:inputs().map((o, i) => offer(o, i + 1)), approvedPreviewDigest:null, chargesEnabled:false, creditGrantsEnabled:false,
  createdAt:T, updatedAt:T, publishedAt:null, retiredAt:null, discardedAt:null, ...patch });
const published = (patch = {}) => set({ status:'PUBLISHED', approvedPreviewDigest:DIGEST, publishedAt:T, ...patch });
const product = () => ({ ...contracts.HON_OS_PRODUCT, capabilities:[...contracts.HON_OS_PRODUCT.capabilities] });
const preview = s => ({ setId:s.setId, revision:s.revision, previewDigest:DIGEST, ready:true, issues:[], comparisonOfferCode:'OS_MONTHLY',
  effect:'NEW_PURCHASES_ONLY', existingSubscriptionsRepriced:false, product:product(),
  quotes:s.offers.map(o => ({ offerCode:o.offerCode, offerKind:o.offerKind, billingInterval:o.billingInterval, priceMinor:o.priceMinor, currency:'USD',
    monthlyEquivalentMinor:o.billingInterval === 'ONE_TIME' ? null : o.billingInterval === 'ANNUAL' ? Math.round(o.priceMinor / 12) : o.priceMinor,
    annualSavingsVsRegularMonthlyMinor:o.billingInterval === 'ANNUAL' ? 12 * 31700 - o.priceMinor : null,
    lifetimeBreakEvenMonths:o.billingInterval === 'ONE_TIME' ? Math.ceil(o.priceMinor / 31700) : null, founderDiscountPercentVsRegular:o.founder ? 42 : null })) });
const management = (patch = {}) => { const pub = published(); return { product:product(), published:pub, onSaleOfferIds:pub.offers.map(o => o.offerId), drafts:[set({ setVersion:2 })],
  history:[{ setId:pub.setId, setVersion:1, status:'PUBLISHED', revision:1, offerCount:6, createdAt:T, publishedAt:T, retiredAt:null, discardedAt:null }],
  honOsSales:{ offers:[{ offerId:pub.offers[0].offerId, setVersion:1, offerCode:'OS_MONTHLY', offerKind:'REGULAR_MONTHLY', displayName:pub.offers[0].displayName, priceMinor:31700,
    saleLimit:null, subscriptions:2, openCheckouts:1, paidNeedsReview:1 }], founderPool:{ limit:30, allocated:4, held:1, remaining:25 } }, legacySales:[{ catalogVersion:1, planCode:'CORE', offerKind:'REGULAR_MONTHLY', priceMinor:14900, status:'IN_SERVICE', subscriptions:3 }],
  paidAccessProgram:'INACTIVE', purchase:'TEST_MODE', chargesEnabled:false, creditGrantsEnabled:false, ...patch }; };
const schoolView = (patch = {}) => ({ schoolId:U(), product:product(), offerSetVersion:1, termsReference:'Fixture HON OS terms',
  offers:published().offers.map(({ salesStop, salesOpensAt, position, saleLimit, ...o }) => ({ ...o, eligibility:o.founder ? 'FOUNDER_SOLD_OUT' : 'ELIGIBLE', recurringBilling:recurring(o) })),
  purchase:'TEST_MODE', checkout:null, purchased:null, paidAccessProgram:'INACTIVE', chargesEnabled:false, ...patch });

test('HON OS product policy is the full capability set and never a legacy tier', () => {
  assert.equal(contracts.HON_OS_PRODUCT.productCode, 'HON_OS');
  assert.equal(contracts.HON_OS_PRODUCT.entitlementTier, 'COMPLETE');
  assert.deepEqual([...contracts.HON_OS_PRODUCT.capabilities], [...contracts.SAAS_PLAN_CAPABILITIES.COMPLETE]);
  assert.equal(contracts.HON_OS_PRODUCT.legacyTiersForNewSale, false);
  assert.ok(Object.isFrozen(contracts.HON_OS_PRODUCT));
  assert.deepEqual([...contracts.SAAS_HON_OS_OFFER_KINDS], ['REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','LIFETIME','FOUNDER_LIFETIME']);
  assert.deepEqual(contracts.SAAS_HON_OS_OFFER_KINDS.map(interval), ['MONTHLY','ANNUAL','MONTHLY','ANNUAL','ONE_TIME','ONE_TIME']);
  // The legacy owner-approved Core/Complete draft stays exactly as pinned by B1-B6A evidence.
  assert.deepEqual(contracts.SAAS_OWNER_APPROVED_DRAFT.offers.map(o => o.priceMinor), [14900, 7900, 189600, 24900, 14900, 357600]);
});

test('offer-set inputs: any HQ price in range, strict keys and consistent terms', () => {
  const d = draft();
  assert.deepEqual(contracts.validateSaasHonOsOfferSetDraftInput(d), d);
  // Prices are data: any whole-cent value in range is accepted, so price changes need no code change.
  for (const price of [100, 4900, 24900, 33333, 10_000_000])
    assert.doesNotThrow(() => contracts.validateSaasHonOsOfferSetDraftInput(draft({ offers:[offerInput('OS_MONTHLY', 'REGULAR_MONTHLY', price)] })));
  const [m, a, , , l] = inputs();
  for (const bad of [draft({ offers:[] }), draft({ offers:[...inputs(), m] }), draft({ offers:Array.from({ length:13 }, (_, i) => offerInput(`OS_M${i}X`, 'REGULAR_MONTHLY', 100 + i)) }),
    draft({ offers:[{ ...m, priceMinor:99 }] }), draft({ offers:[{ ...m, priceMinor:10_000_001 }] }), draft({ offers:[{ ...m, priceMinor:149.5 }] }),
    draft({ offers:[{ ...m, priceMinor:'31700' }] }), draft({ offers:[{ ...m, offerCode:'os_monthly' }] }), draft({ offers:[{ ...m, offerKind:'CORE_MONTHLY' }] }),
    draft({ offers:[{ ...m, planCode:'CORE' }] }), draft({ offers:[{ ...m, currency:'USD' }] }), draft({ offers:[{ ...m, annualRenewal:'NO_AUTO_RENEWAL' }] }),
    draft({ offers:[{ ...a, annualRenewal:null }] }), draft({ offers:[{ ...l, priceLock:'WHILE_CONTINUOUSLY_SUBSCRIBED' }] }),
    draft({ offers:[{ ...l, cancellationTiming:'END_OF_PAID_PERIOD' }] }), draft({ offers:[{ ...m, priceLock:'FIXED_MONTHS' }] }),
    draft({ offers:[{ ...m, priceLockMonths:12 }] }), draft({ offers:[{ ...m, salesOpensAt:T, salesClosesAt:T }] }),
    draft({ offers:[{ ...m, salesOpensAt:'2026-10-23T12:00:00Z' }] }), draft({ offers:[{ ...m, refundWindowDays:366 }] }),
    draft({ offers:[{ ...m, displayName:' padded' }] }), draft({ founderTotalLimit:1001 }), draft({ basedOnSetId:'x' }), draft({ chargesEnabled:false }),
    { ...draft(), basedOnSetId:undefined }])
    assert.throws(() => contracts.validateSaasHonOsOfferSetDraftInput(bad));
  assert.doesNotThrow(() => contracts.validateSaasHonOsOfferSetDraftInput(draft({ offers:[{ ...m, priceLock:'FIXED_MONTHS', priceLockMonths:24 }] })));
  const { basedOnSetId, ...content } = draft();
  assert.equal(contracts.validateSaasHonOsOfferSetReviseInput({ expectedRevision:2, ...content }).expectedRevision, 2);
  assert.throws(() => contracts.validateSaasHonOsOfferSetReviseInput({ expectedRevision:0, ...content }));
  assert.throws(() => contracts.validateSaasHonOsOfferSetReviseInput(draft()));
  assert.deepEqual(contracts.validateSaasHonOsOfferSetDiscardInput({ expectedRevision:1 }), { expectedRevision:1 });
  const publish = { expectedRevision:3, previewDigest:DIGEST, approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL };
  assert.deepEqual(contracts.validateSaasHonOsOfferSetPublishInput(publish), publish);
  for (const bad of [{ ...publish, approval:'APPROVE' }, { ...publish, previewDigest:'A'.repeat(64) }, { ...publish, previewDigest:'a'.repeat(63) }, { ...publish, force:true }, { previewDigest:DIGEST, approval:publish.approval }])
    assert.throws(() => contracts.validateSaasHonOsOfferSetPublishInput(bad));
  assert.deepEqual(contracts.validateSaasHonOsOfferStopSalesInput({ reasonCode:'TERMS_REVIEW' }), { reasonCode:'TERMS_REVIEW' });
  for (const bad of [{ reasonCode:'REPRICE' }, { reasonCode:'OWNER_DISABLED', newPrice:100 }, {}])
    assert.throws(() => contracts.validateSaasHonOsOfferStopSalesInput(bad));
});

test('responses fail closed on activation flags, repricing claims, credit grants or term drift', () => {
  const s = set();
  assert.doesNotThrow(() => contracts.validateSaasHonOsOfferSetDetail({ set:s, preview:preview(s) }));
  assert.doesNotThrow(() => contracts.validateSaasHonOsOfferManagementView(management()));
  assert.doesNotThrow(() => contracts.validateSaasHonOsSchoolOfferView(schoolView()));
  const stopped = published(); stopped.offers[1].salesStop = { reasonCode:'PRICE_CHANGE_PENDING', stoppedAt:T };
  assert.doesNotThrow(() => contracts.validateSaasHonOsOfferStopSalesReceipt({ offer:stopped.offers[1], replayed:false }));
  const retired = { ...stopped, status:'RETIRED', retiredAt:T };
  assert.doesNotThrow(() => contracts.validateSaasHonOsOfferSetDetail({ set:retired, preview:preview(retired) }), 'a retired set keeps its stop history');
  const withOffer = (patch, i = 0) => { const x = set(); x.offers[i] = { ...x.offers[i], ...patch }; return x; };
  for (const bad of [set({ chargesEnabled:true }), set({ creditGrantsEnabled:true }), set({ productCode:'HON_COMPLETE' }), set({ status:'PUBLISHED' }),
    set({ approvedPreviewDigest:DIGEST }), withOffer({ premiumCreditsStatus:'GRANTED' }), withOffer({ billingInterval:'ANNUAL' }), withOffer({ founder:true }),
    withOffer({ currency:'EUR' }), withOffer({ planCode:'CORE' }), withOffer({ position:2 }), withOffer({ salesStop:{ reasonCode:'OWNER_DISABLED', stoppedAt:T } }),
    withOffer({ priceLock:'WHILE_CONTINUOUSLY_SUBSCRIBED' }, 4), { ...set(), balance:1 }])
    assert.throws(() => contracts.validateSaasHonOsOfferSetDetail({ set:bad, preview:preview(bad) }));
  for (const bad of [{ ...preview(s), existingSubscriptionsRepriced:true }, { ...preview(s), effect:'ALL_SUBSCRIPTIONS' }, { ...preview(s), ready:false },
    { ...preview(s), revision:2 }, { ...preview(s), quotes:preview(s).quotes.slice(1) }, { ...preview(s), product:{ ...product(), entitlementTier:'CORE' } },
    { ...preview(s), product:{ ...product(), capabilities:[...contracts.SAAS_PLAN_CAPABILITIES.CORE] } }, { ...preview(s), product:{ ...product(), legacyTiersForNewSale:true } },
    { ...preview(s), quotes:preview(s).quotes.map((q, i) => i === 0 ? { ...q, priceMinor:1 } : q) }, { ...preview(s), comparisonOfferCode:'OS_UNKNOWN' }])
    assert.throws(() => contracts.validateSaasHonOsOfferSetDetail({ set:s, preview:bad }));
  const m = management(), row = m.honOsSales.offers[0];
  assert.doesNotThrow(() => contracts.validateSaasHonOsOfferManagementView(management({ purchase:'UNAVAILABLE', honOsSales:{ offers:[], founderPool:{ limit:null, allocated:0, held:0, remaining:null } } })));
  assert.doesNotThrow(() => contracts.validateSaasHonOsOfferManagementView(management({ honOsSales:{ offers:[], founderPool:{ limit:0, allocated:0, held:0, remaining:0 } } })));
  for (const bad of [management({ chargesEnabled:true }), management({ creditGrantsEnabled:true }), management({ purchase:'CONNECTED' }), management({ honOsSales:{ status:'LIVE', sold:4 } }),
    management({ honOsSales:{ ...m.honOsSales, founderPool:{ limit:30, allocated:4, held:1, remaining:30 } } }), management({ honOsSales:{ ...m.honOsSales, founderPool:{ limit:null, allocated:0, held:0, remaining:5 } } }),
    management({ honOsSales:{ ...m.honOsSales, offers:[{ ...row, revenueMinor:63400 }] } }), management({ honOsSales:{ ...m.honOsSales, offers:[{ ...row, subscriptions:-1 }] } }),
    management({ published:set() }), management({ drafts:[published()] }), management({ onSaleOfferIds:[U()] }), management({ paidAccessProgram:'ON' }),
    management({ legacySales:[{ catalogVersion:1, planCode:'ESSENTIAL', offerKind:'REGULAR_MONTHLY', priceMinor:9900, status:'IN_SERVICE', subscriptions:1 }] })])
    assert.throws(() => contracts.validateSaasHonOsOfferManagementView(bad));
  const sv = schoolView();
  for (const bad of [schoolView({ chargesEnabled:true }), schoolView({ purchase:'CONNECTED' }), schoolView({ offerSetVersion:null }),
    schoolView({ offers:sv.offers.map((o, i) => i === 0 ? { ...o, eligibility:'REQUIRES_HQ_FOUNDER_RESERVATION' } : o) }),
    schoolView({ offers:sv.offers.map((o, i) => i === 0 ? { ...o, saleLimit:null } : o) }), schoolView({ offers:sv.offers.map((o, i) => i === 0 ? { ...o, salesStop:null } : o) }),
    schoolView({ offers:sv.offers.map((o, i) => i === 0 ? { ...o, recurringBilling:'YEAR' } : o) }), schoolView({ offers:sv.offers.map((o, i) => i === 0 ? { ...o, eligibility:'FOUNDER_SOLD_OUT' } : o) }),
    schoolView({ offers:sv.offers.map((o, i) => i === 0 ? { ...o, eligibility:'NOT_AVAILABLE_TERMS' } : o) }), schoolView({ offers:sv.offers.map((o, i) => i === 1 ? { ...o, annualRenewal:'AUTO_RENEW_AT_CURRENT_PRICE' } : o) }),
    schoolView({ purchased:{ subscriptionId:U(), offerId:U(), offerKind:'LIFETIME', displayName:'Lifetime', priceMinor:950000, recurringBilling:'NONE', offerSetVersion:1,
      acceptedOfferDigest:DIGEST, status:'IN_SERVICE', serviceStartedAt:null } }), schoolView({ checkout:{} })])
    assert.throws(() => contracts.validateSaasHonOsSchoolOfferView(bad));
  assert.throws(() => contracts.validateSaasHonOsOfferSetPublishReceipt({ set:set(), retiredSetId:null, replayed:false }));
  assert.throws(() => contracts.validateSaasHonOsOfferSetDiscardReceipt({ set:set(), replayed:false }));
  assert.throws(() => contracts.validateSaasHonOsOfferSetReceipt({ set:published(), preview:preview(published()), replayed:false }));
});

async function boot(respond) {
  const calls = [];
  const module = await Test.createTestingModule({ controllers:[SaasOffersHqController, SaasOffersSchoolController], providers:[SaasBillingService, SaasCommandGuard, SaasReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callSaasBilling:async (operation, params) => { calls.push([operation, params]); return respond(operation, params); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, calls, base:`http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}
// node:http (not fetch): fetch forces its own sec-fetch-* headers.
const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type':'application/json', origin:'https://hon.example', 'x-hon-human-command':command, 'sec-fetch-site':'same-origin',
  'sec-fetch-mode':'same-origin', 'sec-fetch-dest':'empty', 'idempotency-key':randomUUID() });

test('HTTP routes: subject-only reads, exact human commands, server-owned parameters, no purchase routes', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const draftSet = set(), pub = published(), stopped = published(); stopped.offers[0].salesStop = { reasonCode:'OWNER_DISABLED', stoppedAt:T };
  const { app, calls, base } = await boot(operation => ({
    readOfferManagement:management(), readOfferSet:{ set:draftSet, preview:preview(draftSet) }, createOfferSetDraft:{ set:draftSet, preview:preview(draftSet), replayed:false },
    reviseOfferSetDraft:{ set:{ ...draftSet, revision:2 }, preview:preview({ ...draftSet, revision:2 }), replayed:false },
    discardOfferSetDraft:{ set:{ ...draftSet, status:'DISCARDED', discardedAt:T }, replayed:false }, publishOfferSet:{ set:pub, retiredSetId:null, replayed:false },
    stopOfferSales:{ offer:stopped.offers[0], replayed:false }, readSchoolHonOsOffers:schoolView() })[operation]);
  const hq = `${base}/hq/saas/offers`;
  try {
    const read = await send(hq); assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readOfferManagement', ['verified-human']]);
    assert.equal((await send(`${hq}?organizationId=x`)).status, 400);
    const id = randomUUID();
    assert.equal((await send(`${hq}/sets/${id}`)).status, 200); assert.deepEqual(calls.at(-1), ['readOfferSet', ['verified-human', id]]);
    assert.equal((await send(`${hq}/sets/not-a-uuid`)).status, 400);
    const school = randomUUID();
    assert.equal((await send(`${base}/schools/${school}/hon-os-offers`)).status, 200); assert.deepEqual(calls.at(-1), ['readSchoolHonOsOffers', ['verified-human', school]]);
    assert.equal((await send(`${base}/schools/${school}/hon-os-offers?price=1`)).status, 400);

    const commandCases = [
      ['sets', 'saas-offer-set-draft', draft(), 'createOfferSetDraft', null],
      [`sets/${id}/revise`, 'saas-offer-set-revise', (({ basedOnSetId, ...c }) => ({ expectedRevision:1, ...c }))(draft()), 'reviseOfferSetDraft', id],
      [`sets/${id}/discard`, 'saas-offer-set-discard', { expectedRevision:1 }, 'discardOfferSetDraft', id],
      [`sets/${id}/publish`, 'saas-offer-set-publish', { expectedRevision:1, previewDigest:DIGEST, approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL }, 'publishOfferSet', id],
      [`${id}/stop-sales`, 'saas-offer-sales-stop', { reasonCode:'OWNER_DISABLED' }, 'stopOfferSales', id]];
    for (const [path, command, body, operation, target] of commandCases) {
      const headers = human(command);
      const res = await send(`${hq}/${path}`, { method:'POST', headers, body:JSON.stringify(body) });
      assert.equal(res.status, 200, `${path}: ${res.body}`);
      const [op, params] = calls.at(-1);
      assert.equal(op, operation); assert.equal(params[0], 'verified-human');
      const rest = target ? (assert.equal(params[1], target), params.slice(2)) : params.slice(1);
      assert.deepEqual(JSON.parse(rest[0]), body); assert.equal(rest[1], headers['idempotency-key']);
      assert.equal(rest.length, 4, 'subject, [target], body, key, request id, correlation id');
      const n = calls.length;
      for (const extra of [{ 'x-hon-human-command':'saas-catalog-publish' }, { origin:'https://attacker.example' }, { 'sec-fetch-site':'cross-site' },
        { 'x-hon-organization-id':randomUUID() }, { 'content-type':'text/plain' }])
        assert.equal((await send(`${hq}/${path}`, { method:'POST', headers:{ ...human(command), ...extra }, body:JSON.stringify(body) })).status, 403, `${path} ${JSON.stringify(extra)}`);
      const { 'idempotency-key':_, ...keyless } = human(command);
      assert.equal((await send(`${hq}/${path}`, { method:'POST', headers:keyless, body:JSON.stringify(body) })).status, 400, `${path} without key`);
      assert.equal((await send(`${hq}/${path}`, { method:'POST', headers:human(command), body:JSON.stringify({ ...body, priceOverride:1 }) })).status, 400, `${path} extra key`);
      assert.equal((await send(`${hq}/${path}?x=1`, { method:'POST', headers:human(command), body:JSON.stringify(body) })).status, 400, `${path} query`);
      assert.equal(calls.length, n, `${path}: refused requests never reach the database`);
    }
    const before = calls.length;
    for (const path of ['sets/x/activate', `${id}/checkout`, `${id}/reprice`, 'subscriptions/reprice', `sets/${id}/charge`])
      assert.equal((await send(`${hq}/${path}`, { method:'POST', headers:human('saas-offer-set-publish'), body:'{}' })).status, 404, path);
    assert.equal((await send(`${base}/schools/${school}/hon-os-offers`, { method:'POST', headers:human('saas-checkout-start'), body:'{}' })).status, 404);
    assert.equal(calls.length, before);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('database refusals map to stable codes; response drift never leaks', async () => {
  const s = set();
  const cases = [[{ code:'42501', message:'SAAS_FORBIDDEN' }, 403, 'SAAS_FORBIDDEN'], [{ code:'P0002', message:'SAAS_UNAVAILABLE' }, 404, 'SAAS_UNAVAILABLE'],
    [{ code:'40001', message:'SAAS_OFFER_SET_NOT_DRAFT' }, 409, 'SAAS_OFFER_SET_NOT_DRAFT'], [{ code:'40001', message:'SAAS_VERSION_CONFLICT' }, 409, 'SAAS_VERSION_CONFLICT'],
    [{ code:'23514', message:'SAAS_OFFER_PREVIEW_CHANGED' }, 422, 'SAAS_OFFER_PREVIEW_CHANGED'], [{ code:'23514', message:'SAAS_OFFER_SET_NOT_READY' }, 422, 'SAAS_OFFER_SET_NOT_READY'],
    [{ code:'23514', message:'SAAS_OFFER_NOT_PUBLISHED' }, 422, 'SAAS_OFFER_NOT_PUBLISHED'], [{ code:'23514', message:'SAAS_OFFER_SALES_ALREADY_STOPPED' }, 422, 'SAAS_OFFER_SALES_ALREADY_STOPPED'],
    [{ code:'23514', message:'saas_offer_set_offers_check' }, 400, 'INVALID_SAAS_INPUT'], [{ code:'22023', message:'INVALID_SAAS_INPUT' }, 400, 'INVALID_SAAS_INPUT'],
    [{ code:'23505', message:'SAAS_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'], [{ code:'XX000', message:'private detail' }, 503, 'SAAS_UNAVAILABLE']];
  for (const [error, status, code] of cases) {
    const service = new SaasBillingService({ callSaasBilling:async () => { throw error; } });
    await assert.rejects(service.publishOfferSet('verified-human', s.setId, { expectedRevision:1, previewDigest:DIGEST, approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL }, U()),
      e => { assert.equal(e.getStatus(), status); assert.deepEqual(e.getResponse(), { code }); return true; });
  }
  const drifted = new SaasBillingService({ callSaasBilling:async () => ({ ...management(), chargesEnabled:true }) });
  await assert.rejects(drifted.readOfferManagement('verified-human'), e => e.getStatus() === 503 && e.getResponse().code === 'SAAS_UNAVAILABLE');
  const repriced = new SaasBillingService({ callSaasBilling:async () => ({ set:s, preview:{ ...preview(s), existingSubscriptionsRepriced:true } }) });
  await assert.rejects(repriced.readOfferSet('verified-human', s.setId), e => e.getStatus() === 503);
  const neverCalled = new SaasBillingService({ callSaasBilling:async () => { throw new Error('must not be called'); } });
  await assert.rejects(neverCalled.createOfferSetDraft('verified-human', { ...draft(), offers:[] }, U()), e => e.getStatus() === 400);
  await assert.rejects(neverCalled.stopOfferSales('verified-human', 'x', { reasonCode:'OWNER_DISABLED' }, U()), e => e.getStatus() === 400);
  await assert.rejects(neverCalled.readSchoolHonOsOffers('verified-human', 'x'), e => e.getStatus() === 400);
});
